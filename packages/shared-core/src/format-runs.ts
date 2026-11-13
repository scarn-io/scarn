import type { GatheredRunList, GatheredVisitThread } from "./gather-runs";
import type { RunListItem } from "./lib/run-api-types";
import { shortId } from "./lib/short-id";
import { looseStatusGlyph } from "./lib/status-glyphs";

/** Text renderings for `runs list` and `runs thread`. */

function describeStatus(item: RunListItem): string {
  return item.waitingFor === null
    ? item.status
    : `${item.status} for ${item.waitingFor}`;
}

function describeTiming(item: RunListItem): string {
  if (item.completedAt !== null) return `finished ${item.completedAt}`;
  if (item.startedAt !== null) return `started ${item.startedAt}`;
  return `created ${item.createdAt}`;
}

export function formatRunList(gathered: GatheredRunList): string {
  const { items, pagination } = gathered.page;
  if (items.length === 0) return "No pipeline runs match.";

  const lines = [
    `Pipeline runs (${String(items.length)} of ${String(pagination.total)}), newest first`,
  ];
  for (const item of items) {
    const pipeline =
      gathered.pipelineKeys[item.pipelineDefinitionId] ??
      shortId(item.pipelineDefinitionId);
    lines.push(
      `  ${looseStatusGlyph(item.status)} ${shortId(item.id)}  ${pipeline}  ${item.workItemTitle}`,
    );
    const at =
      item.openNodeIds.length === 0
        ? ""
        : `  at ${item.openNodeIds.join(", ")}`;
    lines.push(
      `      ${item.id}  ${describeStatus(item)}${at}  ${describeTiming(item)}`,
    );
    lines.push(`      work item ${item.workItemId}`);
    if (item.error !== null) {
      lines.push(`      error: ${item.error.name}: ${item.error.message}`);
    }
  }
  if (pagination.total > items.length) {
    lines.push(
      `  … ${String(pagination.total - items.length)} more; raise --limit or narrow the filters`,
    );
  }
  lines.push("", nextThreadHint(items[0]));
  return lines.join("\n");
}

/** Points at the newest run's thread, at its first open step when it has
 * one; otherwise the step key is left for the reader to fill in. */
function nextThreadHint(newest: RunListItem | undefined): string {
  const runId = newest?.id ?? "<runId>";
  const step = newest?.openNodeIds[0] ?? "<key>";
  return `→ scarn runs thread ${runId} --step ${step}`;
}

function indent(text: string, prefix: string): string[] {
  return text.split("\n").map((line) => `${prefix}${line}`);
}

export function formatVisitThread(gathered: GatheredVisitThread): string {
  const { visit, thread } = gathered;
  const lines = [
    `Thread of step "${gathered.stepKey}" in pipeline run ${gathered.runId}`,
    `Visit:   ${visit.id}  ${looseStatusGlyph(visit.status)} ${visit.status}  (attempt ${String(gathered.attemptNumber)} of ${String(gathered.attemptCount)})`,
    `Created: ${visit.createdAt}`,
  ];
  if (thread.runs.length === 0) {
    lines.push("", "No Task runs yet.");
  }
  thread.runs.forEach((run, index) => {
    const restored =
      run.sessionRestored === null
        ? ""
        : run.sessionRestored
          ? "  session restored"
          : "  session not restored";
    lines.push(
      "",
      `Run ${String(index + 1)}  ${looseStatusGlyph(run.status)} ${run.status}  ${run.taskRunId}  ${run.createdAt}${restored}`,
    );
    if (run.messages.length === 0) {
      lines.push("  (no messages)");
    }
    for (const message of run.messages) {
      lines.push(`  ${message.createdAt}  from ${message.authorUserId}`);
      if (message.quoteText !== null) {
        lines.push(...indent(message.quoteText, "    > "));
      }
      lines.push(...indent(message.body, "    "));
    }
  });
  const latestRun = thread.runs.at(-1);
  const latestTask = visit.tasks.at(-1);
  lines.push(
    "",
    latestRun !== undefined
      ? `→ scarn logs ${latestRun.taskRunId}`
      : latestTask !== undefined
        ? `→ scarn tasks view ${latestTask.taskId}`
        : `→ scarn runs list`,
  );
  return lines.join("\n");
}
