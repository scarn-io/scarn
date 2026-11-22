import { eq } from "drizzle-orm";
import { beforeAll, describe, expect } from "bun:test";
import { createApp } from "@scarn/api/app";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { createScarnTreaty } from "tests/treaty";
import { createAppContext } from "@/lib/di";
import { getDb } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import type { TimeProvider } from "@/lib/time-provider";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";
import { serialTest, unwrapAsync, unwrapStartedTaskAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { seedWorkItem } from "tests/lib/db/seed-task-prerequisites";

const LOG_FEED = {
  url: "https://feed.example.com",
  tokenSecret: "log-feed-token-test-secret",
};

const decodePayload = (token: string): unknown =>
  JSON.parse(
    Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
  );

/**
 * Each test creates its own project, so flipping one public never affects
 * another. `currentTime` is shared, so the tests run serially.
 */
describe("log feed tokens", () => {
  let currentTime = new Date("2026-06-01T12:00:00.000Z");
  const timeProvider: TimeProvider = {
    now: () => currentTime,
    nowIso: () => currentTime.toISOString(),
  };
  const configured = createScarnTreaty(
    createApp(createAppContext({ timeProvider, logFeedConnection: LOG_FEED })),
  );
  const unconfigured = createScarnTreaty(
    createApp(createAppContext({ timeProvider, logFeedConnection: null })),
  );
  let owner: { authHeaders: { authorization: string } } | undefined;

  beforeAll(async () => {
    owner = await createTestUserAndSession({
      email: `log-feed-token-${crypto.randomUUID()}@example.com`,
    });
  });

  const claimRun = async (
    apiClient: ReturnType<typeof createScarnTreaty>,
    label: string,
  ) => {
    if (!owner) {
      throw new Error("Expected setup to complete");
    }
    const headers = { ...owner.authHeaders };
    const project: ProjectContract = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: `Log Feed Token ${label}`,
          description: "Project for log feed token tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers },
      ),
    );
    const projectId = parseUuidV7(project.id);
    const stepDefinition = await unwrapAsync(
      apiClient.api["step-definitions"].post(
        {
          projectId,
          key: `log_feed_${crypto.randomUUID()}`,
          name: "Log feed step",
          description: "Step for log feed token tests",
          prompt: "Return a result payload.",
          version: 1,
          kind: "user_defined",
          inputSchemaJson: { type: "object" },
          resultSchemaJson: { type: "object" },
          status: "active",
        },
        { headers },
      ),
    );
    await unwrapStartedTaskAsync(
      apiClient.api.tasks.post(
        {
          projectId,
          workItemId: await seedWorkItem(projectId),
          stepDefinitionId: stepDefinition.id,
          stepDefinitionVersion: 1,
          inputJson: {},
          executionTimeoutSeconds: 300,
        },
        { headers },
      ),
    );
    const [claim] = await unwrapAsync(
      apiClient.api["task-runs"].claims.post(
        {
          projectId,
          workerId: `worker-${label}`,
          batchSize: 1,
          leaseDurationSeconds: 30,
        },
        { headers },
      ),
    );
    if (!claim) {
      throw new Error("Expected a claim");
    }
    return {
      projectId,
      orgId: project.orgId,
      taskRunId: parseUuidV7(claim.task.id),
      claim,
      headers,
    };
  };

  const makePublic = (projectId: UuidV7) =>
    getDb()
      .update(projects)
      .set({ visibility: "public" })
      .where(eq(projects.id, projectId));

  serialTest(
    "a claim carries a write token for its run when the feed is configured",
    async () => {
      currentTime = new Date("2026-06-01T12:00:00.000Z");
      const { projectId, orgId, taskRunId, claim } = await claimRun(
        configured,
        "claim",
      );

      const exp = currentTime.getTime() / 1000 + 15 * 60;
      expect(claim.logFeed?.url).toBe(
        `wss://feed.example.com/task-runs/${taskRunId}/ws`,
      );
      expect(claim.logFeed?.expiresAt).toBe(new Date(exp * 1000).toISOString());
      expect(decodePayload(claim.logFeed?.token ?? "")).toEqual({
        tid: taskRunId,
        pid: projectId,
        oid: orgId,
        scope: "write",
        exp,
      });
    },
  );

  serialTest(
    "a claim has no log feed when the feed is not configured",
    async () => {
      currentTime = new Date("2026-06-01T12:05:00.000Z");
      const { claim } = await claimRun(unconfigured, "claim-unconfigured");
      expect(claim.logFeed).toBeNull();
    },
  );

  serialTest("the claim holder can refresh its write token", async () => {
    currentTime = new Date("2026-06-01T12:10:00.000Z");
    const { projectId, orgId, taskRunId, claim, headers } = await claimRun(
      configured,
      "refresh",
    );
    currentTime = new Date("2026-06-01T12:10:10.000Z");

    const refreshed = await unwrapAsync(
      configured.api["task-runs"]({ taskRunId })["log-feed-token"].post(
        { claimToken: claim.claimToken },
        { headers },
      ),
    );

    const exp = currentTime.getTime() / 1000 + 15 * 60;
    expect(refreshed.url).toBe(
      `wss://feed.example.com/task-runs/${taskRunId}/ws`,
    );
    expect(decodePayload(refreshed.token)).toEqual({
      tid: taskRunId,
      pid: projectId,
      oid: orgId,
      scope: "write",
      exp,
    });
  });

  serialTest("the write token is refused for a wrong claim token", async () => {
    currentTime = new Date("2026-06-01T12:15:00.000Z");
    const { taskRunId, headers } = await claimRun(configured, "wrong-claim");

    const { data, error } = await configured.api["task-runs"]({
      taskRunId,
    })["log-feed-token"].post({ claimToken: "not-the-claim" }, { headers });

    expect(data).toBeNull();
    expect(error?.status).toBe(409);
    expect(error?.value).toMatchObject({ code: "TASK_OWNERSHIP_CONFLICT" });
  });

  serialTest("the write token is refused for an expired claim", async () => {
    currentTime = new Date("2026-06-01T12:20:00.000Z");
    const { taskRunId, claim, headers } = await claimRun(
      configured,
      "expired-claim",
    );
    currentTime = new Date("2026-06-01T12:25:00.000Z");

    const { data, error } = await configured.api["task-runs"]({
      taskRunId,
    })["log-feed-token"].post({ claimToken: claim.claimToken }, { headers });

    expect(data).toBeNull();
    expect(error?.status).toBe(409);
  });

  serialTest("a project member gets a read token", async () => {
    currentTime = new Date("2026-06-01T12:30:00.000Z");
    const { projectId, orgId, taskRunId, headers } = await claimRun(
      configured,
      "read-member",
    );

    const issued = await unwrapAsync(
      configured.api["task-runs"]({ taskRunId })["log-feed-token"].get({
        headers,
      }),
    );

    const exp = currentTime.getTime() / 1000 + 15 * 60;
    expect(issued.url).toBe(`wss://feed.example.com/task-runs/${taskRunId}/ws`);
    expect(decodePayload(issued.token)).toEqual({
      tid: taskRunId,
      pid: projectId,
      oid: orgId,
      scope: "read",
      exp,
    });
  });

  serialTest(
    "the read token is refused to callers without executions:read",
    async () => {
      currentTime = new Date("2026-06-01T12:35:00.000Z");
      const { taskRunId } = await claimRun(configured, "read-denied");
      const outsider = await createTestUserAndSession({
        email: `log-feed-outsider-${crypto.randomUUID()}@example.com`,
      });

      const asOutsider = await configured.api["task-runs"]({ taskRunId })[
        "log-feed-token"
      ].get({ headers: { ...outsider.authHeaders } });
      expect(asOutsider.data).toBeNull();
      expect(asOutsider.error?.status).toBe(403);

      const anonymous = await configured.api["task-runs"]({ taskRunId })[
        "log-feed-token"
      ].get();
      expect(anonymous.data).toBeNull();
      expect(anonymous.error?.status).toBe(401);
    },
  );

  serialTest(
    "a public project gives an anonymous caller a read token",
    async () => {
      currentTime = new Date("2026-06-01T12:40:00.000Z");
      const { projectId, taskRunId } = await claimRun(configured, "public");
      await makePublic(projectId);

      const issued = await unwrapAsync(
        configured.api["task-runs"]({ taskRunId })["log-feed-token"].get(),
      );

      expect(decodePayload(issued.token)).toMatchObject({
        tid: taskRunId,
        scope: "read",
      });
    },
  );

  serialTest(
    "both routes return 404 when the feed is not configured",
    async () => {
      currentTime = new Date("2026-06-01T12:45:00.000Z");
      const { taskRunId, claim, headers } = await claimRun(
        unconfigured,
        "not-configured",
      );

      const write = await unconfigured.api["task-runs"]({ taskRunId })[
        "log-feed-token"
      ].post({ claimToken: claim.claimToken }, { headers });
      expect(write.error?.status).toBe(404);
      expect(write.error?.value).toMatchObject({
        code: "LOG_FEED_NOT_CONFIGURED",
      });

      const read = await unconfigured.api["task-runs"]({ taskRunId })[
        "log-feed-token"
      ].get({ headers });
      expect(read.error?.status).toBe(404);
      expect(read.error?.value).toMatchObject({
        code: "LOG_FEED_NOT_CONFIGURED",
      });
    },
  );
});
