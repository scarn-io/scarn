import { describe, expect } from "bun:test";
import {
  JiraAttachmentError,
  MEDIA_ID_LOOKUP_ATTEMPTS,
  extractMediaIdFromLocation,
  lookupJiraMediaId,
  uploadJiraAttachment,
} from "@/integrations/jira-ingest/infra/jira-attachment-uploader";
import { concurrentTest } from "tests/utils";

const MEDIA_ID = "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0";
const CLIENT_ID = "11111111-2222-4333-8444-555555555555";
const LOCATION = `https://api.media.atlassian.com/file/${MEDIA_ID}/binary?token=secret-token&client=${CLIENT_ID}&name=shot.png`;

const requestUrl = (input: string | URL | Request): string =>
  typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;

type Call = { url: string; init: RequestInit | undefined };

const fakeFetch = (
  respond: (call: Call, index: number) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: Call[] } => {
  const calls: Call[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const call = { url: requestUrl(input), init };
    const index = calls.push(call) - 1;
    return Promise.resolve().then(() => respond(call, index));
  }) as typeof fetch;
  return { fetchImpl, calls };
};

/** Never responds; rejects with the signal's reason once it aborts. */
const hangingFetch = (call: Call): Promise<Response> =>
  new Promise((_resolve, reject) => {
    const signal = call.init?.signal;
    signal?.addEventListener("abort", () => {
      reject(signal.reason as Error);
    });
  });

const created = (): Response =>
  Response.json([{ id: "10042", mimeType: "image/png" }]);
const redirect = (location: string | null): Response =>
  new Response(null, {
    status: 303,
    headers: location ? { location } : {},
  });

const connection = {
  baseUrl: "https://acme.atlassian.net/",
  email: "me@acme.test",
  apiToken: "api-token",
};

const upload = (fetchImpl: typeof fetch, timeoutMs?: number) =>
  uploadJiraAttachment({
    ...connection,
    issueKey: "PROJ-1",
    fileName: "shot.png",
    contentType: "image/png",
    bytes: new Uint8Array([1, 2, 3]),
    fetchImpl,
    timeoutMs,
  });

const lookup = (
  fetchImpl: typeof fetch,
  sleeps: number[] = [],
  attemptTimeoutMs?: number,
) =>
  lookupJiraMediaId({
    ...connection,
    attachmentId: "10042",
    fetchImpl,
    attemptTimeoutMs,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });

const catchError = async (work: Promise<unknown>): Promise<Error | null> => {
  try {
    await work;
    return null;
  } catch (caught) {
    return caught as Error;
  }
};

describe("extractMediaIdFromLocation", () => {
  concurrentTest("reads the /file/<uuid>/ segment, not the client UUID", () => {
    expect(extractMediaIdFromLocation(LOCATION)).toBe(MEDIA_ID);
  });

  concurrentTest("ignores a UUID that only appears in the query", () => {
    expect(
      extractMediaIdFromLocation(
        `https://api.media.atlassian.com/binary?client=${CLIENT_ID}`,
      ),
    ).toBeNull();
  });

  concurrentTest("returns null for an unparseable value", () => {
    expect(extractMediaIdFromLocation("http://[bad")).toBeNull();
  });
});

describe("uploadJiraAttachment", () => {
  concurrentTest(
    "uploads multipart with the no-check header, explicit MIME and a timeout signal",
    async () => {
      const { fetchImpl, calls } = fakeFetch(() => created());

      const result = await upload(fetchImpl);

      expect(result).toEqual({
        attachmentId: "10042",
        contentUrl:
          "https://acme.atlassian.net/rest/api/3/attachment/content/10042",
      });
      expect(calls).toHaveLength(1);
      const [post] = calls;
      expect(post?.url).toBe(
        "https://acme.atlassian.net/rest/api/3/issue/PROJ-1/attachments",
      );
      const postHeaders = post?.init?.headers as Record<string, string>;
      expect(postHeaders["X-Atlassian-Token"]).toBe("no-check");
      expect(postHeaders["authorization"]).toBe(
        `Basic ${Buffer.from("me@acme.test:api-token").toString("base64")}`,
      );
      const file = (post?.init?.body as FormData).get("file") as File;
      expect(file.name).toBe("shot.png");
      expect(file.type).toBe("image/png");
      expect(post?.init?.signal).toBeInstanceOf(AbortSignal);
    },
  );

  concurrentTest(
    "throws a JiraAttachmentError with the status when the upload fails",
    async () => {
      const { fetchImpl, calls } = fakeFetch(
        () => new Response("too big", { status: 413 }),
      );

      const error = await catchError(upload(fetchImpl));

      expect(error).toBeInstanceOf(JiraAttachmentError);
      expect((error as JiraAttachmentError).status).toBe(413);
      expect(error?.message).not.toContain("api-token");
      expect(calls).toHaveLength(1);
    },
  );

  concurrentTest(
    "throws a 504 JiraAttachmentError when the upload times out",
    async () => {
      const { fetchImpl } = fakeFetch(hangingFetch);

      const error = await catchError(upload(fetchImpl, 10));

      expect(error).toBeInstanceOf(JiraAttachmentError);
      expect((error as JiraAttachmentError).status).toBe(504);
      expect(error?.message).toContain("Timed out");
    },
  );
});

describe("lookupJiraMediaId", () => {
  concurrentTest("reads the redirect without following it", async () => {
    const { fetchImpl, calls } = fakeFetch(() => redirect(LOCATION));

    expect(await lookup(fetchImpl)).toBe(MEDIA_ID);
    expect(calls[0]?.url).toBe(
      "https://acme.atlassian.net/rest/api/3/attachment/content/10042",
    );
    expect(calls[0]?.init?.redirect).toBe("manual");
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  concurrentTest(
    "retries the lookup with backoff until it finds a UUID",
    async () => {
      const sleeps: number[] = [];
      const { fetchImpl, calls } = fakeFetch((_call, index) => {
        if (index === 0) throw new Error("network");
        return index === 1 ? redirect(null) : redirect(LOCATION);
      });

      expect(await lookup(fetchImpl, sleeps)).toBe(MEDIA_ID);
      expect(calls).toHaveLength(MEDIA_ID_LOOKUP_ATTEMPTS);
      expect(sleeps).toEqual([250, 500]);
    },
  );

  concurrentTest("returns null after the last failed lookup", async () => {
    const { fetchImpl, calls } = fakeFetch(
      () => new Response("ok", { status: 200 }),
    );

    expect(await lookup(fetchImpl)).toBeNull();
    expect(calls).toHaveLength(MEDIA_ID_LOOKUP_ATTEMPTS);
  });

  concurrentTest(
    "gives up on each hanging attempt and returns null",
    async () => {
      const { fetchImpl, calls } = fakeFetch(hangingFetch);

      expect(await lookup(fetchImpl, [], 10)).toBeNull();
      expect(calls).toHaveLength(MEDIA_ID_LOOKUP_ATTEMPTS);
    },
  );
});
