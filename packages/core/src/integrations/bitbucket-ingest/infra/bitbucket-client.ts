/**
 * Raw-`fetch` client for the Bitbucket Cloud REST API (`/2.0`), signed with
 * an Atlassian email + API token as basic auth. Paged endpoints follow the
 * response's `next` link. Errors never carry the token or Bitbucket's
 * response body: a failed call throws `BitbucketApiError` with only the
 * status and what was being done, and the repo/account checks map 401 to
 * `BITBUCKET_API_TOKEN_REJECTED` and 403/404 to `BITBUCKET_REPO_NOT_ACCESSIBLE`.
 */
import { CoreError } from "@scarn/core/lib/errors";
import { bitbucketCredentialRejectedError } from "@scarn/core/secrets/secret/application/resolve-bitbucket-credential";

export const BITBUCKET_API_BASE_URL = "https://api.bitbucket.org/2.0";

const ISSUES_PAGE_LENGTH = 50;

export class BitbucketApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "BitbucketApiError";
  }
}

export type BitbucketClientOptions = {
  email: string;
  apiToken: string;
  /** The saved key's name, so a rejection names it; null for a pasted pair. */
  secretName?: string | null;
  fetchImpl?: typeof fetch;
};

export type BitbucketRepository = {
  workspace: string;
  slug: string;
  fullName: string;
  hasIssues: boolean;
};

export type BitbucketUser = {
  accountId: string | null;
  displayName: string | null;
  username: string | null;
};

export type BitbucketIssue = {
  id: number;
  title: string;
  state: string;
  kind?: string | null;
  priority?: string | null;
  content?: { raw?: string | null } | null;
  reporter?: { display_name?: string | null } | null;
  assignee?: { display_name?: string | null } | null;
  created_on: string;
  updated_on: string;
  votes?: number | null;
  links?: { html?: { href?: string } } | null;
};

export type PostedBitbucketComment = {
  id: string;
  url: string | null;
};

type Page<T> = { values?: T[]; next?: string };

type RepositoryBody = {
  full_name?: string;
  slug?: string;
  has_issues?: boolean;
  workspace?: { slug?: string };
};

type UserBody = {
  account_id?: string;
  display_name?: string;
  username?: string;
};

type CommentBody = {
  id?: number;
  links?: { html?: { href?: string } };
};

export const bitbucketRepoNotAccessibleError = (
  workspace: string,
  slug: string,
): CoreError =>
  new CoreError({
    code: "BITBUCKET_REPO_NOT_ACCESSIBLE",
    message:
      `That API token can't read ${workspace}/${slug}. Check the repository exists, ` +
      "that the Atlassian account has access to it, and that the token has the " +
      "read:repository:bitbucket scope.",
    status: 422,
  });

export const bitbucketIssuesDisabledError = (fullName: string): CoreError =>
  new CoreError({
    code: "BITBUCKET_ISSUES_DISABLED",
    message: `${fullName} has its Bitbucket issue tracker turned off.`,
    status: 422,
  });

const unexpectedStatusError = (status: number, what: string): CoreError =>
  new CoreError({
    code: "BITBUCKET_REQUEST_FAILED",
    message: `Bitbucket returned ${String(status)} while reading ${what}`,
    status: 502,
  });

const repoPath = (workspace: string, slug: string): string =>
  `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(slug)}`;

/** `updated_on>"…"` with the BBQL quoting Bitbucket expects. */
export const buildBitbucketIssuesQuery = (
  updatedSince: string | null,
): string =>
  updatedSince ? `updated_on>"${new Date(updatedSince).toISOString()}"` : "";

const assertBitbucketUrl = (url: string): string => {
  if (!url.startsWith(`${BITBUCKET_API_BASE_URL}/`)) {
    throw new BitbucketApiError(
      "Bitbucket returned a next page outside its API",
      502,
    );
  }
  return url;
};

