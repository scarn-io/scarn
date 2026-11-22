import type { GitHost } from "@scarn/sdk/git-url";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { CoreError } from "@scarn/core/lib/errors";
import { assertNever } from "@scarn/core/lib/assert-never";
import type { GitHubInstallationRepo } from "@scarn/core/integrations/github-installation/application/github-installation-repo";
import {
  requireOwnedInstallationRepo,
  type ResolveInstallationRepo,
} from "@scarn/core/integrations/github-installation/application/find-covering-github-installation";
import {
  getRepo,
  getUser,
} from "@scarn/core/integrations/github-ingest/infra/github-repo-access-client";
import {
  bitbucketIssuesDisabledError,
  createBitbucketClient,
} from "@scarn/core/integrations/bitbucket-ingest/infra/bitbucket-client";
import { verifyJiraScopeAccess } from "@scarn/core/integrations/jira-ingest/application/verify-jira-scope-access";
import type { ResolveCredentialDeps } from "@scarn/core/secrets/secret/application/decrypt-saved-credential";
import { resolveGitHubCredential } from "@scarn/core/secrets/secret/application/resolve-github-credential";
import { resolveBitbucketCredential } from "@scarn/core/secrets/secret/application/resolve-bitbucket-credential";
import { resolveJiraCredential } from "@scarn/core/secrets/secret/application/resolve-jira-credential";
import type { IssueTrackerInput } from "../contracts/project-setup-contracts";

export type VerifyIssueTrackerAccessDeps = ResolveCredentialDeps & {
  githubInstallationRepo: GitHubInstallationRepo;
  /** Matches a renamed or transferred repo's old name to its installation. */
  resolveInstallationRepo?: ResolveInstallationRepo | undefined;
  fetchImpl?: typeof fetch;
};

type GitHubRepoRef = { id: number; fullName: string };

/** What a successful check learned, enough to create the integration. */
export type VerifiedIssueTrackerAccess =
  | { type: "github_app"; installationId: string; repo: GitHubRepoRef }
  | {
      type: "github_token";
      repo: GitHubRepoRef;
      account: string;
      issuesEnabled: boolean;
      secretId: UuidV7 | null;
    }
  | {
      type: "bitbucket";
      repo: { workspace: string; slug: string; fullName: string };
      account: string;
      secretId: UuidV7 | null;
    }
  | {
      type: "jira";
      baseUrl: string;
      projectKeys: string[];
      account: string;
      secretId: UuidV7 | null;
    };

type GitHubHost = Extract<GitHost, { host: "github" }>;
type BitbucketHost = Extract<GitHost, { host: "bitbucket" }>;

const issueTrackerHostMismatchError = (
  type: IssueTrackerInput["type"],
  site: "github.com" | "bitbucket.org",
): CoreError =>
  new CoreError({
    code: "ISSUE_TRACKER_HOST_MISMATCH",
    message: `A ${type} issue tracker only works with a ${site} repository URL`,
    status: 422,
  });

/** The GitHub repo a `github_*` tracker reads; any other host is a mismatch. */
const requireGitHubHost = (
  host: GitHost,
  type: IssueTrackerInput["type"],
): GitHubHost => {
  if (host.host !== "github") {
    throw issueTrackerHostMismatchError(type, "github.com");
  }
  return host;
};

/** The Bitbucket repo a `bitbucket` tracker reads; any other host is a mismatch. */
const requireBitbucketHost = (host: GitHost): BitbucketHost => {
  if (host.host !== "bitbucket") {
    throw issueTrackerHostMismatchError("bitbucket", "bitbucket.org");
  }
  return host;
};

const verifyBitbucketAccess = async (
  host: GitHost,
  issueTracker: Extract<IssueTrackerInput, { type: "bitbucket" }>,
  deps: VerifyIssueTrackerAccessDeps,
): Promise<VerifiedIssueTrackerAccess> => {
  const bitbucket = requireBitbucketHost(host);
  const credential = await resolveBitbucketCredential(
    issueTracker.credential,
    deps,
  );
  const client = createBitbucketClient({
    email: credential.email,
    apiToken: credential.apiToken,
    secretName: credential.secretName,
    fetchImpl: deps.fetchImpl,
  });
  const repo = await client.getRepository(bitbucket.workspace, bitbucket.slug);
  if (!repo.hasIssues) {
    throw bitbucketIssuesDisabledError(repo.fullName);
  }
  const user = await client.getCurrentUser();
  return {
    type: "bitbucket",
    repo: {
      workspace: repo.workspace,
      slug: repo.slug,
      fullName: repo.fullName,
    },
    account: user.displayName ?? user.username ?? credential.email,
    secretId: credential.secretId,
  };
};

const verifyJiraAccess = async (
  issueTracker: Extract<IssueTrackerInput, { type: "jira" }>,
  deps: VerifyIssueTrackerAccessDeps,
): Promise<VerifiedIssueTrackerAccess> => {
  const credential = await resolveJiraCredential(issueTracker.credential, deps);
  const account = await verifyJiraScopeAccess(issueTracker, credential);
  return {
    type: "jira",
    baseUrl: issueTracker.baseUrl,
    projectKeys: issueTracker.projectKeys,
    account: account.displayName ?? account.emailAddress ?? credential.email,
    secretId: credential.secretId,
  };
};

/**
 * Checks that the tracker's credential can read this repo or Jira site
 * before anything is created. Throws `ISSUE_TRACKER_HOST_MISMATCH`, a
 * rejected-credential error, a not-accessible error or
 * `BITBUCKET_ISSUES_DISABLED`; never writes.
 */
export const verifyIssueTrackerAccess = async (
  input: { userId: UuidV7; host: GitHost; issueTracker: IssueTrackerInput },
  deps: VerifyIssueTrackerAccessDeps,
): Promise<VerifiedIssueTrackerAccess> => {
  const { issueTracker } = input;
  switch (issueTracker.type) {
    case "github_app": {
      const github = requireGitHubHost(input.host, issueTracker.type);
      const repo = await requireOwnedInstallationRepo(
        {
          userId: input.userId,
          installationId: issueTracker.installationId,
          owner: github.owner,
          name: github.name,
        },
        deps,
      );
      return {
        type: "github_app",
        installationId: issueTracker.installationId,
        repo,
      };
    }
    case "github_token": {
      const github = requireGitHubHost(input.host, issueTracker.type);
      const credential = await resolveGitHubCredential(
        issueTracker.credential,
        deps,
      );
      const options = {
        secretName: credential.secretName,
        fetchImpl: deps.fetchImpl,
      };
      const repo = await getRepo(
        credential.token,
        github.owner,
        github.name,
        options,
      );
      const user = await getUser(credential.token, options);
      return {
        type: "github_token",
        repo: { id: repo.id, fullName: repo.fullName },
        account: user.login,
        issuesEnabled: repo.hasIssues,
        secretId: credential.secretId,
      };
    }
    case "bitbucket":
      return verifyBitbucketAccess(input.host, issueTracker, deps);
    case "jira":
      return verifyJiraAccess(issueTracker, deps);
    default:
      return assertNever(issueTracker);
  }
};
