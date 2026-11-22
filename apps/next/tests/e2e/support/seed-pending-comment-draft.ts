import type { Page } from "@playwright/test";

/**
 * Seeds one real, pending `work_item_platform_comment` draft against
 * `workItemId`, the same way an agent worker does in production: a
 * single-step pipeline is created and run against the item, then its one
 * Task is claimed and completed with `$scarn_notifications_v1` in its
 * `resultJson` — mirroring `packages/core/tests/notifications/
 * user-notification/integration/emit-notification-signal-support.ts`, which
 * proves claim + completion is what fires notification dispatch.
 *
 * Runs over `page.request` rather than the typed Eden client used in
 * `packages/core`'s integration tests: those tests call `createApp` in
 * process, but a Playwright spec only has this browser session's cookies to
 * authenticate with, and `page.request` is the one HTTP client that shares
 * them. The API is mounted in the same Next.js server at `/api` (see
 * `apps/next/app/api/[[...slugs]]/route.ts`), so a relative path plus the
 * session cookie is all real authorization needs — no bearer token, no
 * separate worker credential.
 */
export const seedPendingCommentDraft = async (
  page: Page,
  {
    projectId,
    workItemId,
    body,
  }: {
    projectId: string;
    workItemId: string;
    body: string;
  },
): Promise<void> => {
  const post = async (path: string, data: Record<string, unknown>) => {
    const response = await page.request.post(`/api${path}`, { data });
    if (!response.ok()) {
      throw new Error(
        `POST ${path} failed (${String(response.status())}): ${await response.text()}`,
      );
    }
    return (await response.json()) as Record<string, unknown>;
  };

  const suffix = crypto.randomUUID();

  const stepKey = `e2e_notification_step_${suffix}`;
  const pipelineKey = `e2e_notification_pipeline_${suffix}`;

  await post("/step-definitions", {
    projectId,
    key: stepKey,
    name: "E2E notification step",
    description: "Emits a notification item for e2e seeding",
    prompt: "Emit a notification item.",
    version: 1,
    kind: "user_defined",
    inputSchemaJson: { type: "object" },
    resultSchemaJson: { type: "object" },
    status: "active",
  });

  const definition = await post("/pipeline-definitions", {
    projectId,
    key: pipelineKey,
    name: "E2E notification pipeline",
    document: {
      schemaVersion: 1,
      key: pipelineKey,
      title: "E2E notification pipeline",
      start: { to: "notify" },
      nodes: {
        notify: {
          kind: "step",
          title: "Notify step",
          step: stepKey,
          next: {
            routes: [{ to: "done" }],
          },
        },
        done: { kind: "succeed" },
      },
    },
  });

  const pipelineRun = await post("/pipeline-executions", {
    projectId,
    workItemId,
    pipelineDefinitionId: definition["id"],
  });

  const visits = pipelineRun["visits"] as
    Array<{ nodeId: string; tasks: Array<{ taskId: string }> }> | undefined;
  const taskId = visits
    ?.find((visit) => visit.nodeId === "notify")
    ?.tasks.at(-1)?.taskId;
  if (!taskId) {
    throw new Error("Expected a queued Task for the notify step");
  }

  const claims = (await post("/task-runs/claims", {
    projectId,
    workerId: `e2e-notification-signal-worker-${suffix}`,
    batchSize: 1,
    leaseDurationSeconds: 30,
  })) as unknown as Array<{
    task: { id: string };
    claimToken: string;
  }>;
  const claim = claims.find((candidate) => candidate.task.id === taskId);
  if (!claim) {
    throw new Error(
      "Expected to claim the task created for this pipeline execution",
    );
  }

  await post(`/task-runs/${claim.task.id}/completions`, {
    claimToken: claim.claimToken,
    status: "succeeded",
    resultJson: {
      $scarn_notifications_v1: [
        {
          kind: "status_update",
          body,
          priority: "normal",
          suggestedChannels: ["work_item_platform_comment"],
        },
      ],
    },
    errorJson: null,
  });
};
