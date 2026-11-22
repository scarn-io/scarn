import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { Logger } from "@scarn/observability/logging";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { ProjectIntegrationRepo } from "@scarn/core/integrations/project-integration/application/project-integration-repo";
import type {
  UpsertWorkItemInput,
  WorkItemContract,
} from "@scarn/core/work-items/work-item/contracts/work-item-contracts";
import type { WorkItemRepo } from "@scarn/core/work-items/work-item/application/work-item-repo";
import type { WorkItemBlockRepo } from "@scarn/core/work-items/work-item-block/application/work-item-block-repo";
import type { WorkItemEventsPort } from "@scarn/core/work-items/work-item/application/work-item-events-port";
import type { GithubRelationshipPendingRefRepo } from "@scarn/core/integrations/github-ingest/application/github-relationship-pending-ref-repo";
import type { GitHubRateLimitSignal } from "@scarn/core/integrations/github-ingest/infra/github-rate-limit";
import type { IntegrationCredentialChoice } from "@scarn/core/secrets/secret/contracts/secret-contracts";
import type { SecretRepo } from "@scarn/core/secrets/secret/application/secret-repo";
import type { SecretCipher } from "@scarn/core/secrets/secret/application/secret-cipher";
import type { GitHubAppCredentials } from "./resolve-github-access-token";

export type RunProjectIntegrationSyncDeps = {
  userAuthz: UserAuthorizationService;
  projectIntegrationRepo: ProjectIntegrationRepo;
  workItemRepo: WorkItemRepo;
  workItemBlockRepo: WorkItemBlockRepo;
  workItemEvents: WorkItemEventsPort;
  githubRelationshipPendingRefRepo: GithubRelationshipPendingRefRepo;
  /**
   * Upserts through `upsertWorkItems`, telling `workItemEvents` (the
   * platform sync's, which may hold them back) about the writes.
   */
  upsertWorkItems: (
    items: UpsertWorkItemInput[],
    workItemEvents: WorkItemEventsPort,
  ) => Promise<WorkItemContract[]>;
  secretRepo: SecretRepo;
  secretCipher: SecretCipher;
  timeProvider: TimeProvider;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  githubRateLimitSignal?: GitHubRateLimitSignal;
};

export type RunProjectIntegrationSyncInput = {
  projectId: UuidV7;
  integrationId: UuidV7;
  githubApp: GitHubAppCredentials;
  /**
   * The requesting user's credential, required by a `user_credential`
   * integration (a GitHub token, Bitbucket API token or Jira API key) and
   * ignored by an App one.
   */
  credential?: IntegrationCredentialChoice;
  cause: "manual" | "scheduled";
};

export type ProjectIntegrationSyncResult = {
  totalUpserted: number;
  perSource: Array<{ key: string; totalSeen: number; totalUpserted: number }>;
  /**
   * GitHub-only relationship-ingestion counts (see
   * `ingestGitHubIssueRelationships`) — optional because the other branches
   * never populate them; observability only, not behavior.
   */
  parentLinksApplied?: number;
  parentLinksSkipped?: number;
  blocksCreated?: number;
  blocksSkipped?: number;
};
