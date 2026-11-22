/**
 * Re-pushing a step definition through the real PUT endpoint points it at a
 * task execution config row: identical inline config reuses the row, changed
 * config points at another row, and an all-default config stores no row
 * (D3, D7). The reference is read straight from the database because it is
 * not on the wire (D16).
 */
import { beforeAll, describe, expect } from "bun:test";
import { createApp } from "@scarn/api/app";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { eq } from "drizzle-orm";
import { createScarnApiClient } from "tests/treaty";
import { createAppContext } from "@/lib/di";
import { getDb } from "@/lib/db";
import { stepDefinitions } from "@/lib/db/schema";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";

describe("step definition put endpoint: task execution configs", () => {
  let apiClient: ReturnType<typeof createScarnApiClient>;
  let project: ProjectContract | undefined;
  let authHeaders: { authorization: string } | undefined;

  beforeAll(async () => {
    const app = createApp(
      createAppContext({
        timeProvider: fixedTimeProvider(new Date("2026-10-13T12:00:00.000Z")),
      }),
    );
    apiClient = createScarnApiClient(app);
    const owner = await createTestUserAndSession({
      email: `step-definition-config-${crypto.randomUUID()}@example.com`,
    });
    authHeaders = owner.authHeaders;
    project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Step Definition Config Project",
          description: "Project for task execution config tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
  });

  const buildPayload = (projectId: UuidV7) => ({
    projectId,
    key: `config_ref_${crypto.randomUUID()}`,
    name: "Config reference",
    description: null,
    prompt: "Return a typed result.",
    version: 1,
    kind: "user_defined" as const,
    environment: null,
    inputSchemaJson: { type: "object" },
    resultSchemaJson: { type: "object" },
    opencodeMcpJson: {
      github: {
        type: "remote" as const,
        url: `https://example.com/mcp/${crypto.randomUUID()}`,
      },
    },
    healthChecksJson: [
      {
        kind: "tool" as const,
        tool: "list_issues",
        mcp: "github",
        severity: "required" as const,
        timeoutSeconds: 15,
      },
    ],
    repo: { mode: "readOnly" as const },
    status: "draft" as const,
  });

  const configIdOf = async (stepDefinitionId: UuidV7) => {
    const [row] = await getDb()
      .select({ taskExecutionConfigId: stepDefinitions.taskExecutionConfigId })
      .from(stepDefinitions)
      .where(eq(stepDefinitions.id, stepDefinitionId));
    return row?.taskExecutionConfigId;
  };

  const requireSetup = () => {
    if (!project || !authHeaders) {
      throw new Error("Expected project auth setup to complete");
    }
    return { projectId: parseUuidV7(project.id), headers: { ...authHeaders } };
  };

  concurrentTest(
    "MCP worker variables survive typed API writes and config reads",
    async () => {
      const { projectId, headers } = requireSetup();
      const workerVars = [
        {
          source: "inherit" as const,
          name: "API_TOKEN",
          from: "HOST_API_TOKEN",
          optional: false,
          secret: true,
          applies: "agent" as const,
        },
      ];
      const payload = {
        ...buildPayload(projectId),
        opencodeMcpJson: {
          github: {
            type: "remote" as const,
            url: "https://example.com/mcp",
            workerVars,
          },
        },
      };
      const created = await unwrapAsync(
        apiClient.api["step-definitions"].put(payload, { headers }),
      );
      expect(created.environment).toBeNull();
      expect(created.opencodeMcpJson?.["github"]?.workerVars).toEqual(
        workerVars,
      );
      const read = await unwrapAsync(
        apiClient.api["step-definitions"]({ stepDefinitionId: created.id }).get(
          { headers },
        ),
      );
      expect(read.opencodeMcpJson?.["github"]?.workerVars).toEqual(workerVars);
      expect(await configIdOf(created.id)).toBeTruthy();
    },
  );

  concurrentTest(
    "re-pushing identical config reuses the config row",
    async () => {
      const { projectId, headers } = requireSetup();
      const payload = buildPayload(projectId);
      const put = () =>
        unwrapAsync(
          apiClient.api["step-definitions"].put(payload, { headers }),
        );

      const created = await put();
      const first = await configIdOf(created.id);
      const repushed = await put();
      const second = await configIdOf(created.id);

      expect(repushed.id).toBe(created.id);
      expect(first).toBeTruthy();
      expect(second).toBe(first);
    },
  );

  concurrentTest("two steps with the same config share one row", async () => {
    const { projectId, headers } = requireSetup();
    const payload = buildPayload(projectId);

    const a = await unwrapAsync(
      apiClient.api["step-definitions"].put(payload, { headers }),
    );
    const b = await unwrapAsync(
      apiClient.api["step-definitions"].put(
        { ...payload, key: `config_ref_${crypto.randomUUID()}` },
        { headers },
      ),
    );

    expect(await configIdOf(a.id)).toBe(await configIdOf(b.id));
  });

  concurrentTest("re-pushing changed config points at a new row", async () => {
    const { projectId, headers } = requireSetup();
    const payload = buildPayload(projectId);

    const created = await unwrapAsync(
      apiClient.api["step-definitions"].put(payload, { headers }),
    );
    const first = await configIdOf(created.id);
    const changed = await unwrapAsync(
      apiClient.api["step-definitions"].put(
        {
          ...payload,
          repo: {
            mode: "readWrite" as const,
            message: "fix: {{result.summary}}",
          },
        },
        { headers },
      ),
    );
    const second = await configIdOf(created.id);

    expect(changed.repo).toEqual({
      mode: "readWrite",
      message: "fix: {{result.summary}}",
      onPushFailure: "fail",
      gitCredentials: "auto",
      baseBranch: null,
      workBranch: { kind: "create" },
    });
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });

  concurrentTest("an all-default config stores a null reference", async () => {
    const { projectId, headers } = requireSetup();
    const created = await unwrapAsync(
      apiClient.api["step-definitions"].put(
        {
          ...buildPayload(projectId),
          opencodeMcpJson: null,
          healthChecksJson: null,
          repo: { mode: "readWrite" as const },
        },
        { headers },
      ),
    );

    expect(await configIdOf(created.id)).toBeNull();
    expect(created.environment).toBeNull();
    expect(created.repo).toEqual({
      mode: "readWrite",
      message: null,
      onPushFailure: "fail",
      gitCredentials: "auto",
      baseBranch: null,
      workBranch: { kind: "create" },
    });
    expect(created.opencodeMcpJson).toBeNull();
    expect(created.healthChecksJson).toBeNull();
  });

  concurrentTest(
    "explicit pathless devcontainer is stored distinctly from repository default",
    async () => {
      const { projectId, headers } = requireSetup();
      const payload = {
        ...buildPayload(projectId),
        opencodeMcpJson: null,
        healthChecksJson: null,
        repo: { mode: "readWrite" as const },
      };
      const explicit = await unwrapAsync(
        apiClient.api["step-definitions"].put(
          {
            ...payload,
            environment: { kind: "inline", runtime: { kind: "devcontainer" } },
          },
          { headers },
        ),
      );
      expect(explicit.environment).toEqual({
        kind: "inline",
        runtime: { kind: "devcontainer" },
      });
      expect(await configIdOf(explicit.id)).toBeTruthy();
      const reloaded = await unwrapAsync(
        apiClient.api["step-definitions"]({
          stepDefinitionId: explicit.id,
        }).get({ headers }),
      );
      expect(reloaded.environment).toEqual(explicit.environment);
      const inherited = await unwrapAsync(
        apiClient.api["step-definitions"].put(payload, { headers }),
      );
      expect(inherited.environment).toBeNull();
      expect(await configIdOf(inherited.id)).toBeNull();
    },
  );

  concurrentTest(
    "rejects a health check naming an unknown MCP server",
    async () => {
      const { projectId, headers } = requireSetup();

      const { data, error } = await apiClient.api["step-definitions"].put(
        {
          ...buildPayload(projectId),
          healthChecksJson: [
            {
              kind: "tool" as const,
              tool: "list_issues",
              mcp: "missing",
              severity: "required" as const,
              timeoutSeconds: 15,
            },
          ],
        },
        { headers },
      );

      expect(data).toBeNull();
      expect(error?.status).toBe(422);
    },
  );
});
