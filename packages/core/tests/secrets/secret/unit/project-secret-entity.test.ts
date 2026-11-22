import { describe, expect } from "bun:test";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import { CoreError } from "@/lib/errors";
import {
  JiraApiKeySecretEntity,
  ProjectSecretEntity,
  SecretEntity,
  type SecretRowProps,
} from "@/secrets/secret/domain/secret-entity";
import {
  projectSecretOwner,
  userSecretOwner,
  type SecretOwner,
} from "@/secrets/secret/domain/secret-owner";
import { concurrentTest } from "tests/utils";

const now = new Date("2026-10-20T12:00:00.000Z");
const later = new Date("2026-10-21T12:00:00.000Z");
const projectOwner = projectSecretOwner(
  parseUuidV7("019a0000-0000-7000-8000-000000000004"),
);
const userOwner = userSecretOwner(
  parseUuidV7("019a0000-0000-7000-8000-000000000002"),
);
const encryptedValue = {
  ciphertext: Buffer.from("ciphertext"),
  iv: Buffer.alloc(12),
  authTag: Buffer.alloc(16),
  keyVersion: 1,
};

const createProjectSecret = (name = "DATADOG_API_KEY") =>
  ProjectSecretEntity.create({
    owner: projectOwner,
    name,
    encryptedValue,
    lastFour: "abcd",
    now,
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

const projectSecretRow = (
  overrides: Partial<SecretRowProps> = {},
): SecretRowProps => ({
  ...createProjectSecret().toJSON(),
  ...overrides,
});

describe("ProjectSecretEntity.create", () => {
  concurrentTest("is a static, never-expiring, metadata-free value", () => {
    const secret = createProjectSecret("  DATADOG_API_KEY ");

    expect(secret.kind).toBe("project_secret");
    expect(secret.name).toBe("DATADOG_API_KEY");
    expect(secret.valueKind).toBe("static");
    expect(secret.expiresAt).toBeNull();
    expect(secret.status(now)).toBe("active");
    expect(secret.toJSON()).toMatchObject({
      kind: "project_secret",
      valueKind: "static",
      metadataJson: {},
      expiresAt: null,
    });
  });

  concurrentTest("accepts env-var names", () => {
    for (const name of ["A", "_PRIVATE", "API_KEY_2", "MY__TOKEN"]) {
      expect(createProjectSecret(name).name).toBe(name);
    }
  });

  concurrentTest("rejects names that are not env-var syntax", () => {
    for (const name of [
      "",
      "lowercase",
      "Mixed_Case",
      "2FA_TOKEN",
      "HAS-DASH",
      "HAS SPACE",
      "DOT.NAME",
    ]) {
      expectCoreError(() => createProjectSecret(name), "SECRET_NAME_INVALID");
    }
  });

  concurrentTest("rejects names Scarn reserves", () => {
    for (const name of ["SCARN_TOKEN", "HOME", "OPENCODE_CONFIG_CONTENT"]) {
      expectCoreError(() => createProjectSecret(name), "SECRET_NAME_INVALID");
    }
  });

  concurrentTest("applies the env-var rule on rename", () => {
    const secret = createProjectSecret();

    expect(secret.rename("NEW_NAME", later).name).toBe("NEW_NAME");
    expectCoreError(
      () => secret.rename("new name", later),
      "SECRET_NAME_INVALID",
    );
  });

  concurrentTest("records who renamed or replaced it", () => {
    const editor = parseUuidV7("019a0000-0000-7000-8000-000000000009");
    const replacedValue = { ...encryptedValue, keyVersion: 2 };
    const secret = createProjectSecret();

    const renamed = secret.rename("NEW_NAME", later, editor);
    const replaced = secret.replaceValue(
      { encryptedValue: replacedValue, lastFour: "wxyz" },
      later,
      editor,
    );

    expect(secret.updatedByUserId).toBeNull();
    expect(renamed.updatedByUserId).toBe(editor);
    expect(renamed.updatedAt).toEqual(later);
    expect(replaced.encryptedValue).toEqual(replacedValue);
    expect(replaced.lastFour).toBe("wxyz");
    expect(replaced.name).toBe(secret.name);
    expect(replaced.updatedByUserId).toBe(editor);
    expect(replaced.updatedAt).toEqual(later);
  });

  concurrentTest("may not be owned by a user", () => {
    expectCoreError(
      () =>
        ProjectSecretEntity.create({
          owner: userOwner as unknown as typeof projectOwner,
          name: "API_KEY",
          encryptedValue,
          lastFour: "abcd",
          now,
        }),
      "SECRET_OWNER_KIND_MISMATCH",
    );
  });
});

describe("owner and kind pairing", () => {
  concurrentTest("a project may not own a user integration kind", () => {
    expectCoreError(
      () =>
        JiraApiKeySecretEntity.create({
          owner: projectOwner as unknown as typeof userOwner,
          name: "Work Jira",
          metadata: { email: "me@example.com" },
          encryptedValue,
          lastFour: "abcd",
          expiresAt: later,
          now,
        }),
      "SECRET_OWNER_KIND_MISMATCH",
    );
  });

  concurrentTest("SecretEntity.create dispatches project_secret", () => {
    const secret = SecretEntity.create({
      kind: "project_secret",
      owner: projectOwner,
      name: "API_KEY",
      encryptedValue,
      lastFour: "abcd",
      now,
    });

    expect(secret).toBeInstanceOf(ProjectSecretEntity);
    expect(secret.owner).toEqual(projectOwner);
  });

  concurrentTest("rehydrates a project secret row", () => {
    const row = projectSecretRow();
    const secret = SecretEntity.rehydrate(row);

    expect(secret).toBeInstanceOf(ProjectSecretEntity);
    expect(secret.toJSON()).toEqual(row);
  });

  concurrentTest("rehydrate rejects a mismatched owner and kind", () => {
    const wrongOwner: SecretOwner = userOwner;
    expectCoreError(
      () => SecretEntity.rehydrate(projectSecretRow({ owner: wrongOwner })),
      "SECRET_OWNER_KIND_MISMATCH",
    );
    expectCoreError(
      () =>
        SecretEntity.rehydrate({
          ...projectSecretRow(),
          kind: "jira_api_key",
          metadataJson: { email: "me@example.com" },
          expiresAt: later,
        }),
      "SECRET_OWNER_KIND_MISMATCH",
    );
  });
});
