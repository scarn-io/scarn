import { beforeAll, describe, expect } from "bun:test";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { EnvironmentRef } from "@scarn/core/common/contracts/environment";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { secrets } from "@/lib/db/schema";
import type { TimeProvider } from "@/lib/time-provider";
import { serialTest, unwrapAsync, unwrapStartedTaskAsync } from "tests/utils";
import { seedWorkItem } from "tests/lib/db/seed-task-prerequisites";
import { createSecretsTestClient } from "tests/secrets/secret/integration/secret-test-support";
import {
  addProjectMember,
  createProjectSecretsTestProject,
  createProjectSecretsTestUser,
  projectSecretValue,
  type ProjectSecretsTestUser,
} from "tests/secrets/secret/integration/project-secret-test-support";
import { buildStepDefinitionPayload } from "./task-run-test-support";

describe("task run environment secrets", () => {
  let currentTime = new Date("2026-05-01T12:00:00.000Z");
  const timeProvider: TimeProvider = {
    now: () => currentTime,
    nowIso: () => currentTime.toISOString(),
  };
  const apiClient = createSecretsTestClient(timeProvider);
  let owner: ProjectSecretsTestUser;
  let reviewer: ProjectSecretsTestUser;

  const environmentOf = (taskRunId: UuidV7) =>
    apiClient.api["task-runs"]({ taskRunId }).environment;

  const saveSecret = async (projectId: UuidV7, name: string) => {
    const value = projectSecretValue();
    const secret = await unwrapAsync(
      apiClient.api
        .projects({ projectId })
        .secrets.post({ name, value }, { headers: owner.authHeaders }),
    );
    return { id: parseUuidV7(secret.id), value };
  };

  const secretVar = (name: string, secretName: string) => ({
    name,
    source: "secret" as const,
    secretName,
    applies: "agent" as const,
  });

  const inlineEnvironment: EnvironmentRef = {
    kind: "inline",
    envJson: [
      secretVar("API_TOKEN", "API_KEY"),
      secretVar("NOT_SAVED", "NOT_SAVED"),
      secretVar("SHARED_NAME", "SHARED_NAME"),
    ],
  };

  const startTask = async (
    projectId: UuidV7,
    environment: EnvironmentRef = inlineEnvironment,
  ) => {
    const stepDefinition = await unwrapAsync(
      apiClient.api["step-definitions"].post(
        {
          ...buildStepDefinitionPayload(
            projectId,
            `env_step_${crypto.randomUUID()}`,
          ),
          environment,
        },
        { headers: owner.authHeaders },
      ),
    );
    const { run } = await unwrapStartedTaskAsync(
      apiClient.api.tasks.post(
        {
          projectId,
          workItemId: await seedWorkItem(projectId),
          stepDefinitionId: stepDefinition.id,
          stepDefinitionVersion: 1,
          inputJson: {},
          executionTimeoutSeconds: 600,
        },
        { headers: owner.authHeaders },
      ),
    );
    return parseUuidV7(run.id);
  };

  const claimTask = async (projectId: UuidV7) => {
    const claims = await unwrapAsync(
      apiClient.api["task-runs"].claims.post(
        {
          projectId,
          workerId: "env-worker",
          batchSize: 1,
          leaseDurationSeconds: 30,
        },
        { headers: owner.authHeaders },
      ),
    );
    const claim = claims[0];
    if (!claim) {
      throw new Error("Expected a claim");
    }
    return {
      taskRunId: parseUuidV7(claim.task.id),
      claimToken: claim.claimToken,
    };
  };

  const newProjectWithClaimedTask = async () => {
    const projectId = await createProjectSecretsTestProject(apiClient, owner);
    await startTask(projectId);
    return { projectId, ...(await claimTask(projectId)) };
  };

  const claimedTaskUsing = async (
    projectId: UuidV7,
    environment: EnvironmentRef,
  ) => {
    await startTask(projectId, environment);
    return await claimTask(projectId);
  };

  const publishEnvironment = async (
    projectId: UuidV7,
    name: string,
    vars: ReturnType<typeof secretVar>[],
  ) =>
    await unwrapAsync(
      apiClient.api
        .projects({ projectId })
        .environments({ name })
        .put(
          { content: { runtime: { kind: "devcontainer" }, vars } },
          { headers: owner.authHeaders },
        ),
    );

  const buildWorkerContext = async (taskRunId: UuidV7, claimToken: string) =>
    await unwrapAsync(
      apiClient.api["task-runs"]({ taskRunId })["worker-context"].post(
        { claimToken },
        { headers: owner.authHeaders },
      ),
    );

  const lastUsedAtOf = async (secretId: UuidV7) => {
    const [row] = await getDb()
      .select({ lastUsedAt: secrets.lastUsedAt })
      .from(secrets)
      .where(eq(secrets.id, secretId));
    return row?.lastUsedAt ?? null;
  };

  beforeAll(async () => {
    owner = await createProjectSecretsTestUser("env-owner");
    reviewer = await createProjectSecretsTestUser("env-reviewer");
  });

  serialTest(
    "returns the saved values, lists missing names, and marks returned secrets used",
    async () => {
      currentTime = new Date("2026-05-01T12:00:00.000Z");
      const { projectId, taskRunId, claimToken } =
        await newProjectWithClaimedTask();
      const apiKey = await saveSecret(projectId, "API_KEY");
      const unrequested = await saveSecret(projectId, "UNREQUESTED");

      currentTime = new Date("2026-05-01T12:00:05.000Z");
      const environment = await unwrapAsync(
        environmentOf(taskRunId).post(
          { claimToken, secretNames: ["NOT_SAVED", "API_KEY"] },
          { headers: owner.authHeaders },
        ),
      );

      expect(environment).toEqual({
        secrets: { API_KEY: { value: apiKey.value, expiresAt: null } },
        missing: ["NOT_SAVED"],
      });
      expect((await lastUsedAtOf(apiKey.id))?.toISOString()).toBe(
        "2026-05-01T12:00:05.000Z",
      );
      expect(await lastUsedAtOf(unrequested.id)).toBeNull();
    },
  );

  serialTest(
    "never returns a same-named secret from another project",
    async () => {
      currentTime = new Date("2026-05-01T13:00:00.000Z");
      const { taskRunId, claimToken } = await newProjectWithClaimedTask();
      const otherProjectId = await createProjectSecretsTestProject(
        apiClient,
        owner,
      );
      const otherSecret = await saveSecret(otherProjectId, "SHARED_NAME");

      const environment = await unwrapAsync(
        environmentOf(taskRunId).post(
          { claimToken, secretNames: ["SHARED_NAME"] },
          { headers: owner.authHeaders },
        ),
      );

      expect(environment).toEqual({ secrets: {}, missing: ["SHARED_NAME"] });
      expect(await lastUsedAtOf(otherSecret.id)).toBeNull();
    },
  );

  serialTest("rejects a wrong claim token", async () => {
    currentTime = new Date("2026-05-01T14:00:00.000Z");
    const { projectId, taskRunId } = await newProjectWithClaimedTask();
    const secret = await saveSecret(projectId, "API_KEY");

    const { data, error } = await environmentOf(taskRunId).post(
      { claimToken: "not-the-claim-token", secretNames: ["API_KEY"] },
      { headers: owner.authHeaders },
    );

    expect(data).toBeNull();
    expect(error?.status).toBe(409);
    expect(error?.value).toMatchObject({ code: "TASK_OWNERSHIP_CONFLICT" });
    expect(await lastUsedAtOf(secret.id)).toBeNull();
  });

  serialTest("rejects a task run that isn't claimed", async () => {
    currentTime = new Date("2026-05-01T15:00:00.000Z");
    const projectId = await createProjectSecretsTestProject(apiClient, owner);
    const taskRunId = await startTask(projectId);
    await saveSecret(projectId, "API_KEY");

    const { error } = await environmentOf(taskRunId).post(
      { claimToken: "any-token", secretNames: ["API_KEY"] },
      { headers: owner.authHeaders },
    );

    expect(error?.status).toBe(409);
    expect(error?.value).toMatchObject({ code: "TASK_OWNERSHIP_CONFLICT" });
  });

  serialTest("rejects a claim whose lease has expired", async () => {
    currentTime = new Date("2026-05-01T16:00:00.000Z");
    const { projectId, taskRunId, claimToken } =
      await newProjectWithClaimedTask();
    const secret = await saveSecret(projectId, "API_KEY");

    currentTime = new Date("2026-05-01T16:01:00.000Z");
    const { error } = await environmentOf(taskRunId).post(
      { claimToken, secretNames: ["API_KEY"] },
      { headers: owner.authHeaders },
    );

    expect(error?.status).toBe(409);
    expect(error?.value).toMatchObject({ code: "TASK_OWNERSHIP_CONFLICT" });
    expect(await lastUsedAtOf(secret.id)).toBeNull();
  });

  serialTest("requires executions:write on the project", async () => {
    currentTime = new Date("2026-05-01T17:00:00.000Z");
    const { projectId, taskRunId, claimToken } =
      await newProjectWithClaimedTask();
    await addProjectMember(apiClient, projectId, owner, reviewer, "read");
    const secret = await saveSecret(projectId, "API_KEY");

    const { data, error } = await environmentOf(taskRunId).post(
      { claimToken, secretNames: ["API_KEY"] },
      { headers: reviewer.authHeaders },
    );

    expect(data).toBeNull();
    expect(error?.status).toBe(403);
    expect(await lastUsedAtOf(secret.id)).toBeNull();
  });

  serialTest("validates the requested secret names", async () => {
    currentTime = new Date("2026-05-01T18:00:00.000Z");
    const { taskRunId, claimToken } = await newProjectWithClaimedTask();

    const tooMany = Array.from({ length: 101 }, (_, i) => `NAME_${String(i)}`);
    for (const secretNames of [
      [],
      ["API_KEY", "API_KEY"],
      ["lower_case"],
      ["1STARTS_WITH_DIGIT"],
      ["SCARN_RESERVED"],
      tooMany,
    ]) {
      const { error } = await environmentOf(taskRunId).post(
        { claimToken, secretNames },
        { headers: owner.authHeaders },
      );
      expect(error?.status).toBe(422);
    }
  });

  describe("only secrets the run's environment references", () => {
    serialTest(
      "returns a secret referenced by the inline environment",
      async () => {
        currentTime = new Date("2026-05-02T12:00:00.000Z");
        const projectId = await createProjectSecretsTestProject(
          apiClient,
          owner,
        );
        const secret = await saveSecret(projectId, "DEPLOY_KEY");
        const { taskRunId, claimToken } = await claimedTaskUsing(projectId, {
          kind: "inline",
          envJson: [secretVar("DEPLOY_TOKEN", "DEPLOY_KEY")],
        });

        const environment = await unwrapAsync(
          environmentOf(taskRunId).post(
            { claimToken, secretNames: ["DEPLOY_KEY"] },
            { headers: owner.authHeaders },
          ),
        );

        expect(environment).toEqual({
          secrets: { DEPLOY_KEY: { value: secret.value, expiresAt: null } },
          missing: [],
        });
      },
    );

    serialTest(
      "returns a secret referenced by the pinned named environment version",
      async () => {
        currentTime = new Date("2026-05-02T13:00:00.000Z");
        const projectId = await createProjectSecretsTestProject(
          apiClient,
          owner,
        );
        const secret = await saveSecret(projectId, "NPM_TOKEN");
        await publishEnvironment(projectId, "frontend", [
          secretVar("NPM_AUTH", "NPM_TOKEN"),
        ]);
        const { taskRunId, claimToken } = await claimedTaskUsing(projectId, {
          kind: "named",
          name: "frontend",
        });
        await buildWorkerContext(taskRunId, claimToken);

        const environment = await unwrapAsync(
          environmentOf(taskRunId).post(
            { claimToken, secretNames: ["NPM_TOKEN"] },
            { headers: owner.authHeaders },
          ),
        );

        expect(environment).toEqual({
          secrets: { NPM_TOKEN: { value: secret.value, expiresAt: null } },
          missing: [],
        });
      },
    );

    serialTest(
      "rejects a name the environment doesn't reference with 403, listing it",
      async () => {
        currentTime = new Date("2026-05-02T14:00:00.000Z");
        const projectId = await createProjectSecretsTestProject(
          apiClient,
          owner,
        );
        const referenced = await saveSecret(projectId, "NPM_TOKEN");
        const unreferenced = await saveSecret(projectId, "PROD_DB_PASSWORD");
        await publishEnvironment(projectId, "frontend", [
          secretVar("NPM_AUTH", "NPM_TOKEN"),
        ]);
        const { taskRunId, claimToken } = await claimedTaskUsing(projectId, {
          kind: "named",
          name: "frontend",
        });
        await buildWorkerContext(taskRunId, claimToken);

        const { data, error } = await environmentOf(taskRunId).post(
          { claimToken, secretNames: ["NPM_TOKEN", "PROD_DB_PASSWORD"] },
          { headers: owner.authHeaders },
        );

        expect(data).toBeNull();
        expect(error?.status).toBe(403);
        expect(error?.value).toMatchObject({
          code: "SECRET_NOT_REFERENCED",
          detail:
            "Secrets not referenced by this task run's environment: PROD_DB_PASSWORD. It may request: NPM_TOKEN.",
        });
        expect(await lastUsedAtOf(referenced.id)).toBeNull();
        expect(await lastUsedAtOf(unreferenced.id)).toBeNull();
      },
    );

    serialTest(
      "rejects every name when the run uses the repo default environment",
      async () => {
        currentTime = new Date("2026-05-02T15:00:00.000Z");
        const projectId = await createProjectSecretsTestProject(
          apiClient,
          owner,
        );
        await saveSecret(projectId, "API_KEY");
        const { taskRunId, claimToken } = await claimedTaskUsing(
          projectId,
          null,
        );

        const { error } = await environmentOf(taskRunId).post(
          { claimToken, secretNames: ["API_KEY"] },
          { headers: owner.authHeaders },
        );

        expect(error?.status).toBe(403);
        expect(error?.value).toMatchObject({
          code: "SECRET_NOT_REFERENCED",
          detail:
            "Secrets not referenced by this task run's environment: API_KEY. It may request: none.",
        });
      },
    );
  });
});
