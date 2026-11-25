import type { Logger } from "@scarn/observability/logging";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import {
  CoreError,
  CoreValidationError,
  ResourceNotFoundError,
} from "@scarn/core/lib/errors";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { ProjectIntegrationRepo } from "@scarn/core/integrations/project-integration/application/project-integration-repo";
import {
  isGitHubIntegration,
  isUserCredentialIntegration,
} from "@scarn/core/integrations/project-integration/domain/project-integration-entity";
import { resolveGitHubAccessToken } from "@scarn/core/integrations/github-ingest/application/resolve-github-access-token";
import type { ObjectStore } from "@scarn/core/artifacts/object-store";
import type { ArtifactRepo } from "@scarn/core/tasks/task-artifact/application/artifact-repo";
import {
  GitHubCommentError,
  postIssueComment,
} from "@scarn/core/integrations/github-ingest/infra/github-comment-client";
import { splitRepoFullName } from "@scarn/core/integrations/github-ingest/infra/github-issues-client";
import type { WorkItemRepo } from "@scarn/core/work-items/work-item/application/work-item-repo";
import { parseWorkItemId } from "@scarn/core/work-items/work-item/domain/work-item-id";
import type { WorkItemCommentRepo } from "@scarn/core/work-items/work-item-comment/application/work-item-comment-repo";
import { WorkItemCommentEntity } from "@scarn/core/work-items/work-item-comment/domain/work-item-comment-entity";
import { workItemCommentEntityToContract } from "@scarn/core/work-items/work-item-comment/application/work-item-comment-contract-mapper";
import type { WorkItemCommentContract } from "@scarn/core/work-items/work-item-comment/contracts/work-item-comment-contracts";
import type { NotificationDeliveryRepo } from "@scarn/core/notifications/notification-delivery/application/notification-delivery-repo";
import type { IntegrationCredentialChoice } from "@scarn/core/secrets/secret/contracts/secret-contracts";
import {
  githubCredentialRejectedError,
  resolveGitHubCredential,
} from "@scarn/core/secrets/secret/application/resolve-github-credential";
import type { SecretRepo } from "@scarn/core/secrets/secret/application/secret-repo";
import type { SecretCipher } from "@scarn/core/secrets/secret/application/secret-cipher";
import { markSecretUsed } from "@scarn/core/secrets/secret/application/mark-secret-used";
import type { UserNotificationRepo } from "../user-notification-repo";
import { loadPendingCommentDraft } from "./load-pending-comment-draft";
import { recomputeAndPersistNotificationStatus } from "./recompute-and-persist-notification-status";
import { postBitbucketCommentDraft } from "./post-bitbucket-comment-draft";
import {
  renderCommentDraftArtifacts,
  resolveCommentDraftArtifacts,
  type RenderedCommentDraft,
} from "./render-comment-draft-artifacts";
import { postJiraCommentDraft } from "./post-jira-comment-draft";
import { createCommentDraftDeliveryTracker } from "./comment-draft-delivery-tracker";
import type { CommentArtifactReader } from "@scarn/core/notifications/comment-artifacts/application/comment-artifact-reader";
import {
  artifactPlatforms,
  type ArtifactPlatform,
} from "@scarn/sdk/contracts/artifacts";

export type ApproveCommentDraftInput = {
  notificationId: UuidV7;
  body: string;
  githubApp: {
    appId: string;
    privateKey: string;
  };
  /**
   * The approver's own credential: required for a Jira or Bitbucket work
   * item, or a GitHub work item whose integration uses a personal token;
   * ignored for the App.
   */
  credential?: IntegrationCredentialChoice;
  /** Base of artifact page links in the posted comment. */
  appBaseUrl?: string | null;
};

const toArtifactPlatform = (platform: string): ArtifactPlatform | null =>
  (artifactPlatforms as readonly string[]).includes(platform)
    ? (platform as ArtifactPlatform)
    : null;

export { deriveJiraProjectKey } from "./post-jira-comment-draft";

