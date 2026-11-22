import { z } from "zod";
import {
  jiraJsonRequest,
  type JiraConnectionInput,
  type JiraJsonResult,
} from "./jira-http";

export type { JiraConnectionInput };

/** The subset of a Jira REST v3 issue that ingest reads. */
export type JiraIssue = {
  id: string;
  key: string;
  fields: Record<string, unknown>;
};

const fieldsSchema = z.array(
  z.object({ id: z.string().optional(), name: z.string().optional() }),
);

const myselfSchema = z.object({
  accountId: z.string(),
  displayName: z.string().nullish(),
  emailAddress: z.string().nullish(),
  timeZone: z.string().nullish(),
});

const issueSchema = z.object({
  id: z.string(),
  key: z.string(),
  fields: z.record(z.string(), z.unknown()),
});

const searchPageSchema = z.object({
  issues: z.array(issueSchema).nullish(),
  nextPageToken: z.string().nullish(),
});

export class JiraIngestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly responseBody?: string,
  ) {
    super(message);
    this.name = "JiraIngestError";
  }
}

export type FetchJiraIssuesInput = JiraConnectionInput & {
  projectKey: string;
  sinceIso?: string | null;
  /**
   * IANA zone to interpret `sinceIso` in when building the JQL `updated >=`
   * literal (see `fetchJiraAccountTimeZone`). Defaults to
   * `FALLBACK_JIRA_TIME_ZONE` ("UTC") when omitted, which is only correct if
   * the requesting Jira account is also configured for UTC.
   */
  timeZone?: string;
};

/**
 * The parsed body of a successful Jira response, or a `JiraIngestError`
 * carrying the status and body of a failed or unexpected one.
 */
function parseJiraResponse<T>(
  result: JiraJsonResult,
  schema: z.ZodType<T>,
  action: string,
): T {
  if (!result.ok) {
    throw new JiraIngestError(
      `Jira returned ${String(result.status)} ${action}`,
      result.status,
      result.body,
    );
  }
  const parsed = schema.safeParse(result.json);
  if (!parsed.success) {
    throw new JiraIngestError(
      `Jira returned an unexpected response ${action}`,
      result.status,
    );
  }
  return parsed.data;
}

export async function fetchJiraFieldNameMap(
  input: JiraConnectionInput,
): Promise<Map<string, string>> {
  const fields = parseJiraResponse(
    await jiraJsonRequest(input, "/rest/api/3/field"),
    fieldsSchema,
    "fetching field names",
  );
  const map = new Map<string, string>();
  for (const field of fields) {
    if (field.id && field.name && field.id.startsWith("customfield_")) {
      map.set(field.id, field.name);
    }
  }
  return map;
}

export type JiraAccount = {
  accountId: string;
  displayName: string | null;
  emailAddress: string | null;
};

/** The account the email + API token belong to (`GET /myself`). */
export async function fetchJiraMyself(
  input: JiraConnectionInput,
): Promise<JiraAccount> {
  const user = parseJiraResponse(
    await jiraJsonRequest(input, "/rest/api/3/myself"),
    myselfSchema,
    "fetching the current account",
  );
  return {
    accountId: user.accountId,
    displayName: user.displayName ?? null,
    emailAddress: user.emailAddress ?? null,
  };
}

/**
 * Whether the account can see the project with this key. A 404 means no;
 * every other failure is rethrown as a `JiraIngestError`.
 */
export async function jiraProjectExists(
  input: JiraConnectionInput & { projectKey: string },
): Promise<boolean> {
  const result = await jiraJsonRequest(
    input,
    `/rest/api/3/project/${encodeURIComponent(input.projectKey)}`,
  );
  if (!result.ok && result.status === 404) return false;
  parseJiraResponse(
    result,
    z.unknown(),
    `fetching project ${input.projectKey}`,
  );
  return true;
}

/** Fallback timezone used when Jira doesn't return the account's own (e.g.
 * because the user's privacy settings hide it). "UTC" is the least-bad
 * guess: it's wrong only if the real interpreting timezone also happens to
 * differ from UTC, same as before this fix existed at all. */
const FALLBACK_JIRA_TIME_ZONE = "UTC";

/**
 * Jira JQL date literals (`updated >= "..."`) have no timezone-offset syntax
 * — Jira always parses a bare `"yyyy-MM-dd HH:mm"` literal in the
 * *requesting account's* configured timezone (falling back to the site
 * default), never UTC. `sinceIso` is always a UTC instant (it comes from
 * `lastSyncedAt.toISOString()`), so naively slicing its UTC digits into the
 * literal silently reinterprets it in the wrong zone: an issue updated
 * during the resulting offset window can permanently miss every future
 * incremental sync, since the watermark only moves forward. This resolves
 * the account's own timezone against the instant so the literal's wall-clock
 * digits, once Jira reapplies its own timezone, land back on the intended
 * UTC instant.
 */
export async function fetchJiraAccountTimeZone(
  input: JiraConnectionInput,
): Promise<string> {
  const user = parseJiraResponse(
    await jiraJsonRequest(input, "/rest/api/3/myself"),
    myselfSchema,
    "fetching the account time zone",
  );
  return user.timeZone ?? FALLBACK_JIRA_TIME_ZONE;
}

/**
 * Renders a UTC instant as `"yyyy-MM-dd HH:mm"` wall-clock digits in
 * `timeZone`, matching the minute-precision, offset-less format Jira's JQL
 * date literals expect. See `fetchJiraAccountTimeZone` for why this
 * conversion is necessary rather than passing `isoUtc`'s own UTC digits
 * through directly.
 */
export function formatJiraDateTimeInZone(
  isoUtc: string,
  timeZone: string,
): string {
  const date = new Date(isoUtc);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

/**
 * Builds the JQL used to page through a project's issues, optionally
 * bounded by an incremental `since` watermark. Kept separate from
 * `fetchJiraIssues` (which also does the network paging) so the date-filter
 * construction — where the CV-3344 timezone bug lived — is directly
 * unit-testable without a Jira connection.
 */
export function buildJiraSearchJql(
  projectKey: string,
  sinceIso: string | null | undefined,
  timeZone: string | undefined,
): string {
  if (!sinceIso) {
    return `project = "${projectKey}" ORDER BY updated ASC`;
  }
  const since = formatJiraDateTimeInZone(
    sinceIso,
    timeZone ?? FALLBACK_JIRA_TIME_ZONE,
  );
  return `project = "${projectKey}" AND updated >= "${since}" ORDER BY updated ASC`;
}

export async function fetchJiraIssues(
  input: FetchJiraIssuesInput,
): Promise<JiraIssue[]> {
  const jql = buildJiraSearchJql(
    input.projectKey,
    input.sinceIso,
    input.timeZone,
  );

  const issues: JiraIssue[] = [];
  let nextPageToken: string | undefined;

  do {
    const page = parseJiraResponse(
      await jiraJsonRequest(input, "/rest/api/3/search/jql", {
        method: "POST",
        body: { jql, nextPageToken, maxResults: 100, fields: ["*all"] },
      }),
      searchPageSchema,
      `fetching issues for project ${input.projectKey}`,
    );
    issues.push(...(page.issues ?? []));
    nextPageToken = page.nextPageToken ?? undefined;
  } while (nextPageToken);

  return issues;
}
