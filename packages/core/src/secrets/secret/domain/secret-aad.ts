import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { ownerKey, type SecretOwner } from "./secret-owner";

export type SecretAadInput = {
  id: UuidV7;
  owner: SecretOwner;
};

/**
 * The additional authenticated data a secret's value is encrypted with:
 * `secret:<secretId>:<ownerType>:<ownerId>`. A ciphertext copied onto another
 * row or owner then fails to decrypt instead of quietly working.
 */
export const secretAad = (secret: SecretAadInput): string =>
  `secret:${secret.id}:${ownerKey(secret.owner)}`;
