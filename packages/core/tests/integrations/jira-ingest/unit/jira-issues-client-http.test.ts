import { afterEach, describe, expect, test } from "bun:test";
import {
  fetchJiraAccountTimeZone,
  fetchJiraFieldNameMap,
  fetchJiraIssues,
  fetchJiraMyself,
  JiraIngestError,
  jiraProjectExists,
} from "@/integrations/jira-ingest/infra/jira-issues-client";

/**
 * The Jira read calls against a faked `globalThis.fetch`: request shape,
 * pagination, and how non-2xx responses become `JiraIngestError`s.
 */
describe("jira-issues-client HTTP calls", () => {
  const realFetch = globalThis.fetch;
  const connection = {
    baseUrl: "https://acme.atlassian.net/",
    email: "me@acme.test",
    apiToken: "secret-token",
  };
  type Captured = { url: string; method: string; body: unknown; auth: string };

  const fakeJira = (respond: (req: Captured) => Response): Captured[] => {
    const requests: Captured[] = [];
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      const req = {
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        auth: (init?.headers as Record<string, string>)["authorization"] ?? "",
      };
      requests.push(req);
      return Promise.resolve(respond(req));
    }) as typeof fetch;
    return requests;
  };

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("fetchJiraFieldNameMap keeps only custom fields", async () => {
    const requests = fakeJira(() =>
      Response.json([
        { id: "summary", name: "Summary" },
        { id: "customfield_100", name: "Team" },
      ]),
    );
    const map = await fetchJiraFieldNameMap(connection);
    expect([...map]).toEqual([["customfield_100", "Team"]]);
    expect(requests[0]?.url).toBe("https://acme.atlassian.net/rest/api/3/field");
    expect(requests[0]?.auth).toBe(
      `Basic ${Buffer.from("me@acme.test:secret-token").toString("base64")}`,
    );
  });

  test("fetchJiraMyself and fetchJiraAccountTimeZone read /myself", async () => {
    fakeJira(() =>
      Response.json({
        accountId: "abc",
        displayName: "Me",
        timeZone: "America/Chicago",
      }),
    );
    expect(await fetchJiraMyself(connection)).toEqual({
      accountId: "abc",
      displayName: "Me",
      emailAddress: null,
    });
    expect(await fetchJiraAccountTimeZone(connection)).toBe("America/Chicago");
  });

  test("jiraProjectExists is false on 404 and throws on other failures", async () => {
    fakeJira((req) =>
      req.url.endsWith("/MISSING")
        ? new Response("{}", { status: 404 })
        : req.url.endsWith("/BROKEN")
          ? new Response("boom", { status: 500 })
          : Response.json({ key: "CV" }),
    );
    expect(await jiraProjectExists({ ...connection, projectKey: "CV" })).toBe(
      true,
    );
    expect(
      await jiraProjectExists({ ...connection, projectKey: "MISSING" }),
    ).toBe(false);
    const thrown = await jiraProjectExists({
      ...connection,
      projectKey: "BROKEN",
    }).catch((error: Error) => error);
    expect(thrown).toBeInstanceOf(JiraIngestError);
    expect((thrown as JiraIngestError).status).toBe(500);
  });

  test("fetchJiraIssues follows nextPageToken until it runs out", async () => {
    const issue = (key: string) => ({ id: key, key, fields: { summary: key } });
    const requests = fakeJira((req) =>
      (req.body as { nextPageToken?: string }).nextPageToken
        ? Response.json({ issues: [issue("CV-2")] })
        : Response.json({ issues: [issue("CV-1")], nextPageToken: "p2" }),
    );
    const issues = await fetchJiraIssues({ ...connection, projectKey: "CV" });
    expect(issues.map((i) => i.key)).toEqual(["CV-1", "CV-2"]);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      url: "https://acme.atlassian.net/rest/api/3/search/jql",
      method: "POST",
      body: {
        jql: 'project = "CV" ORDER BY updated ASC',
        maxResults: 100,
        fields: ["*all"],
      },
    });
    expect(requests[1]?.body).toMatchObject({ nextPageToken: "p2" });
  });

  test("a 401 becomes a JiraIngestError with the body but no credentials in the message", async () => {
    fakeJira(
      () => new Response('{"errorMessages":["nope"]}', { status: 401 }),
    );
    const thrown = await fetchJiraFieldNameMap(connection).catch(
      (error: Error) => error,
    );
    expect(thrown).toBeInstanceOf(JiraIngestError);
    const error = thrown as JiraIngestError;
    expect(error.status).toBe(401);
    expect(error.responseBody).toBe('{"errorMessages":["nope"]}');
    expect(error.message).not.toContain("secret-token");
    expect(error.message).not.toContain("me@acme.test");
  });
});
