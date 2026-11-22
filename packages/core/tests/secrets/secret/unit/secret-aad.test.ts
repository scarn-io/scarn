import { describe, expect } from "bun:test";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import { secretAad } from "@/secrets/secret/domain/secret-aad";
import {
  ownerKey,
  projectSecretOwner,
  userSecretOwner,
} from "@/secrets/secret/domain/secret-owner";
import { concurrentTest } from "tests/utils";

const secretId = parseUuidV7("019a0000-0000-7000-8000-000000000001");
const userId = parseUuidV7("019a0000-0000-7000-8000-000000000002");
const otherUserId = parseUuidV7("019a0000-0000-7000-8000-000000000003");
const projectId = parseUuidV7("019a0000-0000-7000-8000-000000000004");

describe("ownerKey", () => {
  concurrentTest("builds <ownerType>:<ownerId> for a user owner", () => {
    expect(ownerKey(userSecretOwner(userId))).toBe(
      "user:019a0000-0000-7000-8000-000000000002",
    );
  });

  concurrentTest("builds <ownerType>:<ownerId> for a project owner", () => {
    expect(ownerKey(projectSecretOwner(projectId))).toBe(
      "project:019a0000-0000-7000-8000-000000000004",
    );
  });
});

describe("secretAad", () => {
  concurrentTest("builds secret:<secretId>:<ownerType>:<ownerId>", () => {
    expect(secretAad({ id: secretId, owner: userSecretOwner(userId) })).toBe(
      "secret:019a0000-0000-7000-8000-000000000001:user:019a0000-0000-7000-8000-000000000002",
    );
  });

  concurrentTest("differs when the owner differs", () => {
    expect(
      secretAad({ id: secretId, owner: userSecretOwner(userId) }),
    ).not.toBe(
      secretAad({ id: secretId, owner: userSecretOwner(otherUserId) }),
    );
  });

  concurrentTest("binds a project secret to its project", () => {
    expect(
      secretAad({ id: secretId, owner: projectSecretOwner(projectId) }),
    ).toBe(
      "secret:019a0000-0000-7000-8000-000000000001:project:019a0000-0000-7000-8000-000000000004",
    );
  });
});
