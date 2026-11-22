import { parseGitHost } from "@scarn/sdk/git-url";
import { assertNever } from "@scarn/core/lib/assert-never";
import { CoreValidationError } from "@scarn/core/lib/errors";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { Logger } from "@scarn/observability/logging";
import type { ProjectIntegrationRepo } from "@scarn/core/integrations/project-integration/application/project-integration-repo";
import {
  createProjectIntegration,
  type CreateProjectIntegrationInput,
} from "@scarn/core/integrations/project-integration/application/create-project-integration";
import type { IntegrationCredentialChoice } from "@scarn/core/secrets/secret/contracts/secret-contracts";
import { markSecretUsed } from "@scarn/core/secrets/secret/application/mark-secret-used";
import type {
  CreateProjectInput,
  ProjectContract,
  ProjectCreationSource,
} from "../contracts/project-contracts";
import {
  setUpProjectInputSchema,
  type IssueTrackerInput,
  type SetUpProjectInput,
  type SetUpProjectResponse,
} from "../contracts/project-setup-contracts";
import {
  verifyIssueTrackerAccess,
  type VerifiedIssueTrackerAccess,
  type VerifyIssueTrackerAccessDeps,
} from "./verify-issue-tracker-access";

export type SetUpProjectDeps = VerifyIssueTrackerAccessDeps & {
  projectIntegrationRepo: ProjectIntegrationRepo;
  logger: Logger;
  createProject: (
    input: CreateProjectInput & { source: ProjectCreationSource },
  ) => Promise<ProjectContract>;
  /** The first sync, run with the same credential the request carried. */
  runInitialSync: (input: {
    projectId: UuidV7;
    integrationId: UuidV7;
    credential: IntegrationCredentialChoice | undefined;
  }) => Promise<unknown>;
};

const toIntegrationInput = (
  projectId: UuidV7,
  access: VerifiedIssueTrackerAccess,
  firstSyncHorizonDays: number | undefined,
): CreateProjectIntegrationInput => {
  switch (access.type) {
    case "github_app":
      return {
        projectId,
        kind: "github_app",
        installationId: access.installationId,
        firstSyncHorizonDays,
        externalScope: { repos: [access.repo] },
      };
    case "github_token":
      return {
        projectId,
        kind: "github_token",
        firstSyncHorizonDays,
        externalScope: { repos: [access.repo] },
      };
    case "bitbucket":
      return {
        projectId,
        kind: "bitbucket",
        firstSyncHorizonDays,
        externalScope: { repos: [access.repo] },
      };
    case "jira":
      return {
        projectId,
        kind: "jira",
        firstSyncHorizonDays,
        externalScope: {
          baseUrl: access.baseUrl,
          projectKeys: access.projectKeys,
        },
      };
    default:
      return assertNever(access);
  }
};

/**
 * The saved key to lend the new integration, or null. Access was already
 * verified against the same repo or Jira keys the integration's scope holds.
 */
const lentSecretIdOf = (
  issueTracker: IssueTrackerInput,
  access: VerifiedIssueTrackerAccess,
): UuidV7 | null => {
  if (!("autoSync" in issueTracker) || !issueTracker.autoSync) return null;
  if (access.type === "github_app" || access.secretId === null) {
    throw new CoreValidationError(
      "Only a saved key can sync automatically; save the key first",
      "PROJECT_INTEGRATION_AUTO_SYNC_NEEDS_SAVED_KEY",
    );
  }
  return access.secretId;
};

const credentialOf = (
  issueTracker: IssueTrackerInput,
): IntegrationCredentialChoice | undefined =>
  issueTracker.type === "github_app" ? undefined : issueTracker.credential;

/**
 * Creates a project and, when asked, connects its issue tracker:
 * 1. checks the tracker fits the repo's host and that the credential can read
 *    the repo or Jira site, before anything is written;
 * 2. creates the project, then the integration, lending it the caller's saved
 *    key for auto-sync when `autoSync` is set (a pasted key is rejected);
 * 3. runs a best-effort first sync with the same credential. A failed sync
 *    keeps the project and integration and sets `initialSyncFailed`.
 * Never saves a credential.
 */
export const setUpProject = async (
  input: SetUpProjectInput & { userId: UuidV7 },
  deps: SetUpProjectDeps,
): Promise<SetUpProjectResponse> => {
  const { issueTracker, ...projectInput } =
    setUpProjectInputSchema.parse(input);
  const host = parseGitHost(projectInput.gitUrl);

  const access = issueTracker
    ? await verifyIssueTrackerAccess(
        { userId: input.userId, host, issueTracker },
        deps,
      )
    : null;

  const lentSecretId =
    issueTracker && access ? lentSecretIdOf(issueTracker, access) : null;

  const project = await deps.createProject({
    ...projectInput,
    source: host.host === "other" ? "manual" : host.host,
  });

  if (!issueTracker || !access) {
    return { ...project, initialSyncFailed: false };
  }

  const integration = await createProjectIntegration(
    {
      ...toIntegrationInput(
        project.id,
        access,
        issueTracker.firstSyncHorizonDays,
      ),
      syncSecretId: lentSecretId,
    },
    deps.projectIntegrationRepo,
  );
  if (access.type !== "github_app") {
    await markSecretUsed(access.secretId, deps);
  }

  let initialSyncFailed = false;
  try {
    await deps.runInitialSync({
      projectId: project.id,
      integrationId: integration.id,
      credential: credentialOf(issueTracker),
    });
  } catch (error: unknown) {
    initialSyncFailed = true;
    deps.logger.error(
      { err: error, projectId: project.id, integrationId: integration.id },
      "Initial issue sync failed during project set-up",
    );
  }

  return { ...project, initialSyncFailed };
};
