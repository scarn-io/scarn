import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { CoreError, ResourceNotFoundError } from "@scarn/core/lib/errors";
import { assertNever } from "@scarn/core/lib/assert-never";
import { verifyJiraScopeAccess } from "@scarn/core/integrations/jira-ingest/application/verify-jira-scope-access";
import { getRepo } from "@scarn/core/integrations/github-ingest/infra/github-repo-access-client";
import type { ResolveCredentialDeps } from "@scarn/core/secrets/secret/application/decrypt-saved-credential";
import { resolveJiraCredential } from "@scarn/core/secrets/secret/application/resolve-jira-credential";
import { resolveGitHubCredential } from "@scarn/core/secrets/secret/application/resolve-github-credential";
import { markSecretUsed } from "@scarn/core/secrets/secret/application/mark-secret-used";
import type {
  GitHubTokenProjectIntegration,
  JiraProjectIntegration,
  ProjectIntegrationEntity,
} from "../domain/project-integration-entity";
import type { ProjectIntegrationRepo } from "./project-integration-repo";

export type EnableIntegrationAutoSyncInput = {
  projectId: UuidV7;
  integrationId: UuidV7;
  secretId: UuidV7;
};

export type EnableIntegrationAutoSyncDeps = ResolveCredentialDeps & {
  projectIntegrationRepo: ProjectIntegrationRepo;
  fetchImpl?: typeof fetch;
};

type AutoSyncIntegration =
  JiraProjectIntegration | GitHubTokenProjectIntegration;

/** Loads the project's integration or throws a 404 for any other project. */
export const requireProjectIntegration = async (
  input: { projectId: UuidV7; integrationId: UuidV7 },
  repo: ProjectIntegrationRepo,
): Promise<ProjectIntegrationEntity> => {
  const integration = await repo.findById(input.integrationId);
  if (!integration || integration.projectId !== input.projectId) {
    throw new ResourceNotFoundError("project integration", input.integrationId);
  }
  return integration;
};

const requireAutoSyncIntegration = (
  integration: ProjectIntegrationEntity,
): AutoSyncIntegration => {
  if (integration.kind === "jira" || integration.kind === "github_token") {
    return integration;
  }
  throw new CoreError({
    code: "PROJECT_INTEGRATION_AUTO_SYNC_UNSUPPORTED",
    message: `A ${integration.kind} integration can't sync automatically with a lent key`,
    status: 400,
  });
};

const verifyLentKey = async (
  integration: AutoSyncIntegration,
  secretId: UuidV7,
  deps: EnableIntegrationAutoSyncDeps,
): Promise<void> => {
  switch (integration.kind) {
    case "jira": {
      const credential = await resolveJiraCredential({ secretId }, deps);
      await verifyJiraScopeAccess(integration.scope, credential);
      return;
    }
    case "github_token": {
      const credential = await resolveGitHubCredential({ secretId }, deps);
      const options = {
        secretName: credential.secretName,
        fetchImpl: deps.fetchImpl,
      };
      for (const repo of integration.scope.repos) {
        const [owner = "", name = ""] = repo.fullName.split("/");
        await getRepo(credential.token, owner, name, options);
      }
      return;
    }
    default:
      return assertNever(integration);
  }
};

/**
 * Lends the caller's saved key to a `jira` or `github_token` integration so
 * Scarn syncs it on a schedule. Also takes over from whoever lent it before.
 * The key must belong to the caller, match the integration's kind and be able
 * to read the integration's whole scope; nothing is saved otherwise.
 */
export const enableIntegrationAutoSync = async (
  input: EnableIntegrationAutoSyncInput,
  deps: EnableIntegrationAutoSyncDeps,
): Promise<ProjectIntegrationEntity> => {
  await deps.userAuthz.requireProjectPermission({
    projectId: input.projectId,
    permission: "integrations:write",
  });
  const integration = requireAutoSyncIntegration(
    await requireProjectIntegration(input, deps.projectIntegrationRepo),
  );

  await verifyLentKey(integration, input.secretId, deps);

  const saved = await deps.projectIntegrationRepo.save(
    integration.withAutoSync(input.secretId),
  );
  await markSecretUsed(input.secretId, deps);
  return saved;
};
