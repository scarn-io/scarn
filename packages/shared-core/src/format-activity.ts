import type { WorkItemActivityEntry } from "./lib/work-item-api-types";

export type FormatActivityInput = {
  workItemId: string;
  entries: readonly WorkItemActivityEntry[];
  /** How many entries exist in total, before `--limit` kept the latest. */
  total: number;
};

/**
 * `work-items activity`: the work item's activity log oldest first, one
 * line per entry (timestamp, kind, message), ending with the command to read
 * its comments.
 */
export function formatActivity(input: FormatActivityInput): string {
  const { workItemId, entries, total } = input;
  if (entries.length === 0) {
    return [
      `No activity on work item ${workItemId}.`,
      "",
      `→ scarn work-items view ${workItemId}`,
    ].join("\n");
  }

  const lines = [
    `Activity on work item ${workItemId} (${String(entries.length)} of ${String(total)})`,
  ];
  if (total > entries.length) {
    lines.push(
      `  … ${String(total - entries.length)} earlier not shown; raise --limit`,
    );
  }
  for (const entry of entries) {
    const [first = "", ...rest] = entry.message.trim().split("\n");
    lines.push(`  ${entry.createdAt}  ${entry.kind}  ${first}`);
    for (const line of rest) lines.push(`      ${line}`);
  }
  lines.push("", `→ scarn work-items comments ${workItemId}`);
  return lines.join("\n");
}
