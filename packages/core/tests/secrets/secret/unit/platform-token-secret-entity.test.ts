import { describe, expect } from "bun:test";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import { CoreError } from "@/lib/errors";
import {
  BitbucketApiTokenSecretEntity,
  GitHubTokenSecretEntity,
  SecretEntity,
  type SecretRowProps,
} from "@/secrets/secret/domain/secret-entity";
import { userSecretOwner } from "@/secrets/secret/domain/secret-owner";
import { concurrentTest } from "tests/utils";

const DAY_MS = 24 * 60 * 60 * 1000;
const now = new Date("2026-10-20T12:00:00.000Z");
const later = (days: number) => new Date(now.getTime() + days * DAY_MS);
const owner = userSecretOwner(
  parseUuidV7("019a0000-0000-7000-8000-000000000003"),
);
const encryptedValue = {
  ciphertext: Buffer.from("ciphertext"),
  iv: Buffer.alloc(12),
  authTag: Buffer.alloc(16),
  keyVersion: 1,
};

const createGitHubToken = (
  overrides: Partial<Parameters<typeof GitHubTokenSecretEntity.create>[0]> = {},
) =>
  GitHubTokenSecretEntity.create({
    owner,
    name: "Personal GitHub",
    metadata: { login: "octocat" },
    encryptedValue,
    lastFour: "abcd",
    expiresAt: null,
    now,
    ...overrides,
  });

const createBitbucketToken = (
  overrides: Partial<
    Parameters<typeof BitbucketApiTokenSecretEntity.create>[0]
  > = {},
) =>
  BitbucketApiTokenSecretEntity.create({
    owner,
    name: "Work Bitbucket",
    metadata: { email: "me@example.com" },
    encryptedValue,
    lastFour: "abcd",
    expiresAt: later(90),
    now,
    ...overrides,
  });

const expectCoreError = (fn: () => void, code: string) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CoreError);
    expect((error as CoreError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code} to be thrown`);
};

describe("GitHubTokenSecretEntity", () => {
  concurrentTest("never expires when created without an expiry", () => {
    const secret = createGitHubToken();

    expect(secret.kind).toBe("github_token");
    expect(secret.expiresAt).toBeNull();
    expect(secret.isExpired(later(10_000))).toBe(false);
    expect(secret.status(later(10_000))).toBe("active");
    expect(() => {
      secret.assertUsable(later(10_000));
    }).not.toThrow();
  });

  concurrentTest("expires like any other key when given an expiry", () => {
    const secret = createGitHubToken({ expiresAt: later(30) });

    expect(secret.status(later(16))).toBe("expiring_soon");
    expectCoreError(() => {
      secret.assertUsable(later(30));
    }, "SECRET_EXPIRED");
  });

  concurrentTest("rejects an expiry that is not in the future", () => {
    expectCoreError(
      () => createGitHubToken({ expiresAt: now }),
      "SECRET_EXPIRY_IN_PAST",
    );
  });

  concurrentTest("trims the login and stores a blank one as null", () => {
    expect(
      createGitHubToken({ metadata: { login: "  octocat " } }).metadata,
    ).toEqual({ login: "octocat" });
    expect(createGitHubToken({ metadata: { login: "  " } }).metadata).toEqual(
      { login: null },
    );
  });

  concurrentTest("rename keeps the variant, metadata and expiry", () => {
    const secret = createGitHubToken({ expiresAt: later(30) });
    const renamed = secret.rename("Work GitHub", later(1));

    expect(renamed).toBeInstanceOf(GitHubTokenSecretEntity);
    expect(renamed.metadata).toEqual(secret.metadata);
    expect(renamed.expiresAt).toEqual(later(30));
  });
});

describe("BitbucketApiTokenSecretEntity", () => {
  concurrentTest("trims and lowercases the email", () => {
    const secret = createBitbucketToken({
      metadata: { email: "  Me@Example.COM " },
    });

    expect(secret.kind).toBe("bitbucket_api_token");
    expect(secret.metadata.email).toBe("me@example.com");
  });

  concurrentTest("rejects an invalid email", () => {
    expectCoreError(
      () => createBitbucketToken({ metadata: { email: "nope" } }),
      "SECRET_EMAIL_INVALID",
    );
  });

  concurrentTest("rejects an expiry that is not in the future", () => {
    expectCoreError(
      () => createBitbucketToken({ expiresAt: later(-1) }),
      "SECRET_EXPIRY_IN_PAST",
    );
  });
});

describe("SecretEntity companion with platform tokens", () => {
  concurrentTest("create dispatches each kind to its variant", () => {
    const shared = {
      owner,
      name: "Key",
      encryptedValue,
      lastFour: "abcd",
      now,
    };

    expect(
      SecretEntity.create({
        ...shared,
        kind: "github_token",
        metadata: { login: null },
        expiresAt: null,
      }),
    ).toBeInstanceOf(GitHubTokenSecretEntity);
    expect(
      SecretEntity.create({
        ...shared,
        kind: "bitbucket_api_token",
        metadata: { email: "me@example.com" },
        expiresAt: later(90),
      }),
    ).toBeInstanceOf(BitbucketApiTokenSecretEntity);
  });

  concurrentTest("rehydrate round-trips toJSON for both kinds", () => {
    for (const original of [
      createGitHubToken(),
      createGitHubToken({ expiresAt: later(30) }),
      createBitbucketToken(),
    ]) {
      const rehydrated = SecretEntity.rehydrate(original.toJSON());

      expect(rehydrated.constructor).toBe(original.constructor);
      expect(rehydrated.toJSON()).toEqual(original.toJSON());
    }
  });

  concurrentTest(
    "rehydrate rejects a bitbucket_api_token row without an expiry",
    () => {
      const row: SecretRowProps = {
        ...createBitbucketToken().toJSON(),
        expiresAt: null,
      };
      expectCoreError(
        () => SecretEntity.rehydrate(row),
        "SECRET_EXPIRY_REQUIRED",
      );
    },
  );

  concurrentTest("rehydrate rejects invalid metadata", () => {
    const github: SecretRowProps = {
      ...createGitHubToken().toJSON(),
      metadataJson: { email: "me@example.com" },
    };
    const bitbucket: SecretRowProps = {
      ...createBitbucketToken().toJSON(),
      metadataJson: { login: "octocat" },
    };

    expectCoreError(
      () => SecretEntity.rehydrate(github),
      "SECRET_METADATA_INVALID",
    );
    expectCoreError(
      () => SecretEntity.rehydrate(bitbucket),
      "SECRET_METADATA_INVALID",
    );
  });
});
