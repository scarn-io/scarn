import { eq } from "drizzle-orm";
import {
  createUuidV7,
  parseUuidV7,
  type UuidV7,
} from "@/common/contracts/uuid-v7";
import type { AnyJsonValue } from "@/common/contracts/json";
import { getDb } from "@/lib/db";
import {
  managedConnectionEvents,
  workItemComments,
  workItems,
} from "@/lib/db/schema";
import type { WorkItemChange } from "@/tasks/task/contracts/work-item-change-contracts";
import type { ProjectSecretsTestUser } from "tests/secrets/secret/integration/project-secret-test-support";
import { grant } from "tests/tasks/task/grants-test-support";
import { unwrapAsync, unwrapStartedTaskAsync } from "tests/utils";
import type { createManagedConnectionHarness } from "./managed-connection-test-support";

const notionRef = { notion: { type: "ref", auth: { connection: "notion" } } };

export type SealProject = {
  owner: ProjectSecretsTestUser;
  projectId: UuidV7;
  connectionId: UuidV7;
  stepId: UuidV7;
  stepKey: string;
};

export type SealRun = {
  taskRunId: UuidV7;
  claimToken: string;
  workItemId: UuidV7;
  launchConnectionId: UuidV7;
  relayUrl: string;
  capability: string;
};

/**
 * Projects with a ready Notion connection and a step that references it and
 * may comment on its own work item, plus claimed, launched runs of that step
 * and the seal calls a worker makes, against the real completion path.
 */
