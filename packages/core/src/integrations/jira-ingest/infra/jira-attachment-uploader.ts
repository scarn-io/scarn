/**
 * Uploads a file to a Jira Cloud issue and finds the media-services UUID an
 * ADF `media` node needs (see "Jira v3 spike findings" in
 * `docs/plans/embedded-artifacts-in-comments.md`).
 *
 * The only source of that UUID is the 303 `Location` of
 * `GET /rest/api/3/attachment/content/{id}`. The `Location` carries a
 * short-lived media token, so it is never logged or put in an error.
 *
 * Upload and lookup are separate calls so the caller can save the attachment
 * id before the lookup: a request cut short mid-lookup must not upload the
 * file again on retry. Every request is bounded by a timeout, since both run
 * inside a time-limited HTTP request.
 */
import { z } from "zod";
import {
  isJiraTimeout as isTimeout,
  jiraBasicAuth as basicAuth,
  trimJiraBaseUrl as trimBase,
  type JiraFetchOptions,
} from "./jira-http";

export type JiraAttachmentUpload = JiraFetchOptions & {
  issueKey: string;
  fileName: string;
  contentType: string;
  bytes: Uint8Array;
  timeoutMs?: number;
};

export type UploadedJiraAttachment = {
  attachmentId: string;
  /** The attachment's REST content URL, for linking when there is no media id. */
  contentUrl: string;
};

export type JiraMediaIdLookup = JiraFetchOptions & {
  attachmentId: string;
  sleep?: (ms: number) => Promise<void>;
  attemptTimeoutMs?: number;
};

export class JiraAttachmentError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "JiraAttachmentError";
  }
}

export const UPLOAD_TIMEOUT_MS = 120_000;
export const MEDIA_ID_LOOKUP_ATTEMPTS = 3;
export const MEDIA_ID_LOOKUP_ATTEMPT_TIMEOUT_MS = 5_000;
const MEDIA_ID_BACKOFF_MS = 250;
const GATEWAY_TIMEOUT = 504;

const MEDIA_FILE_PATH =
  /\/file\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

/**
 * The media UUID in a media-services redirect, read from its `/file/<uuid>/`
 * path segment only: the query string has another UUID (`client`).
 */
export const extractMediaIdFromLocation = (location: string): string | null => {
  let pathname: string;
  try {
    pathname = new URL(location, "https://media.invalid").pathname;
  } catch {
    return null;
  }
  return MEDIA_FILE_PATH.exec(pathname)?.[1]?.toLowerCase() ?? null;
};

/** The REST URL that serves an attachment's bytes to a signed-in Jira user. */
export const jiraAttachmentContentUrl = (
  baseUrl: string,
  attachmentId: string,
): string =>
  `${trimBase(baseUrl)}/rest/api/3/attachment/content/${encodeURIComponent(attachmentId)}`;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const createdAttachmentsSchema = z
  .array(z.object({ id: z.union([z.string(), z.number()]) }))
  .min(1);

const responseSnippet = async (response: Response): Promise<string> => {
  const text = await response.text().catch(() => "");
  return text ? `: ${text.slice(0, 500)}` : "";
};

/**
 * Attaches `bytes` to the issue. A failed or timed-out upload throws a
 * {@link JiraAttachmentError}; a timeout carries status 504.
 */
export const uploadJiraAttachment = async (
  input: JiraAttachmentUpload,
): Promise<UploadedJiraAttachment> => {
  const fetchImpl = input.fetchImpl ?? fetch;
  const base = trimBase(input.baseUrl);
  const issuePath = encodeURIComponent(input.issueKey);
  const timeoutMs = input.timeoutMs ?? UPLOAD_TIMEOUT_MS;

  const form = new FormData();
  form.append(
    "file",
    new File([new Uint8Array(input.bytes)], input.fileName, {
      type: input.contentType,
    }),
  );

  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  let body: unknown;
  try {
    response = await fetchImpl(
      `${base}/rest/api/3/issue/${issuePath}/attachments`,
      {
        method: "POST",
        headers: {
          authorization: basicAuth(input),
          accept: "application/json",
          "X-Atlassian-Token": "no-check",
        },
        body: form,
        signal,
      },
    );
    if (!response.ok) {
      throw new JiraAttachmentError(
        `Jira returned ${String(response.status)} attaching ${input.fileName} to ${input.issueKey}` +
          (await responseSnippet(response)),
        response.status,
      );
    }
    body = await response.json();
  } catch (error) {
    if (isTimeout(error)) {
      throw new JiraAttachmentError(
        `Timed out after ${String(timeoutMs)}ms attaching ${input.fileName} to ${input.issueKey}`,
        GATEWAY_TIMEOUT,
      );
    }
    throw error;
  }

  const parsed = createdAttachmentsSchema.safeParse(body);
  const attachmentId = parsed.success ? String(parsed.data[0]?.id) : null;
  if (!attachmentId) {
    throw new JiraAttachmentError(
      `Jira attachment response for ${input.issueKey} had no attachment id`,
      response.status,
    );
  }

  return {
    attachmentId,
    contentUrl: jiraAttachmentContentUrl(base, attachmentId),
  };
};

/**
 * Looks up an attachment's media UUID with a short bounded retry, each
 * attempt under its own timeout. Null when Jira doesn't redirect to a media
 * file in time, so the caller can link to the attachment instead.
 */
export const lookupJiraMediaId = async (
  input: JiraMediaIdLookup,
): Promise<string | null> => {
  const fetchImpl = input.fetchImpl ?? fetch;
  const sleep = input.sleep ?? defaultSleep;
  const attemptTimeoutMs =
    input.attemptTimeoutMs ?? MEDIA_ID_LOOKUP_ATTEMPT_TIMEOUT_MS;
  const contentUrl = jiraAttachmentContentUrl(
    input.baseUrl,
    input.attachmentId,
  );
  for (let attempt = 1; attempt <= MEDIA_ID_LOOKUP_ATTEMPTS; attempt++) {
    try {
      const response = await fetchImpl(contentUrl, {
        method: "GET",
        redirect: "manual",
        headers: { authorization: basicAuth(input), accept: "*/*" },
        signal: AbortSignal.timeout(attemptTimeoutMs),
      });
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      const mediaId = location ? extractMediaIdFromLocation(location) : null;
      if (mediaId) return mediaId;
    } catch {
      // A failed or timed-out lookup falls through to the next attempt.
    }
    if (attempt < MEDIA_ID_LOOKUP_ATTEMPTS) {
      await sleep(MEDIA_ID_BACKOFF_MS * 2 ** (attempt - 1));
    }
  }
  return null;
};