export const createBitbucketClient = ({
  email,
  apiToken,
  secretName = null,
  fetchImpl = fetch,
}: BitbucketClientOptions) => {
  const authorization = `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`;

  const request = (url: string, init: RequestInit = {}): Promise<Response> =>
    fetchImpl(url, {
      ...init,
      headers: {
        authorization,
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    });

  const failure = (response: Response, action: string): BitbucketApiError =>
    new BitbucketApiError(
      `Bitbucket returned ${String(response.status)} ${action}`,
      response.status,
    );

  return {
    async getRepository(
      workspace: string,
      slug: string,
    ): Promise<BitbucketRepository> {
      const response = await request(
        `${BITBUCKET_API_BASE_URL}${repoPath(workspace, slug)}`,
      );
      if (response.status === 401) {
        throw bitbucketCredentialRejectedError({ secretName });
      }
      if (response.status === 403 || response.status === 404) {
        throw bitbucketRepoNotAccessibleError(workspace, slug);
      }
      if (!response.ok) {
        throw unexpectedStatusError(response.status, `${workspace}/${slug}`);
      }
      const body = (await response.json()) as RepositoryBody;
      if (!body.full_name) {
        throw unexpectedStatusError(response.status, `${workspace}/${slug}`);
      }
      return {
        workspace: body.workspace?.slug ?? workspace,
        slug: body.slug ?? slug,
        fullName: body.full_name,
        hasIssues: body.has_issues ?? false,
      };
    },

    async getCurrentUser(): Promise<BitbucketUser> {
      const response = await request(`${BITBUCKET_API_BASE_URL}/user`);
      if (response.status === 401) {
        throw bitbucketCredentialRejectedError({ secretName });
      }
      if (!response.ok) {
        throw unexpectedStatusError(response.status, "the token's account");
      }
      const body = (await response.json()) as UserBody;
      return {
        accountId: body.account_id ?? null,
        displayName: body.display_name ?? null,
        username: body.username ?? null,
      };
    },

    async listIssues(
      workspace: string,
      slug: string,
      { updatedSince }: { updatedSince: string | null },
    ): Promise<BitbucketIssue[]> {
      const params = new URLSearchParams({
        pagelen: String(ISSUES_PAGE_LENGTH),
        sort: "updated_on",
      });
      const query = buildBitbucketIssuesQuery(updatedSince);
      if (query) params.set("q", query);

      const issues: BitbucketIssue[] = [];
      let url: string | undefined =
        `${BITBUCKET_API_BASE_URL}${repoPath(workspace, slug)}/issues?${params.toString()}`;
      while (url) {
        const response = await request(url);
        if (!response.ok) {
          throw failure(response, `listing issues for ${workspace}/${slug}`);
        }
        const page = (await response.json()) as Page<BitbucketIssue>;
        issues.push(...(page.values ?? []));
        url = page.next ? assertBitbucketUrl(page.next) : undefined;
      }
      return issues;
    },

    async postIssueComment(
      workspace: string,
      slug: string,
      issueId: number,
      body: string,
    ): Promise<PostedBitbucketComment> {
      const response = await request(
        `${BITBUCKET_API_BASE_URL}${repoPath(workspace, slug)}/issues/${String(issueId)}/comments`,
        { method: "POST", body: JSON.stringify({ content: { raw: body } }) },
      );
      const action = `posting a comment to ${workspace}/${slug}#${String(issueId)}`;
      if (!response.ok) {
        throw failure(response, action);
      }
      const posted = (await response.json()) as CommentBody;
      if (posted.id === undefined) {
        throw new BitbucketApiError(
          `Bitbucket's response was missing the comment id ${action}`,
          response.status,
        );
      }
      return {
        id: String(posted.id),
        url: posted.links?.html?.href ?? null,
      };
    },
  };
};

export type BitbucketClient = ReturnType<typeof createBitbucketClient>;
