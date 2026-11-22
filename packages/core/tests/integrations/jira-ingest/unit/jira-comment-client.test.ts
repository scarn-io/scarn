import { describe, expect, test } from "bun:test";
import {
  JiraCommentError,
  postJiraIssueComment,
} from "@/integrations/jira-ingest/infra/jira-comment-client";

/**
 * Decision 8: a failed Jira write is wrapped in a `JiraCommentError` whose
 * message is built only from the HTTP status and Jira's own response body —
 * never from `input.apiToken` or `input.email`. A fake `fetchImpl` stands in
 * for Jira so `postJiraIssueComment`'s own request and error handling run.
 */
describe("postJiraIssueComment", () => {
  const document = {
    type: "doc" as const,
    version: 1 as const,
    content: [
      { type: "paragraph", content: [{ type: "text", text: "hello" }] },
    ],
  };

  test("posts the ADF document to the issue's comment endpoint", async () => {
    const requests: { url: string; init: RequestInit | undefined }[] = [];
    const fetchImpl = ((url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return Promise.resolve(Response.json({ id: "10001" }, { status: 201 }));
    }) as typeof fetch;

    const posted = await postJiraIssueComment({
      baseUrl: "https://acme.atlassian.net/",
      email: "me@acme.test",
      apiToken: "t",
      issueKey: "PROJ-1",
      document,
      fetchImpl,
    });

    expect(posted).toEqual({
      id: "10001",
      url: "https://acme.atlassian.net/browse/PROJ-1?focusedCommentId=10001",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "https://acme.atlassian.net/rest/api/3/issue/PROJ-1/comment",
    );
    expect(requests[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      body: document,
    });
    expect(
      (requests[0]?.init?.headers as Record<string, string>)["authorization"],
    ).toBe(`Basic ${Buffer.from("me@acme.test:t").toString("base64")}`);
  });

  test("never includes the raw apiToken or email in a thrown JiraCommentError's message", async () => {
    const fakeApiKey = "atlassian-fake-secret-do-not-leak-me";
    const fakeEmail = "do-not-leak-this-email@acme.com";
    const fetchImpl = (() =>
      Promise.resolve(
        Response.json(
          { errorMessages: ["Unauthorized; API key invalid"] },
          { status: 401 },
        ),
      )) as unknown as typeof fetch;

    const thrown = await postJiraIssueComment({
      baseUrl: "https://acme.atlassian.net",
      email: fakeEmail,
      apiToken: fakeApiKey,
      issueKey: "PROJ-1",
      document,
      fetchImpl,
    }).catch((error: Error) => error);

    expect(thrown).toBeInstanceOf(JiraCommentError);
    const message = (thrown as JiraCommentError).message;
    expect(message).not.toContain(fakeApiKey);
    expect(message).not.toContain(fakeEmail);
    expect(message).toContain("401");
    expect(message).toContain("Unauthorized; API key invalid");
    expect((thrown as JiraCommentError).status).toBe(401);
  });

  test("maps a timeout to a 504", async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason as Error);
        });
      })) as typeof fetch;

    const thrown = await postJiraIssueComment({
      baseUrl: "https://acme.atlassian.net",
      email: "me@acme.test",
      apiToken: "t",
      issueKey: "PROJ-1",
      timeoutMs: 25,
      document: { type: "doc", version: 1, content: [] },
      fetchImpl,
    }).catch((error: Error) => error);

    expect(thrown).toBeInstanceOf(JiraCommentError);
    expect((thrown as JiraCommentError).status).toBe(504);
  });
});
