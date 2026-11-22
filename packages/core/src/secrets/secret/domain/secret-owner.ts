import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";

export type UserSecretOwner = { type: "user"; userId: UuidV7 };

export type ProjectSecretOwner = { type: "project"; projectId: UuidV7 };

/**
 * Who a secret belongs to, and so who may see and use it: a user (their
 * integration credentials) or a project (its project secrets).
 */
export type SecretOwner = UserSecretOwner | ProjectSecretOwner;

export type SecretOwnerType = SecretOwner["type"];

export const userSecretOwner = (userId: UuidV7): UserSecretOwner => ({
  type: "user",
  userId,
});

export const projectSecretOwner = (projectId: UuidV7): ProjectSecretOwner => ({
  type: "project",
  projectId,
});

/** `<ownerType>:<ownerId>`, the owner's stable identity as a string. */
export const ownerKey = (owner: SecretOwner): string => {
  switch (owner.type) {
    case "user":
      return `user:${owner.userId}`;
    case "project":
      return `project:${owner.projectId}`;
  }
};
