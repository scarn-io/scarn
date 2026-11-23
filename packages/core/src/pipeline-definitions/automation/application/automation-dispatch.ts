import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { WorkItemActivityRepo } from "@scarn/core/work-items/work-item-activity/application/work-item-activity-repo";
import { WorkItemActivityEntry } from "@scarn/core/work-items/work-item-activity/domain/work-item-activity-entry";
import type { AutomationTargetJson } from "@scarn/sdk/contracts/automation-document";
import { noopLogger, type Logger } from "@scarn/observability/logging";
import type { AutomationEntity } from "../domain/automation-entity";
import type { ResolvedAutomation } from "./automation-repo";
import {
  selectTargets,
  type WorkItemEventContext,
} from "./automation-event-context";
import {
  executeTarget,
  type AutomationRouteDeps,
  type RouteResult,
} from "./automation-route-executor";

/**
 * How many `attach` → `self.attached` hops one event may cause. An attached
 * automation's `self.attached` rules can't attach (only project automations
 * can), so real chains are one hop; the limit guards against loops anyway.
 */
export const MAX_AUTOMATION_DEPTH = 3;

export type AutomationDispatchDeps = AutomationRouteDeps & {
  workItemActivityRepo: WorkItemActivityRepo;
  logger?: Logger | undefined;
};

/** Runs `self.attached` for a new attachment, one hop deeper. */
export type OnAttached = (
  attached: NonNullable<RouteResult["attached"]>,
  depth: number,
  tx: DbExecutor,
) => Promise<void>;

// eslint-disable-next-line local/no-unknown-parameter-type -- a caught error has no known shape
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const logLine = async (
  automation: AutomationEntity,
  ruleNumber: number,
  context: WorkItemEventContext,
  outcome: string,
  deps: AutomationDispatchDeps,
  tx: DbExecutor,
): Promise<void> => {
  await deps.workItemActivityRepo.append(
    WorkItemActivityEntry.create({
      projectId: context.workItem.projectId,
      workItemId: context.workItem.id,
      kind: "automation",
      message: `Automation ${automation.key} · ${context.event} · rule ${String(ruleNumber)}: ${outcome}`,
      createdAt: deps.timeProvider.now(),
    }),
    tx,
  );
};

/**
 * Runs every rule of the automation's latest version whose event is the
 * context's, in source order. Each target runs in its own savepoint: one
 * that throws is rolled back and logged as `failed: …`, and neither the
 * change that raised the event nor the other rules roll back. Every target
 * logs one line on the activity of the work item the rule is about.
 */
export const runAutomation = async (
  { automation, latestVersion }: ResolvedAutomation,
  context: WorkItemEventContext,
  depth: number,
  onAttached: OnAttached,
  deps: AutomationDispatchDeps,
  tx: DbExecutor,
): Promise<void> => {
  if (!latestVersion) {
    return;
  }
  const logger = deps.logger ?? noopLogger;
  for (const [index, rule] of latestVersion.document.rules.entries()) {
    if (rule.event !== context.event) {
      continue;
    }
    const ruleNumber = index + 1;
    let targets: AutomationTargetJson[];
    try {
      targets = selectTargets(rule, context);
    } catch (error) {
      await logLine(
        automation,
        ruleNumber,
        context,
        `failed: ${errorMessage(error)}`,
        deps,
        tx,
      );
      continue;
    }
    for (const target of targets) {
      let result: RouteResult;
      try {
        result = await tx.transaction(
          async (savepoint) =>
            await executeTarget(target, automation, context, deps, savepoint),
        );
      } catch (error) {
        logger.warn(
          {
            err: error,
            automation: automation.key,
            event: context.event,
            rule: ruleNumber,
          },
          "Automation route failed",
        );
        result = { outcome: `failed: ${errorMessage(error)}` };
      }
      await logLine(automation, ruleNumber, context, result.outcome, deps, tx);
      if (result.attached) {
        await onAttached(result.attached, depth + 1, tx);
      }
    }
  }
};