export type ApproveCommentDraftDeps = {
  userAuthz: UserAuthorizationService;
  userNotificationRepo: UserNotificationRepo;
  notificationDeliveryRepo: NotificationDeliveryRepo;
  workItemRepo: WorkItemRepo;
  workItemCommentRepo: WorkItemCommentRepo;
  projectIntegrationRepo: ProjectIntegrationRepo;
  secretRepo: SecretRepo;
  secretCipher: SecretCipher;
  commentArtifactReader: CommentArtifactReader;
  artifactRepo: ArtifactRepo;
  /** Where Jira embeds read artifact bytes from; null when unconfigured. */
  objectStore: ObjectStore | null;
  timeProvider: TimeProvider;
  dbExecutor?: DbExecutor;
  fetchImpl?: typeof fetch;
  logger?: Logger;
};

/**
 * Approves a pending `work_item_platform_comment` draft (a notification, of
 * any kind, that suggested that channel): posts `input.body` (possibly
 * human-edited from the original draft text) to the work item's originating
 * GitHub issue, Bitbucket issue or Jira ticket, then records the outcome on the delivery row.
 * A work item on any other platform has nowhere external to post to, so the
 * platform post is skipped and the comment lives only in Scarn.
 *
 * On success, the promoted comment becomes a permanent, agent-authored
 * `work_item_comments` row (Decision 9) and the delivery is marked `"sent"`.
 * On failure, the delivery is marked `"failed"` so Approve can be retried
 * without a separate action (Decision 7/10), and the GitHub error is
 * surfaced to the caller as a 502 rather than a 500. Either way, the parent
 * notification's own `status` is recomputed from *all* of its deliveries via
 * `UserNotificationEntity.deriveStatus()` (Decisions 5/6), not hardcoded —
 * a mixed-channel notification may already have an unrelated `in_app`
 * delivery outcome that must not be clobbered.
 */
