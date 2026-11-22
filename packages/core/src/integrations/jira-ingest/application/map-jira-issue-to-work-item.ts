import type { UpsertWorkItemInput } from "@scarn/core/work-items/work-item/contracts/work-item-contracts";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { WorkItemState } from "@scarn/core/work-items/work-item/domain/work-item-state";
import type { JiraIssue } from "../infra/jira-issues-client";

// Jira returns offsets like +0000 (no colon); normalize to +00:00
function normalizeJiraDatetime(value: string | undefined): string | null {
  if (!value) return null;
  return new Date(value).toISOString();
}

// Atlassian Document Format → plain text (best-effort)
// eslint-disable-next-line local/no-unknown-parameter-type
function adfToPlainText(adf: unknown): string {
  if (!adf || typeof adf !== "object") return "";
  const node = adf as { type?: string; text?: string; content?: unknown[] };
  if (node.type === "text" && typeof node.text === "string") return node.text;
  if (Array.isArray(node.content)) {
    return node.content.map(adfToPlainText).join("");
  }
  return "";
}

// eslint-disable-next-line local/no-unknown-parameter-type
function extractCustomFieldValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const extracted = value
      .map(extractCustomFieldValue)
      .filter((v) => v !== null);
    return extracted.length > 0 ? extracted : null;
  }
  const obj = value as Record<string, unknown>;
  if (obj["type"] === "doc") {
    const text = adfToPlainText(obj).trim();
    return text || null;
  }
  if (typeof obj["name"] === "string") return obj["name"];
  if (typeof obj["value"] === "string") return obj["value"];
  if (typeof obj["displayName"] === "string") return obj["displayName"];
  return null;
}

// eslint-disable-next-line local/no-unknown-parameter-type
function jiraStatusToWorkItemState(status: unknown): WorkItemState {
  const categoryKey = (status as { statusCategory?: { key?: string } } | null)
    ?.statusCategory?.key;
  return categoryKey === "done" ? "closed" : "open";
}

export function mapJiraIssueToWorkItem(
  projectId: UuidV7,
  baseUrl: string,
  issue: JiraIssue,
  fieldNameMap: Map<string, string>,
): UpsertWorkItemInput {
  const base = baseUrl.replace(/\/$/, "");
  const f = issue.fields;

  const customFields: Record<string, unknown> = {};
  for (const [id, prettyName] of fieldNameMap) {
    const value = extractCustomFieldValue(f[id]);
    if (value !== null) {
      customFields[prettyName] = value;
    }
  }

  return {
    projectId,
    platform: "jira",
    platformId: issue.id,
    platformKey: issue.key,
    url: `${base}/browse/${issue.key}`,
    title: f["summary"] as string,
    description: f["description"]
      ? adfToPlainText(f["description"]) || "(No description provided.)"
      : "(No description provided.)",
    sourceCreatedAt: normalizeJiraDatetime(f["created"] as string | undefined),
    sourceUpdatedAt: normalizeJiraDatetime(f["updated"] as string | undefined),
    state: jiraStatusToWorkItemState(f["status"]),
    labels: (f["labels"] as string[] | null | undefined) ?? [],
    fields: {
      status: (f["status"] as { name: string })["name"],
      priority: (f["priority"] as { name?: string } | null)?.["name"] ?? null,
      issueType:
        (f["issuetype"] as { name?: string } | null)?.["name"] ??
        (f["issueType"] as { name?: string } | null)?.["name"] ??
        null,
      assignee:
        (f["assignee"] as { displayName?: string } | null)?.["displayName"] ??
        null,
      reporter:
        (f["reporter"] as { displayName?: string } | null)?.["displayName"] ??
        null,
      commentsCount:
        (f["comment"] as { total?: number } | null)?.["total"] ?? 0,
      ...customFields,
    },
  };
}
