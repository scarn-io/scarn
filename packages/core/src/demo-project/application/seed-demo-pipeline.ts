import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { AppContext } from "@scarn/core/lib/di";
import { InvariantViolationError } from "@scarn/core/lib/errors";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import { upsertWorkItem } from "@scarn/core/work-items/work-item/application/upsert-work-item";
import type { WorkItemState } from "@scarn/core/work-items/work-item/domain/work-item-state";
import type { PipelineDocument } from "@scarn/sdk/contracts/pipeline-document";
import type { DemoPipelineFixture } from "../demo-project-fixtures";
import {
  ensureDemoPipelineDocument,
  ensureDemoStepDefinitions,
} from "./ensure-demo-pipeline-document";
import { ensureDemoWorkItemExecution } from "./seed-demo-execution";

const stepDefinitionKey = (
  fixture: DemoPipelineFixture,
  stepKey: string,
): string => `${fixture.key}_${stepKey}`;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Re-anchors a fixture's `daysAgo` offset onto a fresh `now`, mirroring the
 * "re-anchor to now" pattern in `replay-captured-log.ts` — but for a single
 * point in time rather than a whole log's timestamps, so seeded work items
 * always sort as freshly-updated relative to whenever the seed script runs.
 */
const reanchorDaysAgo = (daysAgo: number, now: Date): string =>
  new Date(now.getTime() - daysAgo * MS_PER_DAY).toISOString();

const DONE_NODE_ID = "done";

/**
 * The fixture's steps as a pipeline document: one step node per fixture step
 * (node id = step key), chained in array order, ending in a `succeed` node.
 */
export const buildDemoPipelineDocument = (
  fixture: DemoPipelineFixture,
): PipelineDocument => {
  const [first] = fixture.steps;
  if (!first) {
    throw new InvariantViolationError(
      `Demo pipeline fixture ${fixture.key} has no steps`,
      "DEMO_SEED_PIPELINE_FIXTURE_MISSING_STEPS",
    );
  }
  const nodes: PipelineDocument["nodes"] = {
    [DONE_NODE_ID]: { kind: "succeed" },
  };
  fixture.steps.forEach((step, index) => {
    nodes[step.key] = {
      kind: "step",
      title: step.stepName,
      step: stepDefinitionKey(fixture, step.key),
      next: {
        routes: [{ to: fixture.steps[index + 1]?.key ?? DONE_NODE_ID }],
      },
    };
  });
  return {
    schemaVersion: 1,
    key: fixture.key,
    title: fixture.name,
    start: { to: first.key },
    nodes,
  };
};

/**
 * Ensures every step definition and the pipeline's active version match the
 * fixture. Publishing is idempotent by content hash, so a no-op re-seed adds
 * no version while a fixture edit lands as a new one.
 */
const ensureDemoPipelineDefinition = async (
  appContext: AppContext,
  projectId: UuidV7,
  userAuthz: UserAuthorizationService,
  fixture: DemoPipelineFixture,
): Promise<UuidV7> => {
  const document = buildDemoPipelineDocument(fixture);
  await ensureDemoStepDefinitions(
    appContext,
    projectId,
    userAuthz,
    fixture.steps.map((step) => ({
      key: stepDefinitionKey(fixture, step.key),
      name: step.stepName,
      description: fixture.description,
      prompt: step.stepPrompt,
    })),
  );
  return await ensureDemoPipelineDocument(appContext, projectId, userAuthz, {
    name: fixture.name,
    document,
  });
};

/**
 * Ensures one of the pipeline's work items exists and matches its fixture,
 * keyed on its fixed `platformKey`.
 *
 * `upsertWorkItem` rather than create-if-absent: `status` is derived
 * from the fixture's `outcome`, and `sourceUpdatedAt` is re-anchored to the
 * current run, so a create-only path leaves an already-seeded project showing
 * a stale status chip (an `in-progress` chip on an item the seed now completes
 * or fails) and stale "last updated" ordering.
 */
const ensureDemoWorkItem = async (
  appContext: AppContext,
  projectId: UuidV7,
  userAuthz: UserAuthorizationService,
  fixture: DemoPipelineFixture["workItems"][number],
): Promise<UuidV7> => {
  const upserted = await upsertWorkItem(
    {
      projectId,
      platform: "scarn",
      platformId: fixture.platformKey,
      platformKey: fixture.platformKey,
      url: null,
      title: fixture.title,
      description: fixture.description,
      sourceCreatedAt: null,
      sourceUpdatedAt: reanchorDaysAgo(
        fixture.daysAgo,
        appContext.timeProvider.now(),
      ),
      state: outcomeToWorkItemState(fixture.outcome),
      fields: {},
    },
    {
      userAuthz,
      workItemRepo: appContext.workItemRepo,
      workItemBlockRepo: appContext.workItemBlockRepo,
      workItemEvents: appContext.workItemEvents,
      timeProvider: appContext.timeProvider,
    },
  );
  // `WorkItemContract.id` is the plain `UuidV7` brand this function's callers
  // work in; the repo's domain layer uses `WorkItemId` over the same string.
  return parseUuidV7(upserted.id);
};

const outcomeToWorkItemState = (
  outcome: DemoPipelineFixture["workItems"][number]["outcome"],
): WorkItemState => {
  switch (outcome) {
    case "notStarted":
    case "queued":
      return "open";
    case "succeeded":
    case "failed":
      return "closed";
  }
};

/**
 * Ensures one demo pipeline: every one of its step definitions, its pipeline
 * document (one step node per fixture step, in order), and every one of
 * its fixture work items — each driven to the pipeline execution state its
 * fixture asks for.
 *
 * Definitions are brought in line with the fixture on every run; work items
 * and executions are create-if-absent (re-driving an execution needs
 * `reset-demo-executions.ts` first).
 */
export const ensureDemoPipeline = async (
  appContext: AppContext,
  projectId: UuidV7,
  userAuthz: UserAuthorizationService,
  fixture: DemoPipelineFixture,
): Promise<void> => {
  const pipelineDefinitionId = await ensureDemoPipelineDefinition(
    appContext,
    projectId,
    userAuthz,
    fixture,
  );

  for (const workItemFixture of fixture.workItems) {
    const workItemId = await ensureDemoWorkItem(
      appContext,
      projectId,
      userAuthz,
      workItemFixture,
    );

    await ensureDemoWorkItemExecution(appContext, {
      projectId,
      userAuthz,
      pipelineDefinitionId,
      workItemId,
      stepTitle: workItemFixture.title,
      outcome: workItemFixture.outcome,
      withToolEvents: workItemFixture.withToolEvents ?? false,
    });
  }
};
