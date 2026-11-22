import { parseUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { seedWorkItem } from "tests/lib/db/seed-task-prerequisites";
import type { ProjectSecretsTestUser } from "tests/secrets/secret/integration/project-secret-test-support";
import { unwrapAsync, unwrapStartedTaskAsync } from "tests/utils";
import type { createManagedConnectionHarness } from "./managed-connection-test-support";

export const notionRef = {
  notion: { type: "ref", auth: { connection: "notion" } },
};

type LaunchUrls = Record<string, { url: string }>;

/** Starts and claims runs of a step with a given MCP config, and registers their launch. */
export const createLaunchTestClient = (
  harness: ReturnType<typeof createManagedConnectionHarness>,
) => {
  const { apiClient, fake } = harness;

  const startAndClaim = async (
    owner: ProjectSecretsTestUser,
    projectId: UuidV7,
    opencodeMcpJson: Record<string, unknown>,
  ) => {
    const stepDefinition = await unwrapAsync(
      apiClient.api["step-definitions"].post(
        {
          projectId,
          key: `launch_${crypto.randomUUID()}`,
          name: "Managed launch",
          description: null,
          prompt: "Use Notion.",
          version: 1,
          kind: "user_defined",
          inputSchemaJson: { type: "object" },
          resultSchemaJson: { type: "object" },
          status: "active",
          opencodeMcpJson: opencodeMcpJson as never,
        },
        { headers: owner.authHeaders },
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
          executionTimeoutSeconds: 600,
        },
        { headers: owner.authHeaders },
      ),
    );
    const [claim] = await unwrapAsync(
      apiClient.api["task-runs"].claims.post(
        {
          projectId,
          workerId: "launch-worker",
          batchSize: 1,
          leaseDurationSeconds: 60,
        },
        { headers: owner.authHeaders },
      ),
    );
    if (!claim) {
      throw new Error("expected a claim");
    }
    return {
      taskRunId: parseUuidV7(claim.task.id),
      claimToken: claim.claimToken,
    };
  };

  /** Registers with `urls`, by default the fake's resource for a `notion` entry. */
  const register = (
    owner: ProjectSecretsTestUser,
    taskRunId: UuidV7,
    claimToken: string,
    urls: { entries?: LaunchUrls; remotesWithoutAuth?: LaunchUrls } = {},
  ) =>
    apiClient.api["task-runs"]({ taskRunId })["managed-launch"].post(
      {
        claimToken,
        entries: urls.entries ?? { notion: { url: fake.resource } },
        remotesWithoutAuth: urls.remotesWithoutAuth ?? {},
      },
      { headers: owner.authHeaders },
    );

  return { startAndClaim, register };
};
