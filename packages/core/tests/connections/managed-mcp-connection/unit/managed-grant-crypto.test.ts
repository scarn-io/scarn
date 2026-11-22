import { describe, expect } from "bun:test";
import { randomBytes } from "node:crypto";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import {
  ManagedGrantCrypto,
  type ManagedGrantCredentials,
  type ManagedGrantIdentity,
} from "@/connections/managed-mcp-connection/application/managed-grant-crypto";
import {
  managedAttemptAad,
  managedGrantCredentialsAad,
  managedGrantIdentityAad,
} from "@/connections/managed-mcp-connection/domain/managed-grant-aad";
import { CoreError } from "@/lib/errors";
import { AesGcmSecretCipher } from "@/secrets/secret/infra/aes-gcm-secret-cipher";
import { concurrentTest } from "tests/utils";

const ACCESS_TOKEN = "canary-access-token";

const newCrypto = () =>
  new ManagedGrantCrypto(
    new AesGcmSecretCipher({
      keys: new Map([[1, randomBytes(32)]]),
      currentKeyVersion: 1,
    }),
  );

const credentials: ManagedGrantCredentials = {
  accessToken: ACCESS_TOKEN,
  tokenType: "bearer",
  accessExpiresAt: new Date("2026-11-17T11:00:00.000Z"),
  refreshToken: "canary-refresh-token",
};

const identity: ManagedGrantIdentity = {
  userId: "notion-user-1",
  userName: "Ada",
  workspaceId: "notion-workspace-1",
  workspaceName: "Acme",
};

const grantTarget = () => ({
  projectId: createUuidV7(),
  connectionId: createUuidV7(),
  grantId: createUuidV7(),
  credentialVersion: 1,
});

const expectDecryptionFailure = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CoreError);
    expect((error as CoreError).message).not.toContain(ACCESS_TOKEN);
    return;
  }
  throw new Error("Expected decryption to fail");
};

describe("managed grant AAD", () => {
  concurrentTest("length-prefixes each part under its own tag", () => {
    const target = grantTarget();
    expect(managedGrantCredentialsAad(target)).toBe(
      `managed-oauth-grant:v1|36:${target.projectId}|36:${target.connectionId}|36:${target.grantId}|1:1`,
    );
    expect(managedGrantIdentityAad(target)).toStartWith(
      "managed-oauth-identity:v1|",
    );
    expect(
      managedAttemptAad({ ...target, attemptId: target.grantId }),
    ).toStartWith("managed-oauth-attempt:v1|");
  });

  concurrentTest("never builds the same string for different kinds", () => {
    const target = grantTarget();
    const attempt = managedAttemptAad({ ...target, attemptId: target.grantId });
    expect(managedGrantIdentityAad(target)).not.toBe(attempt);
    expect(managedGrantCredentialsAad(target)).not.toBe(
      managedGrantIdentityAad(target),
    );
  });
});

describe("ManagedGrantCrypto credentials", () => {
  concurrentTest("decrypts what it encrypted", () => {
    const crypto = newCrypto();
    const target = grantTarget();
    const encrypted = crypto.encryptCredentials(target, credentials);
    expect(encrypted.ciphertext.toString("utf8")).not.toContain(ACCESS_TOKEN);
    expect(crypto.decryptCredentials(target, encrypted)).toEqual(credentials);
  });

  concurrentTest(
    "fails for a different project, connection, grant or credential version",
    () => {
      const crypto = newCrypto();
      const target = grantTarget();
      const encrypted = crypto.encryptCredentials(target, credentials);
      for (const swapped of [
        { ...target, projectId: createUuidV7() },
        { ...target, connectionId: createUuidV7() },
        { ...target, grantId: createUuidV7() },
        { ...target, credentialVersion: 2 },
      ]) {
        expectDecryptionFailure(() =>
          crypto.decryptCredentials(swapped, encrypted),
        );
      }
    },
  );

  concurrentTest("can't be decrypted as an identity", () => {
    const crypto = newCrypto();
    const target = grantTarget();
    const encrypted = crypto.encryptCredentials(target, credentials);
    expectDecryptionFailure(() => crypto.decryptIdentity(target, encrypted));
  });
});

describe("ManagedGrantCrypto identity", () => {
  concurrentTest("decrypts what it encrypted", () => {
    const crypto = newCrypto();
    const target = grantTarget();
    const encrypted = crypto.encryptIdentity(target, identity);
    expect(crypto.decryptIdentity(target, encrypted)).toEqual(identity);
  });

  concurrentTest("fails for a different project, connection or grant", () => {
    const crypto = newCrypto();
    const target = grantTarget();
    const encrypted = crypto.encryptIdentity(target, identity);
    for (const swapped of [
      { ...target, projectId: createUuidV7() },
      { ...target, connectionId: createUuidV7() },
      { ...target, grantId: createUuidV7() },
    ]) {
      expectDecryptionFailure(() => crypto.decryptIdentity(swapped, encrypted));
    }
  });

  concurrentTest("can't be decrypted as credentials", () => {
    const crypto = newCrypto();
    const target = grantTarget();
    const encrypted = crypto.encryptIdentity(target, identity);
    expectDecryptionFailure(() => crypto.decryptCredentials(target, encrypted));
  });
});

describe("ManagedGrantCrypto PKCE verifier", () => {
  concurrentTest("fails for a different project, connection or attempt", () => {
    const crypto = newCrypto();
    const target = {
      projectId: createUuidV7(),
      connectionId: createUuidV7(),
      attemptId: createUuidV7(),
    };
    const encrypted = crypto.encryptPkceVerifier(target, "verifier-value");
    expect(crypto.decryptPkceVerifier(target, encrypted)).toBe(
      "verifier-value",
    );
    for (const swapped of [
      { ...target, projectId: createUuidV7() },
      { ...target, connectionId: createUuidV7() },
      { ...target, attemptId: createUuidV7() },
    ]) {
      expectDecryptionFailure(() =>
        crypto.decryptPkceVerifier(swapped, encrypted),
      );
    }
  });
});
