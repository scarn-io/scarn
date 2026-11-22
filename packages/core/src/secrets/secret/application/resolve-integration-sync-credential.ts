import {
  AUTO_SYNC_SECRET_KIND,
  type AutoSyncPausedReason,
  type ProjectIntegrationEntityBase,
} from "@scarn/core/integrations/project-integration/domain/project-integration-entity";
import type { ProjectRepo } from "@scarn/core/projects/project/application/project-repo";
import {
  CoreError,
  InvariantViolationError,
  ResourceNotFoundError,
} from "@scarn/core/lib/errors";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import { checkAndDecryptSecret } from "./decrypt-saved-credential";
import type { ResolvedGitHubCredential } from "./resolve-github-credential";
import type { ResolvedJiraCredential } from "./resolve-jira-credential";
import type { SecretCipher } from "./secret-cipher";
import type { SecretRepo } from "./secret-repo";

export type ResolveIntegrationSyncCredentialDeps = {
  secretRepo: Pick<SecretRepo, "findById">;
  secretCipher: SecretCipher;
  projectRepo: Pick<ProjectRepo, "load">;
  timeProvider: TimeProvider;
};

export type ResolvedIntegrationSyncCredential =
  | { kind: "jira"; credential: ResolvedJiraCredential }
  | { kind: "github_token"; credential: ResolvedGitHubCredential };

/**
 * The key lent to an integration can't be used right now, so its auto-sync
 * should pause with `reason`. The message and `detail` may name the key but
 * never carry its value, last four or Jira email.
 */
export class AutoSyncCredentialUnusableError extends CoreError {
  readonly reason: AutoSyncPausedReason;
  readonly detail: string | undefined;

  constructor(reason: AutoSyncPausedReason, detail?: string) {
    super({
      code: "AUTO_SYNC_CREDENTIAL_UNUSABLE",
      message:
        detail === undefined
          ? `Auto-sync key is unusable: ${reason}`
          : `Auto-sync key is unusable: ${reason}. ${detail}`,
      status: 409,
      meta: { reason },
    });
    this.reason = reason;
    this.detail = detail;
  }
}

const SECRET_KIND_LABEL = {
  jira_api_key: "Jira API key",
  github_token: "GitHub token",
  bitbucket_api_token: "Bitbucket API token",
  project_secret: "project secret",
} as const;

/**
 * Turns the key a member lent to `integration` into the credential the
 * auto-sync poller sends upstream. Only the poller calls this; request
 * handlers resolve the caller's own choice through `resolveJiraCredential` /
 * `resolveGitHubCredential`.
 *
 * Throws `AutoSyncCredentialUnusableError` with the pause reason when:
 * - no key is lent, or the lent key was deleted: `key_removed`;
 * - the key's owner is no longer a member of the integration's project:
 *   `owner_left_project`;
 * - the key is not the kind this integration needs (`AUTO_SYNC_SECRET_KIND`):
 *   `key_rejected`, since it can never authenticate this integration;
 * - the key has expired: `key_expired`.
 *
 * An integration kind that can't auto-sync is a caller bug and throws
 * `InvariantViolationError`; so does a missing project, which the
 * integration's foreign key rules out, as `ResourceNotFoundError`.
 */
export const resolveIntegrationSyncCredential = async (
  integration: Pick<
    ProjectIntegrationEntityBase,
    "id" | "kind" | "projectId" | "syncSecretId"
  >,
  deps: ResolveIntegrationSyncCredentialDeps,
): Promise<ResolvedIntegrationSyncCredential> => {
  const expectedKind = AUTO_SYNC_SECRET_KIND[integration.kind];
  if (expectedKind === undefined) {
    throw new InvariantViolationError(
      `Project integration ${integration.id} of kind '${integration.kind}' does not support auto-sync`,
    );
  }
  if (integration.syncSecretId === null) {
    throw new AutoSyncCredentialUnusableError("key_removed");
  }

  const secret = await deps.secretRepo.findById(integration.syncSecretId);
  if (!secret) {
    throw new AutoSyncCredentialUnusableError("key_removed");
  }

  const project = await deps.projectRepo.load(integration.projectId);
  if (!project) {
    throw new ResourceNotFoundError("project", integration.projectId);
  }
  if (
    secret.owner.type === "user" &&
    project.getMembership(secret.owner.userId) === null
  ) {
    throw new AutoSyncCredentialUnusableError("owner_left_project");
  }

  const checked = checkAndDecryptSecret(secret, expectedKind, deps);
  if (!checked.ok) {
    if (checked.problem === "expired") {
      throw new AutoSyncCredentialUnusableError("key_expired");
    }
    throw new AutoSyncCredentialUnusableError(
      "key_rejected",
      `The lent key "${secret.name}" is not a ${SECRET_KIND_LABEL[expectedKind]}.`,
    );
  }

  const lent = checked.secret;
  switch (lent.kind) {
    case "jira_api_key":
      return {
        kind: "jira",
        credential: {
          email: lent.metadata.email,
          apiToken: checked.value,
          secretId: lent.id,
          secretName: lent.name,
        },
      };
    case "github_token":
      return {
        kind: "github_token",
        credential: {
          token: checked.value,
          secretId: lent.id,
          secretName: lent.name,
        },
      };
    default:
      throw new InvariantViolationError(
        `Auto-sync has no credential shape for secret kind '${lent.kind}'`,
      );
  }
};
