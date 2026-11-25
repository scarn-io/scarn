import { ANONYMOUS_ACTOR_ID } from "@scarn/core/access/authorization/anonymous-actor";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { CoreError } from "@scarn/core/lib/errors";
import { resolveProjectPermissionGrant } from "@scarn/core/projects/project/application/project-authorization";
import type { ProjectEntity } from "@scarn/core/projects/project/domain/project-entity";
import type { ProjectPermission } from "@scarn/core/projects/project/domain/project-permission";
import type { ConversationCapabilities } from "../contracts/conversation-contracts";

/**
 * What `viewerId` may do to a chat started by `creatorUserId`, by permission
 * alone (the chat's state decides the rest): reply with `comments:write`;
 * retry with `executions:write`; end or delete with `executions:write`, or as
 * the creator while they still have `comments:write`. Public visibility
 * only ever grants reads, so an anonymous viewer or outsider can do none.
 */
export const conversationCapabilities = (
  project: ProjectEntity,
  creatorUserId: UuidV7 | null,
  viewerId: UuidV7,
): ConversationCapabilities => {
  const has = (permission: ProjectPermission) =>
    resolveProjectPermissionGrant(project, viewerId, permission) !== null;
  const canReply = has("comments:write");
  const canManage = has("executions:write");
  const canManageOwn = canManage || (viewerId === creatorUserId && canReply);
  return {
    canReply,
    canRetry: canManage,
    canEnd: canManageOwn,
    canDelete: canManageOwn,
  };
};

/**
 * Refuses a viewer who may neither end nor delete the chat: 401 with no
 * session, 403 otherwise.
 */
export const assertCanManageConversation = (
  project: ProjectEntity,
  creatorUserId: UuidV7 | null,
  viewerId: UuidV7,
): void => {
  if (conversationCapabilities(project, creatorUserId, viewerId).canEnd) {
    return;
  }
  if (viewerId === ANONYMOUS_ACTOR_ID) {
    throw new CoreError({
      code: "UNAUTHORIZED",
      message: "Authentication required",
      status: 401,
    });
  }
  throw new CoreError({
    code: "PROJECT_FORBIDDEN",
    message:
      "Only the conversation's creator or someone with executions:write can manage it",
    status: 403,
  });
};
