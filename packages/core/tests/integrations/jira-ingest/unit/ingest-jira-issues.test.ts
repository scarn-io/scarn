import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import {
  buildJiraSearchJql,
  fetchJiraAccountTimeZone as realFetchJiraAccountTimeZone,
  fetchJiraFieldNameMap as realFetchJiraFieldNameMap,
  fetchJiraIssues as realFetchJiraIssues,
  formatJiraDateTimeInZone,
  JiraIngestError,
  type FetchJiraIssuesInput,
  type JiraConnectionInput,
  type JiraIssue,
} from "@/integrations/jira-ingest/infra/jira-issues-client";

// Plain (non-live-binding) snapshots of this module's other real exports,
// captured before any `mock.module` call below ever runs. `mock.module`
// mutates the target module's export bindings in place, so a plain ES
// `import { x }` would itself start resolving to whatever gets mocked in —
// including for OTHER files that import the real thing after this one has
// run (`mock.restore()` in `afterEach` does not undo a `mock.module`
// substitution). Copying each export into an ordinary `const` here, before
// mocking starts, keeps a reference `mock.module` can no longer reach, so
// `afterEach` can put the real module back for whichever test file happens
// to run next in the same `bun test` process — mirroring the same fix in
// `comment-draft-jira-fetch-support.ts`.
const REAL_JIRA_INGEST_ERROR = JiraIngestError;
const REAL_FORMAT_JIRA_DATE_TIME_IN_ZONE = formatJiraDateTimeInZone;
const REAL_BUILD_JIRA_SEARCH_JQL = buildJiraSearchJql;
const REAL_FETCH_JIRA_FIELD_NAME_MAP = realFetchJiraFieldNameMap;
const REAL_FETCH_JIRA_ACCOUNT_TIME_ZONE = realFetchJiraAccountTimeZone;
const REAL_FETCH_JIRA_ISSUES = realFetchJiraIssues;

const projectId = parseUuidV7("0196917c-532c-75aa-b7d5-0a84b71a1f02");

const makeIssue = (key: string): JiraIssue =>
  ({
    id: key,
    key,
    fields: {
      summary: `Issue ${key}`,
      description: null,
      created: "2026-09-04T16:00:00.000-0500",
      updated: "2026-09-04T16:08:54.089-0500",
      status: { name: "To Do" },
      priority: null,
      issuetype: { name: "Bug" },
      assignee: null,
      reporter: null,
      labels: [],
      comment: { total: 0 },
    },
  }) as unknown as JiraIssue;

/**
 * Orchestration-level regression coverage for the CV-3344 fix: verifies
 * `ingestJiraIssues` only pays for the extra `fetchJiraAccountTimeZone` call
 * when it's actually needed (an incremental sync with a `sinceIso`
 * watermark), and — critically — that the resolved timezone is the one
 * that actually reaches `fetchJiraIssues` for every configured project key,
 * not just the first. A regression here (e.g. someone hardcodes "UTC" again,
 * or forgets to thread `timeZone` through the loop) would silently
 * reintroduce the CV-3344 bug for every project key after the first.
 */
