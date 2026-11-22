import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { assertNever } from "@scarn/core/lib/assert-never";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { GitHubProjectIntegration } from "@scarn/core/integrations/project-integration/domain/project-integration-entity";
import { mintGitHubInstallationToken } from "@scarn/core/integrations/github-installation/infra/mint-installation-token";
import {
  githubTokenRequiredError,
  type ResolvedGitHubCredential,
} from "@scarn/core/secrets/secret/application/resolve-github-credential";

export type GitHubAppCredentials = {
  appId: string;
  privateKey: string;
};

export type ResolveGitHubAccessTokenInput = {
  integration: GitHubProjectIntegration;
  githubApp: GitHubAppCredentials;
  /**
   * The GitHub token a `github_token` integration uses, already resolved by
   * the caller (the requesting user's own, or a lent one); ignored by an App
   * integration.
   */
  credential?: ResolvedGitHubCredential;
};

export type ResolveGitHubAccessTokenDeps = {
  timeProvider: TimeProvider;
  fetchImpl?: typeof fetch;
};

export type ResolvedGitHubAccessToken = {
  token: string;
  /** The saved secret the token came from; null for an App or pasted token. */
  secretId: UuidV7 | null;
  /** The saved secret's name; null for an App or pasted token. */
  secretName: string | null;
};

/**
 * The one place that picks the token a GitHub integration reads and writes
 * with: an App integration mints an installation token, a token integration
 * uses the GitHub token the caller already resolved.
 */
export const resolveGitHubAccessToken = async (
  input: ResolveGitHubAccessTokenInput,
  deps: ResolveGitHubAccessTokenDeps,
): Promise<ResolvedGitHubAccessToken> => {
  const { integration } = input;
  switch (integration.kind) {
    case "github_app": {
      const installationToken = await mintGitHubInstallationToken({
        appId: input.githubApp.appId,
        privateKey: input.githubApp.privateKey,
        installationId: integration.installationId,
        now: deps.timeProvider.now(),
        fetchImpl: deps.fetchImpl,
      });
      return {
        token: installationToken.token,
        secretId: null,
        secretName: null,
      };
    }
    case "github_token":
      if (!input.credential) throw githubTokenRequiredError();
      return input.credential;
    default:
      return assertNever(integration);
  }
};
