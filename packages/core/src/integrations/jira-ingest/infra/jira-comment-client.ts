/**
 * Outbound Jira comment posting (`POST /rest/api/3/issue/{key}/comment`).
 * The post is bounded by a timeout because it runs inside a time-limited
 * HTTP request.
 */

import { z } from "zod";
import {
  isJiraTimeout,
  jiraJsonRequest,
  trimJiraBaseUrl,
  type JiraFetchOptions,
  type JiraJsonResult,
} from "./jira-http";
import type { AdfDocument } from "./markdown-to-adf";

export type PostedJiraComment = { id: string; url: string };

export const POST_COMMENT_TIMEOUT_MS = 30_000;
const GATEWAY_TIMEOUT = 504;

const commentSchema = z.object({ id: z.string().optional() });

export class JiraCommentError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "JiraCommentError";
  }
}

/** Posts an ADF document (see `markdown-to-adf.ts`) as an issue comment. */
export async function postJiraIssueComment(
  input: JiraFetchOptions & {
    issueKey: string;
    document: AdfDocument;
    timeoutMs?: number;
  },
): Promise<PostedJiraComment> {
  const timeoutMs = input.timeoutMs ?? POST_COMMENT_TIMEOUT_MS;

  let result: JiraJsonResult;
  try {
    result = await jiraJsonRequest(
      input,
      `/rest/api/3/issue/${encodeURIComponent(input.issueKey)}/comment`,
      { method: "POST", body: { body: input.document }, timeoutMs },
    );
  } catch (error) {
    if (isJiraTimeout(error)) {
      throw new JiraCommentError(
        `Timed out after ${String(timeoutMs)}ms posting a comment to ${input.issueKey}`,
        GATEWAY_TIMEOUT,
      );
    }
    throw error;
  }

  if (!result.ok) {
    throw new JiraCommentError(
      `Jira returned ${String(result.status)} posting a comment to ${input.issueKey}` +
        (result.body ? `: ${result.body}` : ""),
      result.status,
    );
  }

  const id = commentSchema.safeParse(result.json).data?.id;
  if (!id) {
    throw new JiraCommentError(
      `Jira comment response for ${input.issueKey} missing id`,
      result.status,
    );
  }

  return {
    id,
    url: `${trimJiraBaseUrl(input.baseUrl)}/browse/${input.issueKey}?focusedCommentId=${id}`,
  };
}
