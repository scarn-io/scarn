import type { AnyJsonObject } from "@scarn/core/common/contracts/json";
import type {
  AutomationContract,
  AutomationScheduleSummaryContract,
  AutomationVersionContract,
  WorkItemAutomationContract,
} from "../contracts/automation-contracts";
import type { AutomationVersionEntity } from "../domain/automation-version-entity";
import type { ResolvedAutomation } from "./automation-repo";
import type { AutomationScheduleSummaryRecord } from "./automation-schedule-repo";
import type { ResolvedWorkItemAutomation } from "./work-item-automation-repo";

const requiredIsoString = (value: Date | null | undefined): string =>
  value?.toISOString() ?? new Date(0).toISOString();

const automationVersionToContract = (
  version: AutomationVersionEntity,
): AutomationVersionContract => ({
  id: version.id,
  version: version.version,
  schemaVersion: version.schemaVersion,
  contentHash: version.contentHash,
  document: version.document as unknown as AnyJsonObject,
  publishedAt: version.publishedAt.toISOString(),
});

export const automationToContract = ({
  automation,
  latestVersion,
}: ResolvedAutomation): AutomationContract => ({
  id: automation.id,
  projectId: automation.projectId,
  key: automation.key,
  title: automation.title,
  scope: automation.scope,
  enabled: automation.enabled,
  latestVersion: latestVersion
    ? automationVersionToContract(latestVersion)
    : null,
  createdAt: requiredIsoString(automation.createdAt),
  updatedAt: requiredIsoString(automation.updatedAt),
});

/** `nextRunAt` reads `null` while the automation is disabled: the tick won't fire it. */
export const automationScheduleSummaryToContract = (
  { schedule, lastTask, failureStreak }: AutomationScheduleSummaryRecord,
  automationEnabled: boolean,
): AutomationScheduleSummaryContract => ({
  id: schedule.id,
  key: schedule.key,
  cron: schedule.cron,
  timezone: schedule.timezone,
  concurrency: schedule.concurrency,
  nextRunAt: automationEnabled ? schedule.nextRunAt.toISOString() : null,
  lastFiredAt: schedule.lastFiredAt?.toISOString() ?? null,
  lastTask: lastTask
    ? {
        id: lastTask.id,
        status: lastTask.status,
        scheduledFor: lastTask.scheduledFor.toISOString(),
      }
    : null,
  failureStreak,
  lastSkippedAt: schedule.lastSkippedAt?.toISOString() ?? null,
  skippedCountSinceFire: schedule.skippedCountSinceFire,
  lastError:
    schedule.lastError !== null && schedule.lastErrorAt !== null
      ? {
          message: schedule.lastError,
          at: schedule.lastErrorAt.toISOString(),
        }
      : null,
});

export const workItemAutomationToContract = (
  resolved: ResolvedWorkItemAutomation,
): WorkItemAutomationContract => ({
  workItemId: resolved.attachment.workItemId,
  automation: automationToContract(resolved),
  attachedByUserId: resolved.attachment.attachedByUserId,
  attachedAt: resolved.attachment.attachedAt.toISOString(),
});
