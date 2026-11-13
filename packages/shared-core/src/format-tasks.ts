import type { GatheredTaskView } from "./gather-tasks";
import type {
  JsonValue,
  TaskDetail,
  TaskRunDetail,
  TaskSource,
  TaskSummary,
  TaskSummaryPage,
  TaskWorkItemRef,
} from "./lib/task-api-types";
import { shortId } from "./lib/short-id";
import { looseStatusGlyph } from "./lib/status-glyphs";

/** Text renderings for `tasks list` and `tasks view`. */

/** Names where a Task's instructions came from, in a few words. */
export function describeTaskSource(source: TaskSource): string {
  switch (source.kind) {
    case "step_definition":
      return `step ${source.key} v${String(source.version)}`;
    case "prompt":
      return `prompt "${source.promptPreview}"`;
    case "code":
      return source.name === null ? "code" : `code ${source.name}`;
  }
}

function describeWorkItem(workItem: TaskWorkItemRef | null): string {
  return workItem === null
    ? "no work item"
    : `${workItem.platformKey}  ${workItem.title}`;
}

/** Pretty-printed JSON, indented under a heading. */
export function indentJson(value: JsonValue, prefix: string): string[] {
  return JSON.stringify(value, null, 2)
    .split("\n")
    .map((line) => `${prefix}${line}`);
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ${String(seconds % 60)}s`;
  return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}m`;
}

function describeSummaryTiming(task: TaskSummary): string {
  const run =
    task.runNumber === null ? "no runs yet" : `run ${String(task.runNumber)}`;
  const duration =
    task.durationMs === null ? "" : `  took ${formatDuration(task.durationMs)}`;
  return `${run}${duration}  created ${task.createdAt}`;
}

export function formatTaskList(page: TaskSummaryPage): string {
  const { tasks } = page;
  if (tasks.length === 0) return "No Tasks match.";

  const lines = [`Tasks (${String(tasks.length)} shown), newest first`];
  for (const task of tasks) {
    lines.push(
      `  ${looseStatusGlyph(task.status)} ${shortId(task.id)}  ${task.kind}  ${describeTaskSource(task.source)}  ${describeWorkItem(task.workItem)}`,
    );
    lines.push(
      `      ${task.id}  ${task.status}  ${describeSummaryTiming(task)}`,
    );
    if (task.pipelineRunId !== null) {
      lines.push(
        `      pipeline run ${task.pipelineRunId}${task.nodeId === null ? "" : ` at step ${task.nodeId}`}`,
      );
    }
    if (task.latest !== null) {
      lines.push(
        `      latest ${task.latest.kind}: ${firstLine(task.latest.text)}`,
      );
    }
  }
  if (page.nextCursor !== null) {
    lines.push("  … more Tasks; raise --limit or narrow the filters");
  }
  lines.push("", `→ scarn tasks view ${tasks[0]?.id ?? "<taskId>"}`);
  return lines.join("\n");
}

function firstLine(text: string): string {
  const [first = "", ...rest] = text.split("\n");
  return rest.length === 0 ? first : `${first} …`;
}

/** One line per run: number, status, reason, ids and timing. */
export function describeRunRow(run: TaskRunDetail): string {
  const timing =
    run.completedAt !== null
      ? `finished ${run.completedAt}`
      : run.startedAt !== null
        ? `started ${run.startedAt}`
        : `created ${run.createdAt}`;
  return `#${String(run.number)} ${looseStatusGlyph(run.status)} ${run.status}  ${run.reason}  ${run.id}  ${timing}`;
}

function headerLines(task: TaskDetail): string[] {
  const lines = [
    `Task ${task.id}  ${looseStatusGlyph(task.status)} ${task.status}`,
    `Kind:         ${task.kind}${task.name === null ? "" : `  ${task.name}`}`,
    `Source:       ${describeTaskSource(task.source)}`,
    `Work item:    ${task.workItem === null ? "none" : `${describeWorkItem(task.workItem)}  ${task.workItem.id}`}`,
  ];
  if (task.source.kind === "step_definition") {
    lines.push(`Step def:     ${task.source.stepDefinitionId}`);
  }
  if (task.pipelineRunId !== null) {
    lines.push(
      `Pipeline run: ${task.pipelineRunId}${task.nodeId === null ? "" : ` at step ${task.nodeId}`}`,
    );
  }
  lines.push(
    `Config:       ${task.taskExecutionConfigId ?? "the repo's own config"}`,
  );
  if (task.maxTurns !== null) {
    lines.push(`Max turns:    ${String(task.maxTurns)}`);
  }
  if (task.startedBy !== null) {
    lines.push(
      `Started by:   ${task.startedBy.username ?? task.startedBy.userId}`,
    );
  }
  if (task.waitingOn.length > 0) {
    lines.push(
      `Waiting on:   ${task.waitingOn.map((person) => person.username ?? person.userId).join(", ")}`,
    );
  }
  if (task.conversationId !== null) {
    lines.push(`Conversation: ${task.conversationId}`);
  }
  lines.push(
    `Created:      ${task.createdAt}`,
    `Updated:      ${task.updatedAt}`,
  );
  return lines;
}

function jsonSection(title: string, value: JsonValue): string[] {
  if (value === null) return [];
  return ["", `${title}:`, ...indentJson(value, "  ")];
}

export function formatTaskView(gathered: GatheredTaskView): string {
  const { task, runs } = gathered;
  const lines = [
    ...headerLines(task),
    ...jsonSection("Input", task.inputJson),
    ...jsonSection("Result", task.resultJson),
    ...jsonSection("Error", task.errorJson),
    "",
  ];

  if (runs.status === "unavailable") {
    lines.push(`Runs: unavailable (${runs.reason})`);
  } else if (runs.data.length === 0) {
    lines.push("Runs: none yet");
  } else {
    lines.push(`Runs (${String(runs.data.length)}), oldest first:`);
    for (const run of runs.data) lines.push(`  ${describeRunRow(run)}`);
  }

  if (task.previousTaskId !== null) {
    lines.push("", "Earlier Tasks of this step, newest first:");
    for (const previous of gathered.previousTasks) {
      lines.push(
        `  ${looseStatusGlyph(previous.status)} ${previous.id}  ${previous.status}  created ${previous.createdAt}`,
      );
    }
    if (gathered.previousTasksCutOff !== null) {
      lines.push(`  … ${gathered.previousTasksCutOff}`);
    }
  }

  lines.push("", ...taskViewHints(gathered));
  return lines.join("\n");
}

/** The latest run's logs and detail, and the step's message thread when a
 * pipeline run created the Task. */
function taskViewHints(gathered: GatheredTaskView): string[] {
  const { task } = gathered;
  const latest =
    gathered.runs.status === "loaded" ? gathered.runs.data.at(-1) : undefined;
  const hints =
    latest === undefined
      ? []
      : [`→ scarn logs ${latest.id}`, `→ scarn task-runs view ${latest.id}`];
  if (task.pipelineRunId !== null && task.nodeId !== null) {
    hints.push(
      `→ scarn runs thread ${task.pipelineRunId} --step ${task.nodeId}`,
    );
  }
  if (hints.length === 0) hints.push(`→ scarn tasks list`);
  return hints;
}
