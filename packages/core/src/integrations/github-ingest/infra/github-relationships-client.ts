import {
  GitHubIngestError,
  gitHubIngestErrorFromResponse,
} from "./github-issues-client";
import type { GitHubRateLimitSignal } from "./github-rate-limit";

export type GitHubIssueRef = { owner: string; repo: string; number: number };

export type IssueRelationships = {
  /** The issue's parent (native GitHub Sub-issues), or `null` if unset. */
  parent: GitHubIssueRef | null;
  blockedBy: GitHubIssueRef[];
};

export type FetchIssueRelationshipsBatchInput = {
  accessToken: string;
  refs: GitHubIssueRef[];
  fetchImpl?: typeof fetch;
  rateLimitSignal?: GitHubRateLimitSignal;
};

/**
 * Max number of issues (across however many repos a batch spans) bundled
 * into a single aliased GraphQL query.
 */
export const GITHUB_RELATIONSHIP_BATCH_SIZE = 50;

/**
 * `blockedBy` is fetched as a fixed, non-cursor-paginated sub-page. An issue
 * with more than this many `blocked_by` dependencies has the rest silently
 * truncated — a known v1 limit, not expected to matter in practice.
 */
const BLOCKED_BY_PAGE_SIZE = 25;

const githubGraphQLHeaders = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "content-type": "application/json",
  "user-agent": "scarn",
});

const platformKey = (ref: {
  owner: string;
  repo: string;
  number: number;
}): string => `${ref.owner}/${ref.repo}#${String(ref.number)}`;

type RepoGroup = { owner: string; repo: string; numbers: number[] };

const groupRefsByRepo = (refs: GitHubIssueRef[]): RepoGroup[] => {
  const groups = new Map<string, RepoGroup>();
  for (const ref of refs) {
    const key = `${ref.owner}/${ref.repo}`;
    let group = groups.get(key);
    if (!group) {
      group = { owner: ref.owner, repo: ref.repo, numbers: [] };
      groups.set(key, group);
    }
    group.numbers.push(ref.number);
  }
  return [...groups.values()];
};

/**
 * Splits repo groups into batches of at most `GITHUB_RELATIONSHIP_BATCH_SIZE`
 * issues total, splitting a single repo's issues across multiple batches
 * when it alone would exceed the limit.
 */
