import type { AnyJsonValue } from "@scarn/core/common/contracts/json";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { conversationPreview } from "@scarn/core/conversations/conversation/domain/repo-conversation-state";
import { oneLine } from "@scarn/core/tasks/task/application/task-summary-mapper";
import { namedRunError } from "@scarn/core/tasks/task/domain/run-error";
import type { TaskStatus } from "@scarn/core/tasks/task/domain/task-entity";
import type { TaskRunStatus } from "@scarn/core/tasks/task-run/domain/task-run-entity";
import type {
  ProjectRunType,
  ProjectRunWhatRan,
} from "../contracts/project-runs-contracts";

/** A row's link, relative to the project. */
export const projectRunHref = (type: ProjectRunType, id: UuidV7): string => {
  switch (type) {
    case "pipeline":
      return `runs/${id}`;
    case "step":
    case "task":
      return `runs/tasks/${id}`;
  }
};

/** What a standalone Task's row is built from. */
export type StandaloneTaskFacts = {
  /** The step definition the Task runs; null for a prompt or code Task. */
  stepDefinition: { id: UuidV7; name: string } | null;
  /** An agent Task's prompt; null for a code Task. */
  prompt: string | null;
  workItemTitle: string;
};

/** `step` when the Task runs a step definition, else `task`. */
export const standaloneTaskType = (
  task: Pick<StandaloneTaskFacts, "stepDefinition">,
): "step" | "task" => (task.stepDefinition ? "step" : "task");

export const standaloneTaskWhatRan = (
  task: Pick<StandaloneTaskFacts, "stepDefinition">,
): ProjectRunWhatRan =>
  task.stepDefinition
    ? {
        kind: "step",
        id: task.stepDefinition.id,
        name: task.stepDefinition.name,
      }
    : { kind: "task", name: "Task" };

const firstLine = (text: string): string | null => {
  const line = text
    .split("\n")
    .map((part) => part.trim())
    .find(Boolean);
  return line ? oneLine(line) : null;
};

/**
 * A prompt Task's title is its prompt's first line; a step or code Task's,
 * or a prompt Task with a blank prompt, is its work item's title.
 */
export const standaloneTaskTitle = (task: StandaloneTaskFacts): string =>
  (!task.stepDefinition && task.prompt !== null
    ? firstLine(task.prompt)
    : null) ?? task.workItemTitle;

/**
 * A failed Task's error code: the named error of its latest run, as a
 * `retry` or `catch` entry would match it. Null unless the Task failed.
 */
export const standaloneTaskOutcome = ({
  status,
  latestRun,
}: {
  status: TaskStatus;
  latestRun: { status: TaskRunStatus; errorJson: AnyJsonValue | null } | null;
}): string | null =>
  status === "failed"
    ? namedRunError(latestRun ?? { status: "failed", errorJson: null }).name
    : null;

/**
 * A scheduled Task's title when it has no prompt line to show: its
 * automation and rule, as `Automation title · ruleKey`.
 */
export const scheduledTaskTitle = (
  automation: { key: string; title: string | null } | null,
  schedule: { key: string } | null,
): string =>
  [automation ? (automation.title ?? automation.key) : null, schedule?.key]
    .filter(Boolean)
    .join(" · ");

/**
 * A Task without a work item's title: its conversation's first person
 * message, previewed as the Conversations list does.
 */
export const conversationTaskTitle = (
  firstPersonMessage: string | null,
): string => conversationPreview(firstPersonMessage);

/** A Task without a work item's status line: its last agent message on one line, or nothing yet. */
export const conversationTaskStatusLine = (
  lastAgentMessage: string | null,
): string => (lastAgentMessage ? oneLine(lastAgentMessage) : "");
