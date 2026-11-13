import type { GatheredInbox, InboxSection } from "./gather-inbox";
import type { InboxWait } from "./lib/inbox-api-types";
import { shortId } from "./lib/short-id";
import { looseStatusGlyph } from "./lib/status-glyphs";
import type { TaskSummary } from "./lib/task-api-types";

/** Text rendering for `scarn inbox`: the counts, then each list with the
 * command that acts on or digs into every entry. */

/** How many notifications the text view lists; `--json` keeps them all. */
const NOTIFICATION_LIMIT = 10;

function firstLine(text: string): string {
  const line = text.split("\n").find((part) => part.trim() !== "") ?? "";
  return line.length > 100 ? `${line.slice(0, 99)}…` : line;
}

function sectionLines<T>(
  title: string,
  section: InboxSection<T[]>,
  render: (item: T) => string[],
  total?: number,
): string[] {
  if (section.status === "unavailable") {
    return ["", `${title}: (unavailable: ${section.reason})`];
  }
  const items = section.data;
  if (items.length === 0) return [];
  const count =
    total === undefined || total === items.length
      ? String(items.length)
      : `${String(items.length)} of ${String(total)}`;
  return ["", `${title} (${count})`, ...items.flatMap(render)];
}

function waitLines(wait: InboxWait): string[] {
  const item = wait.workItem;
  const head = `${item.platformKey}  ${item.title}`;
  const where = `      ${wait.pipelineName} / ${wait.nodeId}  run ${wait.pipelineExecutionId}  asked ${wait.askedAt}`;
  if (wait.kind === "reply") {
    return [
      `  ‼ question  ${head}`,
      where,
      `      ${firstLine(wait.body)}`,
      `      → scarn work-items view ${item.id}`,
      `      → scarn work-items answer ${item.id} ${wait.questionId} --body <text>`,
    ];
  }
  const actions = wait.actions.map((action) => action.key).join(", ");
  return [
    `  ‼ decision  ${head}${wait.title === null ? "" : `  "${wait.title}"`}`,
    where,
    `      actions: ${actions || "(none)"}`,
    `      → scarn runs list --work-item ${item.id}`,
  ];
}

function taskLines(task: TaskSummary): string[] {
  const name = task.name ?? task.source.kind;
  const workItem =
    task.workItem === null
      ? ""
      : `  ${task.workItem.platformKey} ${task.workItem.title}`;
  const lines = [
    `  ${looseStatusGlyph(task.status)} ${shortId(task.id)}  ${name}${workItem}`,
    `      ${task.id}  ${task.status}  created ${task.createdAt}`,
  ];
  if (task.latest !== null) {
    lines.push(`      ${task.latest.kind}: ${firstLine(task.latest.text)}`);
  }
  lines.push(
    task.pipelineRunId !== null && task.nodeId !== null
      ? `      → scarn runs thread ${task.pipelineRunId} --step ${task.nodeId}`
      : `      → scarn tasks view ${task.id}`,
  );
  return lines;
}

function taskPageSection(
  title: string,
  section: GatheredInbox["tasksWaitingOnMe"],
): string[] {
  return sectionLines(
    title,
    section.status === "loaded"
      ? { status: "loaded", data: section.data.tasks }
      : section,
    taskLines,
  );
}

export function formatInbox(gathered: GatheredInbox): string {
  const { summary } = gathered;
  const lines = [
    `Inbox: ${String(summary.badgeCount)} waiting on you`,
    `  Tasks waiting on you      ${String(summary.waitingOnMe)}`,
    `  Pipeline waits on you     ${String(summary.pipelineWaitsOnMe)}`,
    `  Failed Tasks you started  ${String(summary.failedStartedByMe)}`,
    `  Work items to start       ${String(summary.workItemsWaitingOnMe)}`,
    `  Tasks waiting on others   ${String(summary.waitingOnOthers)}`,
  ];
  const countLines = lines.length;

  const { waits } = gathered;
  lines.push(
    ...sectionLines(
      "Pipeline waits",
      waits.status === "loaded"
        ? { status: "loaded", data: waits.data.waits }
        : waits,
      waitLines,
    ),
    ...taskPageSection("Tasks waiting on you", gathered.tasksWaitingOnMe),
    ...taskPageSection("Failed Tasks you started", gathered.failedTasks),
  );

  const { drafts } = gathered;
  lines.push(
    ...sectionLines(
      "Comment drafts to approve",
      drafts.status === "loaded"
        ? { status: "loaded", data: drafts.data.items }
        : drafts,
      (item) => [
        `  ○ ${item.platformKey}  ${item.title}  ${String(item.awaitingApprovalCount)} draft(s)`,
        `      → scarn work-items comments ${item.id} --drafts`,
      ],
      drafts.status === "loaded" ? drafts.data.pagination.total : undefined,
    ),
  );

  if (waits.status === "loaded") {
    lines.push(
      ...sectionLines(
        "Work items to start",
        { status: "loaded", data: waits.data.workItems },
        (item) => [
          `  ○ ${item.platformKey}  ${item.title}  ready since ${item.waitingSince}`,
          `      → scarn work-items view ${item.id}`,
        ],
      ),
    );
  }

  const { notifications } = gathered;
  const shownNotifications =
    notifications.status === "loaded"
      ? {
          status: "loaded" as const,
          data: notifications.data.slice(0, NOTIFICATION_LIMIT),
        }
      : notifications;
  lines.push(
    ...sectionLines(
      "Latest notifications",
      shownNotifications,
      (notification) => [
        `  ${looseStatusGlyph(notification.status)} ${notification.kind}  ${notification.title}`,
        `      ${notification.id}  ${notification.priority}  ${notification.createdAt}`,
        ...(notification.workItemId === null
          ? []
          : [`      → scarn work-items view ${notification.workItemId}`]),
      ],
      notifications.status === "loaded" ? notifications.data.length : undefined,
    ),
  );

  if (lines.length === countLines) {
    lines.push("", "Nothing is waiting on you.");
  }
  lines.push("", "→ scarn runs list --status waiting", "→ scarn tasks list");
  return lines.join("\n");
}
