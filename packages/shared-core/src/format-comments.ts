import type {
  WorkItemComment,
  WorkItemCommentDraft,
} from "./lib/work-item-api-types";

export type FormatCommentsInput = {
  workItemId: string;
  comments: readonly WorkItemComment[];
  /** How many comments exist in total, before `--limit` kept the latest. */
  total: number;
};

function author(comment: WorkItemComment): string {
  const name = comment.authorUsername ?? comment.authorName ?? "unknown";
  return comment.authorKind === "agent" ? `${name} (agent)` : `@${name}`;
}

function indentBody(body: string): string[] {
  return body
    .trim()
    .split("\n")
    .map((line) => `    ${line}`);
}

function hiddenNote(shown: number, total: number): string[] {
  return total > shown
    ? [`  … ${String(total - shown)} earlier not shown; raise --limit`]
    : [];
}

/**
 * `work-items comments`: the work item's comments oldest first, each with
 * its author, timestamp and full id, then its body indented beneath.
 */
export function formatComments(input: FormatCommentsInput): string {
  const { workItemId, comments, total } = input;
  if (comments.length === 0) {
    return [
      `No comments on work item ${workItemId}.`,
      "",
      `→ scarn work-items comments ${workItemId} --drafts`,
    ].join("\n");
  }

  const lines = [
    `Comments on work item ${workItemId} (${String(comments.length)} of ${String(total)})`,
    ...hiddenNote(comments.length, total),
  ];
  for (const comment of comments) {
    const flags = [
      comment.isPinned ? "pinned" : null,
      comment.parentCommentId === null
        ? null
        : `reply to ${comment.parentCommentId}`,
      comment.authoredByTaskId === null
        ? null
        : `task ${comment.authoredByTaskId}`,
    ].filter((flag): flag is string => flag !== null);
    lines.push(
      "",
      `  ${comment.createdAt}  ${author(comment)}  ${comment.id}${flags.length === 0 ? "" : `  (${flags.join(", ")})`}`,
    );
    if (comment.externalCommentUrl !== null) {
      lines.push(`    ${comment.externalCommentUrl}`);
    }
    lines.push(...indentBody(comment.body));
  }
  lines.push("", `→ scarn work-items activity ${workItemId}`);
  return lines.join("\n");
}

export type FormatCommentDraftsInput = {
  workItemId: string;
  drafts: readonly WorkItemCommentDraft[];
  total: number;
};

/**
 * `work-items comments --drafts`: agent-written comments waiting for a
 * person to approve them before they post to the tracker.
 */
export function formatCommentDrafts(input: FormatCommentDraftsInput): string {
  const { workItemId, drafts, total } = input;
  if (drafts.length === 0) {
    return [
      `No pending comment drafts on work item ${workItemId}.`,
      "",
      `→ scarn work-items comments ${workItemId}`,
    ].join("\n");
  }

  const lines = [
    `Pending comment drafts on work item ${workItemId} (${String(drafts.length)} of ${String(total)})`,
    ...hiddenNote(drafts.length, total),
  ];
  for (const { notification, lastError } of drafts) {
    lines.push(
      "",
      `  ${notification.createdAt}  ${notification.id}  ${notification.status}  ${notification.title}`,
    );
    if (notification.pipelineExecutionId !== null) {
      lines.push(`    run ${notification.pipelineExecutionId}`);
    }
    if (notification.taskId !== null) {
      lines.push(`    task ${notification.taskId}`);
    }
    if (lastError !== null) lines.push(`    last error: ${lastError}`);
    lines.push(...indentBody(notification.body));
  }
  const fromRun = drafts.some(
    (draft) => draft.notification.pipelineExecutionId !== null,
  );
  lines.push(
    "",
    fromRun
      ? `→ scarn runs list --work-item ${workItemId}`
      : `→ scarn work-items comments ${workItemId}`,
  );
  return lines.join("\n");
}
