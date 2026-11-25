import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import { CoreError, ResourceNotFoundError } from "@scarn/core/lib/errors";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { IntegrationCredentialChoice } from "../contracts/secret-contracts";
import {
  secretExpiredError,
  type SecretEntity,
  type SecretKind,
} from "../domain/secret-entity";
import { secretAad } from "../domain/secret-aad";
import { userSecretOwner } from "../domain/secret-owner";
import type { SecretCipher } from "./secret-cipher";
import type { SecretRepo } from "./secret-repo";

export type ResolveCredentialDeps = {
  secretRepo: SecretRepo;
  secretCipher: SecretCipher;
  userAuthz: UserAuthorizationService;
  timeProvider: TimeProvider;
};

export type CredentialPlatform = "jira" | "github" | "bitbucket";

export type SecretOfKind<K extends SecretKind> = Extract<
  SecretEntity,
  { kind: K }
>;

const isSecretOfKind = <K extends SecretKind>(
  secret: SecretEntity,
  kind: K,
): secret is SecretOfKind<K> => secret.kind === kind;

type CheckedSecret<K extends SecretKind> =
  | { ok: true; secret: SecretOfKind<K>; value: string }
  | { ok: false; problem: "wrong_kind" | "expired" };

/**
 * Checks an already-loaded secret is of `kind` and not expired, then
 * decrypts it with its AAD. Returns the problem rather than throwing so each
 * caller can phrase its own error. Only `decryptSavedCredential` calls this;
 * nothing else decrypts.
 */
const checkAndDecryptSecret = <K extends SecretKind>(
  secret: SecretEntity,
  kind: K,
  deps: Pick<ResolveCredentialDeps, "secretCipher" | "timeProvider">,
): CheckedSecret<K> => {
  if (!isSecretOfKind(secret, kind)) {
    return { ok: false, problem: "wrong_kind" };
  }
  if (secret.isExpired(deps.timeProvider.now())) {
    return { ok: false, problem: "expired" };
  }
  return {
    ok: true,
    secret,
    value: deps.secretCipher.decrypt(
      secret.encryptedValue,
      secretAad({ id: secret.id, owner: secret.owner }),
    ),
  };
};

/**
 * Loads the caller's saved secret, checks it is of `kind` and not expired,
 * and decrypts it. Shared by the per-platform credential resolvers, which are
 * the only callers.
 */
export const decryptSavedCredential = async <K extends SecretKind>(
  secretId: UuidV7,
  kind: K,
  kindLabel: string,
  deps: ResolveCredentialDeps,
): Promise<{ secret: SecretOfKind<K>; value: string }> => {
  const owner = userSecretOwner(deps.userAuthz.actorId);
  const secret = await deps.secretRepo.findByIdForOwner(secretId, owner);
  if (!secret) {
    throw new ResourceNotFoundError("secret", secretId);
  }
  const checked = checkAndDecryptSecret(secret, kind, deps);
  if (!checked.ok) {
    if (checked.problem === "expired") {
      throw secretExpiredError(secret.name);
    }
    throw new CoreError({
      code: "SECRET_KIND_MISMATCH",
      message: `The saved key "${secret.name}" is not a ${kindLabel}`,
      status: 400,
    });
  }
  return { secret: checked.secret, value: checked.value };
};

/** Which platform a pasted credential's shape belongs to. */
export const pastedCredentialPlatform = (
  choice: Exclude<IntegrationCredentialChoice, { secretId: UuidV7 }>,
): CredentialPlatform => {
  if ("token" in choice) return "github";
  if ("apiToken" in choice) return "bitbucket";
  return "jira";
};

const PLATFORM_LABEL: Record<CredentialPlatform, string> = {
  jira: "Jira",
  github: "GitHub",
  bitbucket: "Bitbucket",
};

/**
 * `CREDENTIAL_PLATFORM_MISMATCH`: a pasted credential shaped for `actual` was
 * sent to a request that needs `expected`. Never includes the credential.
 */
export const credentialPlatformMismatchError = (
  expected: CredentialPlatform,
  actual: CredentialPlatform,
): CoreError =>
  new CoreError({
    code: "CREDENTIAL_PLATFORM_MISMATCH",
    message: `This request needs a ${PLATFORM_LABEL[expected]} credential, but a ${PLATFORM_LABEL[actual]} credential was sent.`,
    status: 400,
  });
