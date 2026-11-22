import { noopLogger } from "@scarn/observability/logging";
import { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import {
  CoreValidationError,
  ResourceNotFoundError,
} from "@scarn/core/lib/errors";
import { isJiraIntegration } from "@scarn/core/integrations/project-integration/domain/project-integration-entity";
import {
  postJiraIssueComment,
  JiraCommentError,
} from "@scarn/core/integrations/jira-ingest/infra/jira-comment-client";
import { JiraAttachmentError } from "@scarn/core/integrations/jira-ingest/infra/jira-attachment-uploader";
import {
  JiraCommentArtifactRenderer,
  type ArtifactBytes,
} from "@scarn/core/integrations/jira-ingest/infra/jira-comment-artifact-renderer";
import {
  markdownToAdf,
  type AdfDocument,
} from "@scarn/core/integrations/jira-ingest/infra/markdown-to-adf";
import type { ResolvedCommentArtifact } from "@scarn/core/notifications/comment-artifacts/domain/comment-artifact-types";
import {
  readArtifactMarkerOutcomes,
  recordArtifactMarkerOutcome,
} from "@scarn/core/notifications/comment-artifacts/domain/artifact-resolution-json";
import type { WorkItemEntity } from "@scarn/core/work-items/work-item/domain/work-item-entity";
import type { IntegrationCredentialChoice } from "@scarn/core/secrets/secret/contracts/secret-contracts";
import {
  jiraCredentialRejectedError,
  resolveJiraCredential,
} from "@scarn/core/secrets/secret/application/resolve-jira-credential";
import { markSecretUsed } from "@scarn/core/secrets/secret/application/mark-secret-used";
import type { ApproveCommentDraftDeps } from "./approve-comment-draft";
import type { FailCommentPost } from "./post-bitbucket-comment-draft";
import type { CommentDraftDeliveryTracker } from "./comment-draft-delivery-tracker";
import {
  renderCommentDraftArtifacts,
  type RenderedCommentDraft,
  type ResolvedCommentDraft,
} from "./render-comment-draft-artifacts";

/**
 * Derives a Jira project key from a work item's `platformKey` (e.g.
 * `"PROJ-123"` -> `"PROJ"`) by splitting on the last `-`. Pure string logic,
 * kept separate from the integration-resolution flow so it stays
 * unit-testable in isolation (Decision 2 in
 * `docs/plans/jira-comment-approval.md`).
 */
export const deriveJiraProjectKey = (platformKey: string): string => {
  const lastDashIndex = platformKey.lastIndexOf("-");
  return lastDashIndex === -1
    ? platformKey
    : platformKey.slice(0, lastDashIndex);
};

export const READ_ARTIFACT_TIMEOUT_MS = 60_000;

/**
 * Reads an artifact's bytes straight from the artifact store. These are
 * platform deliveries, not user downloads, so they are not checked against
 * or counted toward the org's read quota. A read that outlasts the timeout
 * throws, failing the post so Approve stays retryable.
 */
const readArtifactBytes = async (
  artifact: ResolvedCommentArtifact,
  deps: ApproveCommentDraftDeps,
): Promise<ArtifactBytes | null> => {
  if (!deps.objectStore) return null;
  const row = await deps.artifactRepo.findById(
    parseUuidV7(artifact.artifactId),
    deps.dbExecutor,
  );
  if (!row?.objectKey || row.storeRef === null) return null;
  const stored = await deps.objectStore.getObject(row.objectKey, {
    signal: AbortSignal.timeout(READ_ARTIFACT_TIMEOUT_MS),
  });
  return stored
    ? { bytes: stored.body, contentType: stored.contentType ?? row.contentType }
    : null;
};

/**
 * Posts an approved draft to a Jira Cloud issue with the approver's own
 * email + API token. Embeddable artifacts are attached to the issue first,
 * each upload's outcome is saved on the delivery before the comment is
 * posted, and a retry reuses those outcomes rather than uploading again.
 * A failed upload or post goes through `failPost`, so Approve stays
 * retryable.
 */
export const postJiraCommentDraft = async (
  {
    workItem,
    draft,
    credential: choice,
  }: {
    workItem: WorkItemEntity;
    draft: ResolvedCommentDraft;
    credential: IntegrationCredentialChoice | undefined;
  },
  deps: ApproveCommentDraftDeps,
  tracker: CommentDraftDeliveryTracker,
  failPost: FailCommentPost,
): Promise<{
  posted: { id: string; url: string | null };
  rendered: RenderedCommentDraft;
}> => {
  const credential = await resolveJiraCredential(choice, deps);

  const integrations = await deps.projectIntegrationRepo.listByProjectId(
    workItem.projectId,
    deps.dbExecutor,
  );
  const projectKey = deriveJiraProjectKey(workItem.platformKey);
  const matches = integrations
    .filter(isJiraIntegration)
    .filter(
      (candidate) =>
        candidate.status === "active" &&
        candidate.scope.projectKeys.includes(projectKey),
    );
  const [onlyMatch, ...extraMatches] = matches;
  if (!onlyMatch) {
    throw new ResourceNotFoundError(
      "Jira project integration",
      workItem.projectId,
    );
  }
  if (extraMatches.length > 0) {
    throw new CoreValidationError(
      "Multiple active Jira integrations match this work item's project",
      "WORK_ITEM_JIRA_INTEGRATION_AMBIGUOUS",
    );
  }
  const connection = {
    baseUrl: onlyMatch.scope.baseUrl,
    email: credential.email,
    apiToken: credential.apiToken,
  };

  const logger = deps.logger ?? noopLogger;
  const priorOutcomes = readArtifactMarkerOutcomes(
    tracker.current.artifactResolutionJson,
  );
  const artifacts = draft.markers.flatMap(({ resolution }) =>
    resolution.status === "resolved" ? [resolution.artifact] : [],
  );
  logger.info(
    {
      notificationId: tracker.current.notificationId,
      issueKey: workItem.platformKey,
      artifactCount: artifacts.length,
      totalSizeBytes: artifacts.reduce(
        (total, artifact) => total + (artifact.sizeBytes ?? 0),
        0,
      ),
      priorOutcomeCount: priorOutcomes.length,
    },
    "jira comment: approve started",
  );
  const startedAt = performance.now();
  let rendered: RenderedCommentDraft;
  let posted: { id: string; url: string | null };
  try {
    rendered = await renderCommentDraftArtifacts(draft, {
      renderer: (appBaseUrl) =>
        new JiraCommentArtifactRenderer({
          connection,
          issueKey: workItem.platformKey,
          appBaseUrl,
          readArtifactBytes: (artifact) => readArtifactBytes(artifact, deps),
          fetchImpl: deps.fetchImpl,
          logger,
        }),
      priorOutcomes,
      onOutcome: (outcome) =>
        tracker.update((current) =>
          current.withArtifactResolution(
            recordArtifactMarkerOutcome(
              current.artifactResolutionJson,
              outcome,
            ),
          ),
        ),
    });
    const postStartedAt = performance.now();
    posted = await postJiraIssueComment({
      ...connection,
      issueKey: workItem.platformKey,
      document:
        (rendered.document as AdfDocument | null) ??
        markdownToAdf(rendered.body),
    });
    logger.info(
      {
        issueKey: workItem.platformKey,
        durationMs: Math.round(performance.now() - postStartedAt),
      },
      "jira comment: posted comment",
    );
  } catch (error) {
    const status =
      error instanceof JiraCommentError || error instanceof JiraAttachmentError
        ? error.status
        : null;
    logger.warn(
      {
        issueKey: workItem.platformKey,
        status,
        durationMs: Math.round(performance.now() - startedAt),
        err: error,
      },
      "jira comment: approve failed",
    );
    if (status === 401) {
      const rejected = jiraCredentialRejectedError(credential);
      return failPost(rejected.message, rejected.code, rejected.status);
    }
    const message =
      error instanceof JiraCommentError || error instanceof JiraAttachmentError
        ? error.message
        : "Failed to post comment to Jira";
    return failPost(message, "COMMENT_DRAFT_JIRA_POST_FAILED");
  }
  await markSecretUsed(credential.secretId, deps);
  logger.info(
    {
      issueKey: workItem.platformKey,
      durationMs: Math.round(performance.now() - startedAt),
    },
    "jira comment: approve finished",
  );
  return { posted, rendered };
};
