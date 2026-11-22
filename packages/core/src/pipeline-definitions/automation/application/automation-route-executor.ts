import { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import { SYSTEM_ACTOR_ID } from "@scarn/core/access/authorization/system-actor";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import {
  CoreValidationError,
  ResourceConflictError,
} from "@scarn/core/lib/errors";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { PipelineGraphRepo } from "@scarn/core/pipeline-definitions/pipeline-graph/application/pipeline-graph-repo";
import type { StepDefinitionRepo } from "@scarn/core/pipeline-definitions/step-definition/application/step-definition-repo";
import {
  createPipelineRun,
  type CreatePipelineRunDeps,
} from "@scarn/core/pipeline-executions/pipeline-run/application/create-pipeline-run";
import {
  startTaskFromStepDefinition,
  type StartTaskFromStepDefinitionDeps,
} from "@scarn/core/tasks/task/application/start-task-from-step-definition";
import type { WorkItemEntity } from "@scarn/core/work-items/work-item/domain/work-item-entity";
import type { AutomationTargetJson } from "@scarn/sdk/contracts/automation-document";
import type { AutomationEntity } from "../domain/automation-entity";
import { attachAutomation } from "./attach-automation";
import type { AutomationRepo } from "./automation-repo";
import {
  resolveTargetArgs,
  type AutomationEventContext,
} from "./automation-event-context";
import type { WorkItemAutomationRepo } from "./work-item-automation-repo";

/** What starting a pipeline run needs, minus who starts it and the transaction. */
export type AutomationPipelineRunDeps = Omit<
  CreatePipelineRunDeps,
  "userAuthz" | "triggeredBy" | "dbExecutor" | "pipelineGraphRepo"
>;

export type AutomationRouteDeps = StartTaskFromStepDefinitionDeps & {
  stepDefinitionRepo: Pick<StepDefinitionRepo, "listLatestActiveByKeys">;
  pipelineGraphRepo: PipelineGraphRepo;
  automationRepo: AutomationRepo;
  workItemAutomationRepo: WorkItemAutomationRepo;
  pipelineRuns: AutomationPipelineRunDeps;
  /** The system actor: automations act without a user's permissions. */
  systemAuthz: UserAuthorizationService;
  timeProvider: TimeProvider;
};

/**
 * What a target did, as the activity line's outcome, and, for a new
 * attachment, the automation whose `self.attached` fires next.
 */
export type RouteResult = {
  outcome: string;
  attached?: { workItem: WorkItemEntity; automation: AutomationEntity };
};

const subjectOf = (
  on: "workItem" | "child",
  context: AutomationEventContext,
): WorkItemEntity => {
  if (on === "child") {
    if (!context.child) {
      throw new CoreValidationError(
        `"${context.event}" has no child work item`,
        "AUTOMATION_NO_CHILD",
      );
    }
    return context.child;
  }
  return context.workItem;
};

const startStep = async (
  target: Extract<AutomationTargetJson, { kind: "step" }>,
  automation: AutomationEntity,
  context: AutomationEventContext,
  deps: AutomationRouteDeps,
  tx: DbExecutor,
): Promise<RouteResult> => {
  const on = subjectOf(target.on, context);
  const [stepDefinition] = await deps.stepDefinitionRepo.listLatestActiveByKeys(
    on.projectId,
    [target.to],
    tx,
  );
  if (!stepDefinition) {
    throw new CoreValidationError(
      `No active step definition has the key ${target.to}`,
      "AUTOMATION_STEP_NOT_FOUND",
    );
  }
  const started = await startTaskFromStepDefinition(
    stepDefinition,
    {
      projectId: on.projectId,
      workItemId: parseUuidV7(on.id),
      inputJson: resolveTargetArgs(target.args, context),
      executionTimeoutSeconds: null,
      startedByUserId: null,
      startedByAutomationId: automation.id,
    },
    deps,
    tx,
  );
  return {
    outcome: started.ok
      ? `started ${target.to}`
      : "skipped: concurrency group full",
  };
};

const startPipeline = async (
  target: Extract<AutomationTargetJson, { kind: "pipeline" }>,
  automation: AutomationEntity,
  context: AutomationEventContext,
  deps: AutomationRouteDeps,
  tx: DbExecutor,
): Promise<RouteResult> => {
  const on = subjectOf(target.on, context);
  const handle = await deps.pipelineGraphRepo.findHandleByKey(
    on.projectId,
    target.to,
    tx,
  );
  if (!handle || handle.isArchived) {
    throw new CoreValidationError(
      `No active pipeline has the key ${target.to}`,
      "AUTOMATION_PIPELINE_NOT_FOUND",
    );
  }
  const created = await createPipelineRun(
    {
      projectId: on.projectId,
      workItemId: on.id,
      pipelineDefinitionId: handle.id,
    },
    {
      ...deps.pipelineRuns,
      pipelineGraphRepo: deps.pipelineGraphRepo,
      userAuthz: deps.systemAuthz,
      triggeredBy: { automationId: automation.id },
      dbExecutor: tx,
    },
  );
  if (created.ok) {
    return { outcome: `started pipeline ${target.to}` };
  }
  if (created.error instanceof ResourceConflictError) {
    return { outcome: "skipped: a pipeline run is already open" };
  }
  throw created.error;
};

const attach = async (
  target: Extract<AutomationTargetJson, { kind: "attach" }>,
  context: AutomationEventContext,
  deps: AutomationRouteDeps,
  tx: DbExecutor,
): Promise<RouteResult> => {
  const { workItem } = context;
  const automation = await deps.automationRepo.findByKey(
    workItem.projectId,
    target.automation,
    tx,
  );
  if (!automation || automation.scope !== "workItem") {
    throw new CoreValidationError(
      `No work-item automation has the key ${target.automation}`,
      "AUTOMATION_NOT_FOUND",
    );
  }
  if (workItem.state === "closed") {
    return { outcome: "skipped: the work item is closed" };
  }
  const attached = await attachAutomation(
    workItem,
    automation,
    { attachedByUserId: SYSTEM_ACTOR_ID, attachedAt: deps.timeProvider.now() },
    deps,
    tx,
  );
  return attached
    ? {
        outcome: `attached ${target.automation}`,
        attached: { workItem, automation },
      }
    : { outcome: "skipped: already attached" };
};

/** Runs one of `automation`'s targets, in `tx` (the caller's savepoint). */
export const executeTarget = async (
  target: AutomationTargetJson,
  automation: AutomationEntity,
  context: AutomationEventContext,
  deps: AutomationRouteDeps,
  tx: DbExecutor,
): Promise<RouteResult> => {
  switch (target.kind) {
    case "step":
      return await startStep(target, automation, context, deps, tx);
    case "pipeline":
      return await startPipeline(target, automation, context, deps, tx);
    case "attach":
      return await attach(target, context, deps, tx);
    case "skip":
      return { outcome: "skipped" };
  }
};