describe("ingestJiraIssues", () => {
  const fetchJiraFieldNameMap = mock<
    (input: JiraConnectionInput) => Promise<Map<string, string>>
  >(() => Promise.resolve(new Map()));
  const fetchJiraAccountTimeZone = mock<
    (input: JiraConnectionInput) => Promise<string>
  >(() => Promise.resolve("America/Chicago"));
  const fetchJiraIssues = mock<
    (input: FetchJiraIssuesInput) => Promise<JiraIssue[]>
  >(() => Promise.resolve([]));

  beforeEach(async () => {
    fetchJiraFieldNameMap.mockClear();
    fetchJiraAccountTimeZone.mockClear();
    fetchJiraIssues.mockClear();
    await mock.module(
      "@/integrations/jira-ingest/infra/jira-issues-client",
      () => ({
        fetchJiraFieldNameMap,
        fetchJiraAccountTimeZone,
        fetchJiraIssues,
        JiraIngestError: REAL_JIRA_INGEST_ERROR,
        formatJiraDateTimeInZone: REAL_FORMAT_JIRA_DATE_TIME_IN_ZONE,
        buildJiraSearchJql: REAL_BUILD_JIRA_SEARCH_JQL,
      }),
    );
  });

  afterEach(async () => {
    // Puts the real module back — `mock.restore()` only resets spies created
    // via `mock()`, it does not undo the `mock.module` substitution above.
    // Left unmocked, `jira-issues-client` would stay stubbed out (missing
    // `JiraIngestError`/etc., which this describe block's
    // factory never provided) for every test file that happens to run
    // afterward in the same `bun test` process.
    await mock.module(
      "@/integrations/jira-ingest/infra/jira-issues-client",
      () => ({
        fetchJiraFieldNameMap: REAL_FETCH_JIRA_FIELD_NAME_MAP,
        fetchJiraAccountTimeZone: REAL_FETCH_JIRA_ACCOUNT_TIME_ZONE,
        fetchJiraIssues: REAL_FETCH_JIRA_ISSUES,
        JiraIngestError: REAL_JIRA_INGEST_ERROR,
        formatJiraDateTimeInZone: REAL_FORMAT_JIRA_DATE_TIME_IN_ZONE,
        buildJiraSearchJql: REAL_BUILD_JIRA_SEARCH_JQL,
      }),
    );
    mock.restore();
  });

  test("does not fetch the account timezone on a first sync (no sinceIso)", async () => {
    const { ingestJiraIssues } = await import(
      "@/integrations/jira-ingest/application/ingest-jira-issues"
    );
    fetchJiraIssues.mockImplementation(() =>
      Promise.resolve([makeIssue("CV-1")]),
    );
    const upsertWorkItems = mock(() => Promise.resolve());

    await ingestJiraIssues(
      {
        projectId,
        baseUrl: "https://acme.atlassian.net",
        email: "user@acme.com",
        apiToken: "key",
        projectKeys: ["CV"],
        sinceIso: null,
      },
      upsertWorkItems,
    );

    expect(fetchJiraAccountTimeZone).not.toHaveBeenCalled();
    expect(fetchJiraIssues).toHaveBeenCalledTimes(1);
    expect(fetchJiraIssues.mock.calls[0]?.[0]).toMatchObject({
      projectKey: "CV",
      sinceIso: null,
      timeZone: undefined,
    });
  });

  test("fetches the account timezone once and threads it into every project key's fetch (incremental sync)", async () => {
    const { ingestJiraIssues } = await import(
      "@/integrations/jira-ingest/application/ingest-jira-issues"
    );
    fetchJiraIssues.mockImplementation(() =>
      Promise.resolve([makeIssue("CV-3344")]),
    );
    const upsertWorkItems = mock(() => Promise.resolve());
    const sinceIso = "2026-09-04T18:00:00.000Z";

    await ingestJiraIssues(
      {
        projectId,
        baseUrl: "https://takecommandhealth.atlassian.net",
        email: "connor.ivy@takecommandhealth.com",
        apiToken: "key",
        projectKeys: ["ADM", "CV", "PS"],
        sinceIso,
      },
      upsertWorkItems,
    );

    // Resolved exactly once per run, not once per project key.
    expect(fetchJiraAccountTimeZone).toHaveBeenCalledTimes(1);

    // Every project key's fetch must receive the *same* resolved timezone
    // and the original UTC sinceIso — it's fetchJiraIssues's own job (now
    // covered separately) to convert it correctly, not this orchestration
    // layer's.
    expect(fetchJiraIssues).toHaveBeenCalledTimes(3);
    for (const call of fetchJiraIssues.mock.calls) {
      expect(call[0]).toMatchObject({
        sinceIso,
        timeZone: "America/Chicago",
      });
    }
    expect(fetchJiraIssues.mock.calls.map((c) => c[0].projectKey)).toEqual([
      "ADM",
      "CV",
      "PS",
    ]);
  });
});
