import type { GatheredWorkItem, WorkItemSection } from "./gather-work-item";
import { shortId } from "./lib/short-id";
import { looseStatusGlyph } from "./lib/status-glyphs";
import type {
  WorkItemDetail,
  WorkItemListPage,
} from "./lib/work-item-api-types";

/** How many description lines `work-items view` prints before eliding. */
export const DESCRIPTION_PREVIEW_LINES = 20;

const dash = (value: string | null | undefined): string =>
  value === null || value === undefined || value === "" ? "—" : value;

function indent(text: string, prefix = "    "): string[] {
  return text.split("\n").map((line) => `${prefix}${line}`);
}

function formatState(item: WorkItemDetail): string {
  if (item.state === "open") return "open";
  const reason = item.closeReason === null ? "" : ` (${item.closeReason})`;
  const resolution = item.resolution === null ? "" : `: ${item.resolution}`;
  return `closed${reason}${resolution}`;
}

/**
 * `work-items list`: one entry per work item (status glyph, short id,
 * platform key, title, then the full id and its state on a second line),
 * ending with the command to open one.
 */
export function formatWorkItemList(page: WorkItemListPage): string {
  const { items, pagination } = page;
  if (items.length === 0) return "No work items match.";

  const lines = [
    `Work items (${String(items.length)} of ${String(pagination.total)})`,
  ];
  for (const item of items) {
    const glyph = looseStatusGlyph(item.latestExecutionStatus ?? item.state);
    lines.push(
      `  ${glyph} ${shortId(item.id)}  ${item.platformKey}  ${item.title}`,
    );
    const assignee =
      item.assignee === null
        ? "unassigned"
        : `@${item.assignee.username ?? item.assignee.userId}`;
    const labels =
      item.labels.length === 0 ? "" : `  [${item.labels.join(", ")}]`;
    lines.push(
      `      ${item.id}  ${formatState(item)}  run: ${dash(item.latestExecutionStatus)}  ${assignee}  updated ${item.updatedAt}${labels}`,
    );
  }
  if (pagination.total > items.length) {
    lines.push(
      `  … ${String(pagination.total - items.length)} more; raise --limit or narrow the filters`,
    );
  }
  lines.push("", `→ scarn work-items view ${items[0]?.id ?? "<id>"}`);
  return lines.join("\n");
}

function formatHeader(item: WorkItemDetail): string[] {
  const lines = [
    `Work item ${item.id}`,
    `Title:      ${item.title}`,
    `Key:        ${item.platform} ${item.platformKey}`,
    `URL:        ${dash(item.url)}`,
    `State:      ${formatState(item)}`,
    `Labels:     ${item.labels.length === 0 ? "—" : item.labels.join(", ")}`,
    `Assignee:   ${dash(item.assigneeUserId)}`,
    `Created by: ${dash(item.createdByUsername)}`,
    `Parent:     ${dash(item.parentWorkItemId)}`,
    `Project:    ${item.projectId}`,
    `Created:    ${item.createdAt}`,
    `Updated:    ${item.updatedAt}`,
  ];
  if (item.closedAt !== null) lines.push(`Closed:     ${item.closedAt}`);

  const fields = Object.entries(item.fields ?? {});
  if (fields.length > 0) {
    lines.push("", "Fields:");
    for (const [key, value] of fields) {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      lines.push(`  ${key}: ${text}`);
    }
  }

  lines.push("", "Description:");
  const description = item.description.trim();
  if (description === "") {
    lines.push("  (empty)");
  } else {
    const descriptionLines = description.split("\n");
    lines.push(
      ...indent(
        descriptionLines.slice(0, DESCRIPTION_PREVIEW_LINES).join("\n"),
        "  ",
      ),
    );
    const hidden = descriptionLines.length - DESCRIPTION_PREVIEW_LINES;
    if (hidden > 0) {
      lines.push(`  … ${String(hidden)} more lines (--json for the full text)`);
    }
  }
  return lines;
}

function formatSection<T>(
  title: string,
  section: WorkItemSection<T>,
  render: (data: T) => string[],
): string[] {
  if (section.status === "unavailable") {
    return ["", `${title}: (unavailable: ${section.reason})`];
  }
  const body = render(section.data);
  return ["", `${title}:`, ...(body.length === 0 ? ["  (none)"] : body)];
}

function formatSections(gathered: GatheredWorkItem): string[] {
  return [
    ...formatSection("Blocks", gathered.blocks, (blocks) => [
      ...blocks.blockedBy.map(
        (block) => `  blocked by ${block.blockingWorkItemId}`,
      ),
      ...blocks.blocking.map(
        (block) => `  blocking   ${block.blockedWorkItemId}`,
      ),
    ]),
    ...formatSection("Children", gathered.children, (children) =>
      children.map(
        (child) =>
          `  ${looseStatusGlyph(child.status)} ${child.id}  ${child.platformKey}  ${child.title}  ${child.status}`,
      ),
    ),
    ...formatSection("Questions", gathered.questions, (questions) =>
      questions.flatMap((question) => [
        `  ${looseStatusGlyph(question.status)} ${question.questionId}  ${question.status}  asked ${question.askedAt}  run ${question.pipelineExecutionId}`,
        ...indent(question.body.trim()),
      ]),
    ),
    ...formatSection("Latest runs", gathered.runs, (page) =>
      page.items.map(
        (run) =>
          `  ${looseStatusGlyph(run.status)} ${run.id}  ${run.status}${run.waitingFor === null ? "" : ` (waiting for ${run.waitingFor})`}  started ${dash(run.startedAt)}`,
      ),
    ),
    ...formatSection("Latest Tasks", gathered.tasks, (page) =>
      page.tasks.flatMap((task) => {
        const name =
          task.name ??
          (task.pipelineRun === null
            ? task.kind
            : `${task.pipelineRun.name} #${String(task.pipelineRun.number)}`);
        const line = `  ${looseStatusGlyph(task.status)} ${task.id}  ${name}  ${task.status}  created ${task.createdAt}`;
        return task.latest === null
          ? [line]
          : [line, `      ${task.latest.kind}: ${task.latest.text}`];
      }),
    ),
  ];
}

function formatNext(gathered: GatheredWorkItem): string[] {
  const { workItem, runs, tasks } = gathered;
  const lines = ["", "Next:"];
  if (runs.status === "loaded" && runs.data.items.length > 0) {
    lines.push(`  → scarn runs list --work-item ${workItem.id}`);
  }
  const task = tasks.status === "loaded" ? tasks.data.tasks[0] : undefined;
  if (task !== undefined) {
    lines.push(`  → scarn tasks view ${task.id}`);
  }
  lines.push(`  → scarn work-items comments ${workItem.id}`);
  lines.push(`  → scarn work-items activity ${workItem.id}`);
  return lines;
}

/**
 * `work-items view`: the work item's fields, state, labels and parent, then
 * one section per sub-read (a failed one renders as a single
 * `(unavailable: <reason>)` line), ending with the commands to dig further.
 */
export function formatWorkItem(gathered: GatheredWorkItem): string {
  return [
    ...formatHeader(gathered.workItem),
    ...formatSections(gathered),
    ...formatNext(gathered),
  ].join("\n");
}
