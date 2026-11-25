/**
 * `mapJiraIssue`: one Jira issue (REST `search/jql` or the Atlassian MCP
 * server's `searchJiraIssuesUsingJql` node) to a work item. Shared by the
 * server's manual Jira sync and `jiraIssueImport`, so both write the same
 * item for the same issue.
 */
import { z } from "zod";

/**
 * The parts of a Jira issue the mapper reads. `fields` is keyed by Jira's
 * field ids (`summary`, `status`, `customfield_10016`, …) with their REST
 * shapes; `description` and ADF custom fields are ADF JSON.
 */
export const jiraIssueSchema = z.object({
  id: z.string(),
  key: z.string(),
  fields: z.record(z.string(), z.unknown()),
});
export type JiraIssue = z.infer<typeof jiraIssueSchema>;

export type MapJiraIssueOptions = {
  /** The Jira site's base URL, e.g. `https://acme.atlassian.net`. */
  readonly site: string;
  /**
   * Custom field id → display name (`customfield_10016` → `Story Points`).
   * Each listed field with a value lands in `fields` under its name. Leave
   * it out when the names aren't known; no custom fields are mapped then.
   */
  readonly fieldNames?: ReadonlyMap<string, string>;
};

/**
 * The work item for one issue. It fits both the step bridge's upsert item
 * (once `sourceUpdatedAt` is known to be set) and the server's upsert input
 * (with a `projectId`).
 */
export type JiraWorkItem = {
  platform: "jira";
  platformId: string;
  platformKey: string;
  url: string;
  title: string;
  description: string;
  sourceCreatedAt: string | null;
  sourceUpdatedAt: string | null;
  state: "open" | "closed";
  labels: string[];
  fields: Record<string, unknown>;
};

const NO_DESCRIPTION = "(No description provided.)";

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

/**
 * REST returns ADF; the Atlassian MCP server returns markdown or HTML text.
 */
// eslint-disable-next-line local/no-unknown-parameter-type
function descriptionText(description: unknown): string {
  if (typeof description === "string") return description.trim();
  return adfToPlainText(description);
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
function jiraStatusToState(status: unknown): "open" | "closed" {
  const categoryKey = (status as { statusCategory?: { key?: string } } | null)
    ?.statusCategory?.key;
  return categoryKey === "done" ? "closed" : "open";
}

/**
 * `commentsCount` only when the issue carries its `comment` field: a search
 * that didn't ask for comments (the MCP default) leaves it out rather than
 * reporting 0.
 */
function commentsCountField(f: Record<string, unknown>): {
  commentsCount?: number;
} {
  if (!("comment" in f)) return {};
  return {
    commentsCount: (f["comment"] as { total?: number } | null)?.total ?? 0,
  };
}

/** Maps one Jira issue to its work item, keyed by the issue key. */
export function mapJiraIssue(
  issue: JiraIssue,
  options: MapJiraIssueOptions,
): JiraWorkItem {
  const base = options.site.replace(/\/$/, "");
  const f = issue.fields;

  const customFields: Record<string, unknown> = {};
  for (const [id, prettyName] of options.fieldNames ?? []) {
    const value = extractCustomFieldValue(f[id]);
    if (value !== null) {
      customFields[prettyName] = value;
    }
  }

  return {
    platform: "jira",
    platformId: issue.id,
    platformKey: issue.key,
    url: `${base}/browse/${issue.key}`,
    title: f["summary"] as string,
    description: descriptionText(f["description"]) || NO_DESCRIPTION,
    sourceCreatedAt: normalizeJiraDatetime(f["created"] as string | undefined),
    sourceUpdatedAt: normalizeJiraDatetime(f["updated"] as string | undefined),
    state: jiraStatusToState(f["status"]),
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
      ...commentsCountField(f),
      ...customFields,
    },
  };
}
