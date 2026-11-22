/**
 * Seeds one or more real `user_notifications` (+ their
 * `notification_deliveries` rows) the same way an agent worker does in
 * production: claiming a real, pipeline-linked `task` and completing it with
 * a `$scarn_notifications_v1` entry in its `resultJson`, via the real
 * worker-facing HTTP API (`POST /tasks/claims` +
 * `POST /tasks/:id/completions`). Completion creates the notifications and
 * dispatches their deliveries in the same transaction, giving real
 * `workItemId`/`pipelineExecutionId` provenance.
 *
 * The `work-item-comment-draft.*.test.ts` files use this instead of
 * hand-constructing a `UserNotificationEntity` directly, so the dispatcher
 * is exercised end to end.
 */
import { parseUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import type {
  NotificationPriority,
  UserNotificationKind,
} from "@/notifications/user-notification/contracts/user-notification-contracts";
import type { NotificationChannel } from "@/notifications/notification-delivery/contracts/notification-delivery-contracts";
import { NOTIFICATION_SIGNAL_KEY } from "@/notifications/user-notification/contracts/notification-signal-contracts";
import type { AnyJsonValue } from "@/common/contracts/json";
import {
  createPipelineFromDocument,
  latestTaskIdForNode,
  singleStepPipelineDocument,
} from "tests/pipeline-definitions/pipeline-test-support";
import type { createScarnTreaty } from "tests/treaty";
import { unwrapAsync } from "tests/utils";

export type EmitNotificationSignalItem = {
  kind: UserNotificationKind;
  title?: string;
  body: string;
  priority?: NotificationPriority;
  suggestedChannels?: NotificationChannel[];
  payload?: Record<string, AnyJsonValue>;
};

export type EmitNotificationSignalParams = {
  apiClient: ReturnType<typeof createScarnTreaty>;
  authHeaders: { authorization: string };
  projectId: UuidV7;
  workItemId: UuidV7;
  items: EmitNotificationSignalItem[];
  /** The step definition's key; random when omitted. */
  stepDefinitionKey?: string;
  /**
   * Declares an artifact field per entry at `resultJson[key]` and reports
   * `reported` there. Used to exercise `artifact:signal/<stepKey>/<key>`
   * markers.
   */
  artifactSignals?: Array<{ key: string; reported: string | null }>;
  /** Runs after the task is claimed and before it completes. */
  beforeComplete?: (task: { taskId: UuidV7 }) => Promise<void>;
};

export type EmittedNotificationSignal = {
  pipelineRunId: UuidV7;
  taskId: UuidV7;
  stepDefinitionKey: string;
};

/**
 * Emits `params.items` under `$scarn_notifications_v1` from the only step
 * of a fresh single-step pipeline run against `params.workItemId`. Every
 * item becomes its own `user_notifications` row.
 *
 * Callers resolve the resulting notification id(s) afterwards by querying
 * `GET /work-item-comment-drafts` (for anything suggesting
 * `work_item_platform_comment`) or `GET /projects/:projectId/notifications`
 * (for the general drawer) and matching on each item's (unique) `body` —
 * see `findPendingDraftByBody`/`findDrawerNotificationByBody` below.
 */
export const emitNotificationSignal = async (
  params: EmitNotificationSignalParams,
): Promise<EmittedNotificationSignal> => {
  const { apiClient, authHeaders, projectId, workItemId, items } = params;
  const stepDefinitionKey =
    params.stepDefinitionKey ??
    `notification_signal_step_${crypto.randomUUID()}`;
  const artifactSignals = params.artifactSignals ?? [];

  await unwrapAsync(
    apiClient.api["step-definitions"].post(
      {
        projectId,
        key: stepDefinitionKey,
        name: "Notification signal step",
        description: "Emits notification items for test seeding",
        prompt: "Emit notification items.",
        version: 1,
        kind: "user_defined" as const,
        inputSchemaJson: { type: "object" },
        resultSchemaJson: {
          type: "object",
          properties: Object.fromEntries(
            artifactSignals.map(({ key }) => [
              key,
              { type: ["string", "null"], "x-scarn-artifact": {} },
            ]),
          ),
        },
        status: "active" as const,
      },
      { headers: { ...authHeaders } },
    ),
  );

  const definition = await createPipelineFromDocument(
    apiClient,
    authHeaders,
    projectId,
    singleStepPipelineDocument(
      `notification-signal-pipeline-${crypto.randomUUID()}`,
      stepDefinitionKey,
    ),
    "Notification signal pipeline",
  );

  const pipelineRun = await unwrapAsync(
    apiClient.api["pipeline-executions"].post(
      {
        projectId,
        workItemId,
        pipelineDefinitionId: parseUuidV7(definition.id),
      },
      { headers: { ...authHeaders } },
    ),
  );
  const queuedTaskId = latestTaskIdForNode(pipelineRun);

  const signalItemsJson: AnyJsonValue[] = items.map((item) => ({
    kind: item.kind,
    ...(item.title !== undefined ? { title: item.title } : {}),
    body: item.body,
    priority: item.priority ?? "normal",
    ...(item.suggestedChannels !== undefined
      ? { suggestedChannels: item.suggestedChannels }
      : {}),
    ...(item.payload !== undefined ? { payload: item.payload } : {}),
  }));

  const claims = await unwrapAsync(
    apiClient.api["task-runs"].claims.post(
      {
        projectId,
        workerId: `notification-signal-worker-${crypto.randomUUID()}`,
        batchSize: 1,
        leaseDurationSeconds: 30,
      },
      { headers: { ...authHeaders } },
    ),
  );
  const claim = claims.find((candidate) => candidate.task.id === queuedTaskId);
  if (!claim) {
    throw new Error(
      "Expected to claim the task created for this pipeline execution",
    );
  }

  const taskId = parseUuidV7(claim.task.id);
  await params.beforeComplete?.({ taskId });

  await unwrapAsync(
    apiClient.api["task-runs"]({
      taskRunId: claim.task.id,
    }).completions.post(
      {
        claimToken: claim.claimToken,
        status: "succeeded",
        resultJson: {
          [NOTIFICATION_SIGNAL_KEY]: signalItemsJson,
          ...Object.fromEntries(
            artifactSignals.map(({ key, reported }) => [key, reported]),
          ),
        },
        errorJson: null,
      },
      { headers: { ...authHeaders } },
    ),
  );

  return {
    pipelineRunId: parseUuidV7(pipelineRun.id),
    taskId,
    stepDefinitionKey,
  };
};

/**
 * Finds the pending/failed `work_item_platform_comment` draft (as returned
 * by `GET /work-item-comment-drafts`) whose notification body matches
 * `body` exactly. Throws if none is found, since every caller uses a unique
 * body per seeded item specifically so this lookup is unambiguous.
 */
export const findPendingDraftByBody = async (
  apiClient: ReturnType<typeof createScarnTreaty>,
  authHeaders: { authorization: string },
  workItemId: UuidV7,
  body: string,
) => {
  const drafts = await unwrapAsync(
    apiClient.api["work-item-comment-drafts"].get({
      query: { workItemId },
      headers: { ...authHeaders },
    }),
  );
  const match = drafts.find((draft) => draft.notification.body === body);
  if (!match) {
    throw new Error(
      `Expected a pending comment draft with body ${JSON.stringify(body)}, got: ${JSON.stringify(
        drafts.map((d) => d.notification.body),
      )}`,
    );
  }
  return match;
};

/**
 * Finds the notification (as returned by the general drawer,
 * `GET /projects/:projectId/notifications`) whose body matches `body`
 * exactly. Returns `undefined` (rather than throwing) when not found, since
 * several tests below assert absence from the drawer as the expected
 * outcome.
 */
export const findDrawerNotificationByBody = async (
  apiClient: ReturnType<typeof createScarnTreaty>,
  authHeaders: { authorization: string },
  projectId: UuidV7,
  workItemId: UuidV7,
  body: string,
) => {
  const notifications = await unwrapAsync(
    apiClient.api.projects({ projectId }).notifications.get({
      query: { workItemId },
      headers: { ...authHeaders },
    }),
  );
  return notifications.find((n) => n.body === body);
};
