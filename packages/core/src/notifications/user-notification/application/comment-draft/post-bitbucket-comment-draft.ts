import {
  CoreValidationError,
  ResourceNotFoundError,
} from "@scarn/core/lib/errors";
import { isBitbucketIntegration } from "@scarn/core/integrations/project-integration/domain/project-integration-entity";
import {
  BitbucketApiError,
  createBitbucketClient,
} from "@scarn/core/integrations/bitbucket-ingest/infra/bitbucket-client";
import type { WorkItemEntity } from "@scarn/core/work-items/work-item/domain/work-item-entity";
import type { IntegrationCredentialChoice } from "@scarn/core/secrets/secret/contracts/secret-contracts";
import {
  bitbucketCredentialRejectedError,
  resolveBitbucketCredential,
} from "@scarn/core/secrets/secret/application/resolve-bitbucket-credential";
import { markSecretUsed } from "@scarn/core/secrets/secret/application/mark-secret-used";
import type { ApproveCommentDraftDeps } from "./approve-comment-draft";

export type FailCommentPost = (
  message: string,
  code: string,
  status?: number,
) => Promise<never>;

/**
 * Posts an approved draft to a Bitbucket issue with the approver's own
 * Atlassian email + API token, through the active Bitbucket integration that
 * covers the work item's repository. A failed post goes through `failPost`
 * so the delivery is marked failed and Approve stays retryable.
 */
export const postBitbucketCommentDraft = async (
  {
    workItem,
    body,
    credential: choice,
  }: {
    workItem: WorkItemEntity;
    body: string;
    credential: IntegrationCredentialChoice | undefined;
  },
  deps: ApproveCommentDraftDeps,
  failPost: FailCommentPost,
): Promise<{ id: string; url: string | null }> => {
  const credential = await resolveBitbucketCredential(choice, deps);

  const repositoryField = workItem.fields["repository"];
  const numberField = workItem.fields["number"];
  if (typeof repositoryField !== "string" || typeof numberField !== "number") {
    throw new CoreValidationError(
      "Work item is missing its Bitbucket repository or issue number",
      "WORK_ITEM_MISSING_BITBUCKET_ISSUE",
    );
  }

  const integrations = await deps.projectIntegrationRepo.listByProjectId(
    workItem.projectId,
    deps.dbExecutor,
  );
  const repo = integrations
    .filter(isBitbucketIntegration)
    .filter((candidate) => candidate.status === "active")
    .flatMap((candidate) => candidate.scope.repos)
    .find(
      (scoped) =>
        scoped.fullName.toLowerCase() === repositoryField.toLowerCase(),
    );
  if (!repo) {
    throw new ResourceNotFoundError(
      "Bitbucket project integration",
      workItem.projectId,
    );
  }

  const client = createBitbucketClient({
    email: credential.email,
    apiToken: credential.apiToken,
    secretName: credential.secretName,
    fetchImpl: deps.fetchImpl,
  });

  let posted: { id: string; url: string | null };
  try {
    posted = await client.postIssueComment(
      repo.workspace,
      repo.slug,
      numberField,
      body,
    );
  } catch (error) {
    if (error instanceof BitbucketApiError && error.status === 401) {
      const rejected = bitbucketCredentialRejectedError(credential);
      return failPost(rejected.message, rejected.code, rejected.status);
    }
    const message =
      error instanceof BitbucketApiError
        ? error.message
        : "Failed to post comment to Bitbucket";
    return failPost(message, "COMMENT_DRAFT_BITBUCKET_POST_FAILED");
  }
  await markSecretUsed(credential.secretId, deps);
  return posted;
};