export const createSealTestClient = (
  harness: ReturnType<typeof createManagedConnectionHarness>,
) => {
  const { apiClient, origin } = harness;

  const createStep = async (
    owner: ProjectSecretsTestUser,
    projectId: UuidV7,
    mcp: object = notionRef,
    settings: object = {},
  ) =>
    await unwrapAsync(
      apiClient.api["step-definitions"].post(
        {
          projectId,
          key: `seal_${crypto.randomUUID()}`,
          name: "Managed seal",
          description: null,
          prompt: "Use Notion.",
          version: 1,
          kind: "user_defined",
          inputSchemaJson: { type: "object" },
          resultSchemaJson: { type: "object" },
          status: "active",
          opencodeMcpJson: mcp as never,
          grants: [grant("comment", "self")],
          ...settings,
        },
        { headers: owner.authHeaders },
      ),
    );

  /**
   * A new owner and project whose Notion connection is ready, and a step
   * that references it; `settings` adds step definition fields such as `retry`.
   */
  const project = async (
    label: string,
    mcp?: object,
    settings?: object,
  ): Promise<SealProject> => {
    const { owner, projectId, connectionId } =
      await harness.connectToReady(label);
    const step = await createStep(owner, parseUuidV7(projectId), mcp, settings);
    return {
      owner,
      projectId: parseUuidV7(projectId),
      connectionId: parseUuidV7(connectionId),
      stepId: parseUuidV7(step.id),
      stepKey: step.key,
    };
  };

  /** Connects the project's disconnected Notion connection again. */
  const reconnectFromDisconnected = async (target: SealProject) => {
    const started = await harness.startConnect(target.owner, target.projectId);
    const { location } = await harness.callback(
      await harness.authorize(started.authorizationUrl),
      target.owner.authHeaders,
    );
    if (location.searchParams.get("error") !== null) {
      throw new Error("expected the callback to succeed");
    }
    const pending = await harness.getConnection(
      target.owner,
      target.projectId,
      target.connectionId,
    );
    if (!pending.candidate) {
      throw new Error("expected a candidate");
    }
    await unwrapAsync(
      harness
        .connections(target.projectId)({ connectionId: target.connectionId })
        .candidate.confirm.post(
          {
            candidateId: pending.candidate.id,
            fingerprint: pending.candidate.fingerprint,
            expectedVersion: pending.version,
          },
          { headers: { ...target.owner.authHeaders, origin } },
        ),
    );
  };

  /** A work item Scarn owns, so the run's changes can apply to it. */
  const seedNativeWorkItem = async (projectId: UuidV7) => {
    const id = createUuidV7();
    await getDb()
      .insert(workItems)
      .values({
        id,
        projectId,
        platform: "scarn",
        platformKey: `manual-${id}`,
        title: `Item ${id}`,
        description: "Original",
      });
    return id;
  };

  const claim = async (target: SealProject, workItemId: UuidV7) => {
    const claims = await unwrapAsync(
      apiClient.api["task-runs"].claims.post(
        {
          projectId: target.projectId,
          workItemId,
          workerId: "seal-worker",
          batchSize: 1,
          leaseDurationSeconds: 60,
        },
        { headers: target.owner.authHeaders },
      ),
    );
    const [claimed] = claims;
    if (!claimed) {
      throw new Error("expected a claim");
    }
    return {
      taskRunId: parseUuidV7(claimed.task.id),
      claimToken: claimed.claimToken,
    };
  };

  /** Registers the run's launch; its Notion launch connection and relay entry. */
  const register = async (
    target: SealProject,
    taskRunId: UuidV7,
    claimToken: string,
  ) => {
    const registered = await unwrapAsync(
      apiClient.api["task-runs"]({ taskRunId })["managed-launch"].post(
        {
          claimToken,
          entries: { notion: { url: harness.fake.resource } },
          remotesWithoutAuth: {},
        },
        { headers: target.owner.authHeaders },
      ),
    );
    const entry = registered.entries["notion"];
    const [launch] = await harness.appContext.managedLaunchRepo.listOpenForRun(
      taskRunId,
      getDb(),
    );
    if (!launch || !entry) {
      throw new Error("expected an open launch connection");
    }
    return { launch, entry };
  };

  /** A standalone Task of the project's step on a new native work item, claimed and launched. */
  const launchRun = async (target: SealProject): Promise<SealRun> => {
    const workItemId = await seedNativeWorkItem(target.projectId);
    await unwrapStartedTaskAsync(
      apiClient.api.tasks.post(
        {
          projectId: target.projectId,
          workItemId,
          stepDefinitionId: target.stepId,
          stepDefinitionVersion: 1,
          inputJson: {},
          executionTimeoutSeconds: 600,
        },
        { headers: target.owner.authHeaders },
      ),
    );
    const claimed = await claim(target, workItemId);
    const { launch, entry } = await register(
      target,
      claimed.taskRunId,
      claimed.claimToken,
    );
    return {
      ...claimed,
      workItemId,
      launchConnectionId: launch.id,
      relayUrl: entry.relayUrl,
      capability: entry.capability,
    };
  };

  const commentChange = (run: SealRun): WorkItemChange[] => [
    { kind: "comment", workItemId: run.workItemId, body: "From the run" },
  ];

  /** Reports the run succeeded with a comment on its work item; the raw response. */
  const complete = (
    target: SealProject,
    run: Pick<SealRun, "taskRunId" | "claimToken" | "workItemId">,
    workItemChanges: WorkItemChange[] = commentChange(run as SealRun),
    resultJson: AnyJsonValue = { done: true },
  ) =>
    apiClient.api["task-runs"]({ taskRunId: run.taskRunId }).completions.post(
      {
        claimToken: run.claimToken,
        status: "succeeded",
        resultJson,
        errorJson: null,
        workItemChanges,
      },
      { headers: target.owner.authHeaders },
    );

  const yieldRun = (
    target: SealProject,
    run: Pick<SealRun, "taskRunId" | "claimToken">,
  ) =>
    apiClient.api["task-runs"]({ taskRunId: run.taskRunId }).yields.post(
      { claimToken: run.claimToken, message: "Which one?" },
      { headers: target.owner.authHeaders },
    );

  const disconnect = (target: SealProject) =>
    harness.disconnect(target.owner, target.projectId, target.connectionId);

  const commentsOn = async (workItemId: UuidV7) =>
    await getDb()
      .select({ body: workItemComments.body })
      .from(workItemComments)
      .where(eq(workItemComments.workItemId, workItemId));

  const authorityLostEvents = async (connectionId: UuidV7) =>
    (
      await getDb()
        .select({
          type: managedConnectionEvents.type,
          taskRunId: managedConnectionEvents.taskRunId,
          reasonCode: managedConnectionEvents.reasonCode,
        })
        .from(managedConnectionEvents)
        .where(eq(managedConnectionEvents.connectionId, connectionId))
    ).filter((event) => event.type === "authority_lost");

  return {
    createStep,
    project,
    reconnectFromDisconnected,
    seedNativeWorkItem,
    claim,
    register,
    launchRun,
    complete,
    yieldRun,
    disconnect,
    commentsOn,
    authorityLostEvents,
  };
};

/** The `errorJson` the authority fence stores on a run it failed. */
export const authorityLost = (reason: string) => ({
  name: "ManagedConnectionAuthorityLost",
  cause: { reason },
});
