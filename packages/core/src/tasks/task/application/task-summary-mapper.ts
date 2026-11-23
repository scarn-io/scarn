import { assertNever } from "@scarn/core/lib/assert-never";
import { toStartedBy } from "@scarn/core/common/contracts/started-by";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UsernameReader } from "@scarn/core/organizations/organization/application/username-reader";
import {
  TASK_PROMPT_PREVIEW_LENGTH,
  type TaskSummaryContract,
} from "../contracts/task-summary-contracts";
import type { TaskSummaryRecord } from "./task-summary-reader";

const previewPrompt = (prompt: string | null): string | null => {
  if (prompt === null) {
    return null;
  }
  const trimmed = prompt.trim();
  return trimmed.length > TASK_PROMPT_PREVIEW_LENGTH
    ? `${trimmed.slice(0, TASK_PROMPT_PREVIEW_LENGTH - 1)}…`
    : trimmed;
};

const LATEST_LENGTH = 280;

/** `text` with its whitespace collapsed, cut to a list row's length. */
export const oneLine = (text: string): string => {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > LATEST_LENGTH
    ? `${collapsed.slice(0, LATEST_LENGTH - 1)}…`
    : collapsed;
};

const lastNonEmptyLine = (text: string): string | null =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) ?? null;

/**
 * A failed Task's error; a running agent's live log line, else its last
 * message; a code or MCP tool Task's last log line.
 */
export const taskLatestOf = (
  record: TaskSummaryRecord,
): TaskSummaryContract["latest"] => {
  if (record.status === "failed" && record.errorMessage) {
    return { kind: "error", text: oneLine(record.errorMessage) };
  }
  const log = record.lastLogText ? lastNonEmptyLine(record.lastLogText) : null;
  const logLatest = log ? { kind: "log" as const, text: oneLine(log) } : null;
  if (record.kind !== "agent") return logLatest;
  const message = record.lastAgentMessage
    ? { kind: "message" as const, text: oneLine(record.lastAgentMessage) }
    : null;
  return record.status === "running"
    ? (logLatest ?? message)
    : (message ?? logLatest);
};

const sourceOf = (record: TaskSummaryRecord): TaskSummaryContract["source"] => {
  if (record.stepDefinition) {
    return {
      kind: "step_definition",
      stepDefinitionId: record.stepDefinition.id,
      key: record.stepDefinition.key,
      name: record.stepDefinition.name,
      version: record.stepDefinition.version,
    };
  }
  switch (record.kind) {
    case "code":
      return { kind: "code", name: record.name };
    case "mcp_tool":
      return { kind: "mcp_tool", name: record.name };
    case "agent":
      return {
        kind: "prompt",
        promptPreview: previewPrompt(record.prompt) ?? "",
      };
    default:
      return assertNever(record.kind);
  }
};

/**
 * Resolves the starters' and waited-on people's usernames in one read and
 * maps each record as `viewerUserId` sees it: `waitingOnYou` is true only
 * when the Task's conversation waits on the viewer.
 */
export const taskSummariesToContracts = async (
  records: readonly TaskSummaryRecord[],
  viewerUserId: UuidV7,
  usernameReader: UsernameReader,
  dbExecutor?: DbExecutor,
): Promise<TaskSummaryContract[]> => {
  const usersById = await usernameReader.loadUsernamesByUserId(
    records.flatMap((record) =>
      record.startedByUserId === null
        ? record.waitingOnUserIds
        : [record.startedByUserId, ...record.waitingOnUserIds],
    ),
    dbExecutor,
  );
  return records.map((record) => {
    return {
      id: record.id,
      projectId: record.projectId,
      kind: record.kind,
      name: record.name,
      status: record.status,
      waitingOnYou: record.waitingOnUserIds.includes(viewerUserId),
      waitingOn: record.waitingOnUserIds.map((userId) => ({
        userId,
        username: usersById.get(userId)?.username ?? null,
      })),
      conversationId: record.conversationId,
      workItem: record.workItem,
      repoConversation: record.repoConversation,
      startedBy: toStartedBy(
        {
          userId: record.startedByUserId,
          automation: record.startedByAutomation,
          schedule: record.startedBySchedule,
        },
        usersById,
      ),
      scheduledFor: record.scheduledFor?.toISOString() ?? null,
      source: sourceOf(record),
      pipelineRunId: record.pipelineRunId,
      nodeId: record.nodeId,
      pipelineRun: record.pipelineRun,
      runNumber: record.runNumber,
      durationMs: record.durationMs,
      latest: taskLatestOf(record),
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  });
};