const batchRepoGroups = (groups: RepoGroup[]): RepoGroup[][] => {
  const batches: RepoGroup[][] = [];
  let current: RepoGroup[] = [];
  let currentCount = 0;

  for (const group of groups) {
    let remaining = group.numbers;
    while (remaining.length > 0) {
      const spaceLeft = GITHUB_RELATIONSHIP_BATCH_SIZE - currentCount;
      if (spaceLeft <= 0) {
        batches.push(current);
        current = [];
        currentCount = 0;
        continue;
      }
      const chunk = remaining.slice(0, spaceLeft);
      remaining = remaining.slice(spaceLeft);
      current.push({ owner: group.owner, repo: group.repo, numbers: chunk });
      currentCount += chunk.length;
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
};

const buildQuery = (batch: RepoGroup[]): string => {
  const repoBlocks = batch.map((group, repoIndex) => {
    const issueBlocks = group.numbers.map((number, issueIndex) => {
      return `i${String(issueIndex)}: issue(number: ${String(number)}) { parent { number repository { owner { login } name } } blockedBy(first: ${String(BLOCKED_BY_PAGE_SIZE)}) { nodes { number repository { owner { login } name } } } }`;
    });
    return `r${String(repoIndex)}: repository(owner: ${JSON.stringify(group.owner)}, name: ${JSON.stringify(group.repo)}) { ${issueBlocks.join(" ")} }`;
  });
  return `{ ${repoBlocks.join(" ")} }`;
};

type GraphQLIssueNode = {
  number?: number | null;
  repository?: {
    owner?: { login?: string | null } | null;
    name?: string | null;
  } | null;
} | null;

type GraphQLIssueField = {
  parent?: GraphQLIssueNode;
  blockedBy?: { nodes?: GraphQLIssueNode[] | null } | null;
} | null;

type GraphQLRepositoryField =
  Record<string, GraphQLIssueField> | null | undefined;

type GraphQLResponsePayload = {
  data?: Record<string, GraphQLRepositoryField> | null;
  errors?: Array<{ message: string }>;
};

/**
 * Parses a `GraphQLIssueNode` (the shape shared by `parent` and each
 * `blockedBy.nodes` entry) into a `GitHubIssueRef`, or `null` if the node is
 * absent or missing the fields needed to identify an issue.
 */
const parseIssueNode = (node: GraphQLIssueNode): GitHubIssueRef | null => {
  const owner = node?.repository?.owner?.login;
  const repo = node?.repository?.name;
  if (!node || typeof node.number !== "number" || !owner || !repo) {
    return null;
  }
  return { owner, repo, number: node.number };
};

/**
 * The batch's repo when it spans exactly one, so a failure can name it; a
 * multi-repo batch can't say which repo caused it.
 */
const batchRepoFullName = (batch: RepoGroup[]): string | undefined => {
  const names = new Set(batch.map((group) => `${group.owner}/${group.repo}`));
  return names.size === 1 ? [...names][0] : undefined;
};

const executeBatch = async (
  batch: RepoGroup[],
  accessToken: string,
  fetchImpl: typeof fetch,
  rateLimitSignal: GitHubRateLimitSignal | undefined,
): Promise<Map<string, IssueRelationships>> => {
  const response = await fetchImpl("https://api.github.com/graphql", {
    method: "POST",
    headers: githubGraphQLHeaders(accessToken),
    body: JSON.stringify({ query: buildQuery(batch) }),
  });
  rateLimitSignal?.recordResponse(response);

  if (!response.ok) {
    throw gitHubIngestErrorFromResponse(
      `GitHub returned ${String(response.status)} fetching issue relationships`,
      response,
      batchRepoFullName(batch),
    );
  }

  const payload = (await response.json()) as GraphQLResponsePayload;

  if (!payload.data) {
    const message =
      payload.errors?.map((error) => error.message).join("; ") ??
      "GitHub GraphQL response had no data";
    throw new GitHubIngestError(
      `GitHub GraphQL request failed: ${message}`,
      response.status,
      { repoFullName: batchRepoFullName(batch) },
    );
  }

  const result = new Map<string, IssueRelationships>();
  for (const [repoIndex, group] of batch.entries()) {
    const repoField = payload.data[`r${String(repoIndex)}`];
    for (const [issueIndex, number] of group.numbers.entries()) {
      const issueField = repoField?.[`i${String(issueIndex)}`];
      const blockedByRefs = (issueField?.blockedBy?.nodes ?? [])
        .map(parseIssueNode)
        .filter((ref): ref is GitHubIssueRef => ref !== null);
      result.set(
        platformKey({ owner: group.owner, repo: group.repo, number }),
        {
          parent: parseIssueNode(issueField?.parent ?? null),
          blockedBy: blockedByRefs,
        },
      );
    }
  }
  return result;
};

export async function fetchIssueRelationshipsBatch({
  accessToken,
  refs,
  fetchImpl = fetch,
  rateLimitSignal,
}: FetchIssueRelationshipsBatchInput): Promise<
  Map<string, IssueRelationships>
> {
  if (refs.length === 0) return new Map();

  const batches = batchRepoGroups(groupRefsByRepo(refs));

  const result = new Map<string, IssueRelationships>();
  for (const batch of batches) {
    const batchResult = await executeBatch(
      batch,
      accessToken,
      fetchImpl,
      rateLimitSignal,
    );
    for (const [key, value] of batchResult) {
      result.set(key, value);
    }
  }
  return result;
}