export const approveCommentDraft = async (
  input: ApproveCommentDraftInput,
  deps: ApproveCommentDraftDeps,
): Promise<WorkItemCommentContract> => {
  // Loaded before the permission check (no `:projectId` in this flat route's
  // URL) — the notification's own `projectId` is the authorization scope,
  // matching `edit-work-item-comment.ts`'s "load first, authorize against the
  // loaded row" pattern.
  const { notification, delivery } = await loadPendingCommentDraft(
    input.notificationId,
    deps.userNotificationRepo,
    deps.notificationDeliveryRepo,
    deps.dbExecutor,
  );

  await deps.userAuthz.requireProjectPermission({
    projectId: notification.projectId,
    permission: "work-item-platform-comment:write",
    dbExecutor: deps.dbExecutor,
  });

  if (notification.workItemId === null) {
    throw new ResourceNotFoundError("Work item", "unknown");
  }

  const workItem = await deps.workItemRepo.load(
    parseWorkItemId(notification.workItemId),
    deps.dbExecutor,
  );
  if (!workItem) {
    throw new ResourceNotFoundError("Work item", notification.workItemId);
  }

  const resolved = await resolveCommentDraftArtifacts(
    {
      body: input.body,
      projectId: notification.projectId,
      pipelineRunId: notification.pipelineExecutionId,
      platform: toArtifactPlatform(workItem.platform),
      appBaseUrl: input.appBaseUrl ?? null,
    },
    deps,
  );
  const tracker = createCommentDraftDeliveryTracker(delivery, deps);

  // Records the failed delivery and recomputes the parent notification's
  // status before rethrowing, mirroring Decision 7 (see the module doc
  // comment): "actionable" is a property of the delivery row, so a failed
  // post must still leave Approve retryable.
  const failPost = async (
    message: string,
    code: string,
    status = 502,
  ): Promise<never> => {
    await tracker.update((current) => current.markFailed(message));
    await recomputeAndPersistNotificationStatus(
      notification.id,
      deps.notificationDeliveryRepo,
      deps.userNotificationRepo,
      deps.dbExecutor,
    );
    throw new CoreError({ code, message, status });
  };

  let posted: { id: string; url: string | null } | null = null;
  let rendered: RenderedCommentDraft;

  if (workItem.platform === "github") {
    rendered = await renderCommentDraftArtifacts(resolved);
    const integrations = await deps.projectIntegrationRepo.listByProjectId(
      workItem.projectId,
      deps.dbExecutor,
    );
    const repositoryField = workItem.fields["repository"];
    if (typeof repositoryField !== "string") {
      throw new CoreValidationError(
        "Work item is missing a GitHub repository field",
        "WORK_ITEM_MISSING_GITHUB_REPOSITORY",
      );
    }
    const { owner, repo } = splitRepoFullName(repositoryField);

    const activeGitHub = integrations
      .filter(isGitHubIntegration)
      .filter((candidate) => candidate.status === "active");
    const integration =
      activeGitHub.find((candidate) =>
        candidate.scope.repos.some(
          (scoped) =>
            scoped.fullName.toLowerCase() === repositoryField.toLowerCase(),
        ),
      ) ?? activeGitHub[0];
    if (!integration) {
      throw new ResourceNotFoundError(
        "GitHub project integration",
        workItem.projectId,
      );
    }

    const accessInput = {
      integration,
      githubApp: input.githubApp,
      credential: isUserCredentialIntegration(integration)
        ? await resolveGitHubCredential(input.credential, deps)
        : undefined,
    };
    const userAccess = accessInput.credential ?? null;

    const numberField = workItem.fields["number"];
    if (typeof numberField !== "number") {
      throw new CoreValidationError(
        "Work item is missing a GitHub issue number",
        "WORK_ITEM_MISSING_GITHUB_NUMBER",
      );
    }

    try {
      const access =
        userAccess ?? (await resolveGitHubAccessToken(accessInput, deps));

      const postedComment = await postIssueComment({
        installationToken: access.token,
        owner,
        repo,
        issueNumber: numberField,
        body: rendered.body,
        fetchImpl: deps.fetchImpl,
      });

      posted = { id: postedComment.id, url: postedComment.htmlUrl };
    } catch (error) {
      if (
        userAccess &&
        error instanceof GitHubCommentError &&
        error.status === 401
      ) {
        const rejected = githubCredentialRejectedError(userAccess);
        return failPost(rejected.message, rejected.code, rejected.status);
      }
      const message = error instanceof Error ? error.message : String(error);
      return failPost(message, "COMMENT_DRAFT_GITHUB_POST_FAILED");
    }
    await markSecretUsed(userAccess?.secretId ?? null, deps);
  } else if (workItem.platform === "jira") {
    ({ posted, rendered } = await postJiraCommentDraft(
      { workItem, draft: resolved, credential: input.credential },
      deps,
      tracker,
      failPost,
    ));
  } else if (workItem.platform === "bitbucket") {
    rendered = await renderCommentDraftArtifacts(resolved);
    posted = await postBitbucketCommentDraft(
      { workItem, body: rendered.body, credential: input.credential },
      deps,
      failPost,
    );
  } else {
    rendered = await renderCommentDraftArtifacts(resolved);
  }

  const now = deps.timeProvider.now();

  await tracker.update((current) =>
    current
      .markSent(
        { externalId: posted?.id ?? null, externalUrl: posted?.url ?? null },
        now,
      )
      .withArtifactResolution(
        rendered.artifactResolutionJson ?? current.artifactResolutionJson,
      ),
  );
  await recomputeAndPersistNotificationStatus(
    notification.id,
    deps.notificationDeliveryRepo,
    deps.userNotificationRepo,
    deps.dbExecutor,
  );

  const commentEntity = WorkItemCommentEntity.createFromApprovedDraft({
    projectId: workItem.projectId,
    workItemId: parseUuidV7(workItem.id),
    agentSessionId: notification.agentSessionId,
    sourceNotificationId: notification.id,
    body: rendered.body,
    externalCommentId: posted?.id ?? null,
    externalCommentUrl: posted?.url ?? null,
    createdAt: now,
    updatedAt: now,
  });
  const persisted = await deps.workItemCommentRepo.create(
    commentEntity,
    deps.dbExecutor,
  );

  return workItemCommentEntityToContract(persisted);
};
