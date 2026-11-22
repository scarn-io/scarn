import { z } from "zod";
import { CoreError } from "@scarn/core/lib/errors";
import type {
  EncryptedSecretValue,
  SecretCipher,
} from "@scarn/core/secrets/secret/application/secret-cipher";
import {
  managedAttemptAad,
  managedGrantCredentialsAad,
  managedGrantIdentityAad,
  type ManagedAttemptAadInput,
  type ManagedGrantCredentialsAadInput,
  type ManagedGrantIdentityAadInput,
} from "../domain/managed-grant-aad";

const managedGrantCredentialsSchema = z
  .object({
    accessToken: z.string().min(1),
    tokenType: z.string().min(1),
    accessExpiresAt: z.iso.datetime(),
    refreshToken: z.string().min(1),
  })
  .strict();

const managedGrantIdentitySchema = z
  .object({
    userId: z.string().min(1).nullable(),
    userName: z.string().nullable(),
    workspaceId: z.string().min(1).nullable(),
    workspaceName: z.string().nullable(),
  })
  .strict();

/** A grant's tokens, as held in memory by the few use cases that need them. */
export type ManagedGrantCredentials = {
  accessToken: string;
  tokenType: string;
  accessExpiresAt: Date;
  refreshToken: string;
};

/** Who the provider says a grant acts as. A field is null when the provider didn't say. */
export type ManagedGrantIdentity = z.infer<typeof managedGrantIdentitySchema>;

export type ManagedGrantCredentialsTarget = ManagedGrantCredentialsAadInput;
export type ManagedGrantIdentityTarget = ManagedGrantIdentityAadInput;
export type ManagedAttemptTarget = ManagedAttemptAadInput;

const plaintextUnreadable = () =>
  new CoreError({
    code: "MANAGED_GRANT_DECRYPTION_FAILED",
    message: "Managed connection data could not be decrypted",
    status: 500,
    expose: false,
  });

/**
 * Encrypts and decrypts a managed connection's secret material with
 * `SecretCipher`, binding each ciphertext to its project, connection and row
 * through `managed-grant-aad.ts`. A ciphertext moved to another row, or
 * decrypted as the wrong kind, fails. Callers decrypt credentials only in
 * use cases built to use them.
 */
export class ManagedGrantCrypto {
  public constructor(private readonly cipher: SecretCipher) {}

  encryptCredentials(
    target: ManagedGrantCredentialsTarget,
    credentials: ManagedGrantCredentials,
  ): EncryptedSecretValue {
    return this.cipher.encrypt(
      JSON.stringify({
        ...credentials,
        accessExpiresAt: credentials.accessExpiresAt.toISOString(),
      }),
      managedGrantCredentialsAad(target),
    );
  }

  decryptCredentials(
    target: ManagedGrantCredentialsTarget,
    value: EncryptedSecretValue,
  ): ManagedGrantCredentials {
    const parsed = this.decryptJson(
      value,
      managedGrantCredentialsAad(target),
      managedGrantCredentialsSchema,
    );
    return { ...parsed, accessExpiresAt: new Date(parsed.accessExpiresAt) };
  }

  encryptIdentity(
    target: ManagedGrantIdentityTarget,
    identity: ManagedGrantIdentity,
  ): EncryptedSecretValue {
    return this.cipher.encrypt(
      JSON.stringify(identity),
      managedGrantIdentityAad(target),
    );
  }

  decryptIdentity(
    target: ManagedGrantIdentityTarget,
    value: EncryptedSecretValue,
  ): ManagedGrantIdentity {
    return this.decryptJson(
      value,
      managedGrantIdentityAad(target),
      managedGrantIdentitySchema,
    );
  }

  encryptPkceVerifier(
    target: ManagedAttemptTarget,
    verifier: string,
  ): EncryptedSecretValue {
    return this.cipher.encrypt(verifier, managedAttemptAad(target));
  }

  decryptPkceVerifier(
    target: ManagedAttemptTarget,
    value: EncryptedSecretValue,
  ): string {
    return this.cipher.decrypt(value, managedAttemptAad(target));
  }

  private decryptJson<T>(
    value: EncryptedSecretValue,
    aad: string,
    schema: z.ZodType<T>,
  ): T {
    const plaintext = this.cipher.decrypt(value, aad);
    let json: unknown;
    try {
      json = JSON.parse(plaintext);
    } catch {
      throw plaintextUnreadable();
    }
    const result = schema.safeParse(json);
    if (!result.success) {
      throw plaintextUnreadable();
    }
    return result.data;
  }
}
