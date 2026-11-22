import { describe, expect } from "bun:test";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import { CoreError } from "@/lib/errors";
import {
  JiraApiKeySecretEntity,
  SecretEntity,
  type SecretRowProps,
} from "@/secrets/secret/domain/secret-entity";
import { userSecretOwner } from "@/secrets/secret/domain/secret-owner";
import { concurrentTest } from "tests/utils";

const DAY_MS = 24 * 60 * 60 * 1000;
const now = new Date("2026-10-20T12:00:00.000Z");
const later = (days: number) => new Date(now.getTime() + days * DAY_MS);
const owner = userSecretOwner(
  parseUuidV7("019a0000-0000-7000-8000-000000000002"),
);
const encryptedValue = {
  ciphertext: Buffer.from("ciphertext"),
  iv: Buffer.alloc(12),
  authTag: Buffer.alloc(16),
  keyVersion: 1,
};

const createJiraKey = (
  overrides: Partial<Parameters<typeof JiraApiKeySecretEntity.create>[0]> = {},
) =>
  JiraApiKeySecretEntity.create({
    owner,
    name: "Work Jira",
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

describe("JiraApiKeySecretEntity.create", () => {
  concurrentTest("trims and lowercases the email and trims the name", () => {
    const secret = createJiraKey({
      name: "  Work Jira  ",
      metadata: { email: "  Me@Example.COM " },
    });

    expect(secret.kind).toBe("jira_api_key");
    expect(secret.name).toBe("Work Jira");
    expect(secret.metadata.email).toBe("me@example.com");
    expect(secret.createdAt).toEqual(now);
    expect(secret.updatedAt).toEqual(now);
    expect(secret.lastUsedAt).toBeNull();
  });

  concurrentTest("rejects an invalid email", () => {
    expectCoreError(
      () => createJiraKey({ metadata: { email: "not-an-email" } }),
      "SECRET_EMAIL_INVALID",
    );
  });

  concurrentTest("rejects an expiry that is not in the future", () => {
    expectCoreError(
      () => createJiraKey({ expiresAt: now }),
      "SECRET_EXPIRY_IN_PAST",
    );
    expectCoreError(
      () => createJiraKey({ expiresAt: later(-1) }),
      "SECRET_EXPIRY_IN_PAST",
    );
  });

  concurrentTest("rejects an empty or over-long name", () => {
    expectCoreError(
      () => createJiraKey({ name: "   " }),
      "SECRET_NAME_INVALID",
    );
    expectCoreError(
      () => createJiraKey({ name: "x".repeat(101) }),
      "SECRET_NAME_INVALID",
    );
  });
});

describe("SecretEntity companion", () => {
  concurrentTest(
    "create dispatches jira_api_key to JiraApiKeySecretEntity",
    () => {
      const secret = SecretEntity.create({
        kind: "jira_api_key",
        owner,
        name: "Work Jira",
        metadata: { email: "me@example.com" },
        encryptedValue,
        lastFour: "abcd",
        expiresAt: later(90),
        now,
      });

      expect(secret).toBeInstanceOf(JiraApiKeySecretEntity);
    },
  );

  concurrentTest("rehydrate round-trips toJSON for jira_api_key", () => {
    const original = createJiraKey();
    const rehydrated = SecretEntity.rehydrate(original.toJSON());

    expect(rehydrated).toBeInstanceOf(JiraApiKeySecretEntity);
    expect(rehydrated.toJSON()).toEqual(original.toJSON());
  });

  concurrentTest(
    "rehydrate rejects a jira_api_key row without an expiry",
    () => {
      const row: SecretRowProps = {
        ...createJiraKey().toJSON(),
        expiresAt: null,
      };
      expectCoreError(
        () => SecretEntity.rehydrate(row),
        "SECRET_EXPIRY_REQUIRED",
      );
    },
  );

  concurrentTest(
    "rehydrate rejects a jira_api_key row without an email",
    () => {
      const row: SecretRowProps = {
        ...createJiraKey().toJSON(),
        metadataJson: {},
      };
      expectCoreError(
        () => SecretEntity.rehydrate(row),
        "SECRET_METADATA_INVALID",
      );
    },
  );

  concurrentTest("rejects an unknown kind", () => {
    const row = {
      ...createJiraKey().toJSON(),
      kind: "env",
    } as unknown as SecretRowProps;
    expectCoreError(
      () => SecretEntity.rehydrate(row),
      "SECRET_KIND_UNSUPPORTED",
    );
  });
});

describe("expiry", () => {
  concurrentTest("isExpired is false before expiresAt and true from it", () => {
    const secret = createJiraKey({ expiresAt: later(10) });

    expect(secret.isExpired(now)).toBe(false);
    expect(secret.isExpired(later(10))).toBe(true);
    expect(secret.isExpired(later(11))).toBe(true);
  });

  concurrentTest(
    "status is active, then expiring_soon within 14 days, then expired",
    () => {
      const secret = createJiraKey({ expiresAt: later(30) });

      expect(secret.status(now)).toBe("active");
      expect(secret.status(later(15))).toBe("active");
      expect(secret.status(later(16))).toBe("expiring_soon");
      expect(secret.status(later(29))).toBe("expiring_soon");
      expect(secret.status(later(30))).toBe("expired");
    },
  );

  concurrentTest("assertUsable throws SECRET_EXPIRED once expired", () => {
    const secret = createJiraKey({ expiresAt: later(10) });

    expect(() => {
      secret.assertUsable(now);
    }).not.toThrow();
    expectCoreError(() => {
      secret.assertUsable(later(10));
    }, "SECRET_EXPIRED");
  });
});

describe("rename", () => {
  concurrentTest(
    "trims the name, bumps updatedAt, and keeps the variant",
    () => {
      const secret = createJiraKey();
      const renamed = secret.rename("  Personal Jira ", later(1));

      expect(renamed).toBeInstanceOf(JiraApiKeySecretEntity);
      expect(renamed.name).toBe("Personal Jira");
      expect(renamed.updatedAt).toEqual(later(1));
      expect(renamed.createdAt).toEqual(now);
      expect(renamed.metadata).toEqual(secret.metadata);
      expect(renamed.expiresAt).toEqual(secret.expiresAt);
      expect(renamed.encryptedValue).toBe(secret.encryptedValue);
    },
  );

  concurrentTest("rejects an empty or over-long name", () => {
    const secret = createJiraKey();

    expectCoreError(() => secret.rename("", now), "SECRET_NAME_INVALID");
    expectCoreError(
      () => secret.rename("x".repeat(101), now),
      "SECRET_NAME_INVALID",
    );
  });
});

describe("markUsed", () => {
  concurrentTest("sets lastUsedAt", () => {
    expect(createJiraKey().markUsed(later(2)).lastUsedAt).toEqual(later(2));
  });
});
