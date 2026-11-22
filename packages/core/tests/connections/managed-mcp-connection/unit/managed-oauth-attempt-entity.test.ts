import { describe, expect } from "bun:test";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import {
  ManagedOAuthAttemptEntity,
  MANAGED_OAUTH_ATTEMPT_TTL_MS,
} from "@/connections/managed-mcp-connection/domain/managed-oauth-attempt-entity";
import type { CoreError } from "@/lib/errors";
import { concurrentTest } from "tests/utils";

const T0 = new Date("2026-11-17T10:00:00.000Z");
const T1 = new Date("2026-11-17T10:01:00.000Z");

const newAttempt = () =>
  ManagedOAuthAttemptEntity.create({
    id: createUuidV7(),
    connectionId: createUuidV7(),
    projectId: createUuidV7(),
    kind: "connect",
    expectedGeneration: 0,
    actorUserId: createUuidV7(),
    binding: { kind: "browser", sessionDigest: "session-digest" },
    stateDigest: "state-digest",
    clientId: "https://api.example.test/oauth/mcp/client-metadata.json",
    redirectUri: "https://api.example.test/api/oauth/mcp/callback",
    requestedScopes: [],
    encryptedPkceVerifier: {
      ciphertext: Buffer.from("c"),
      iv: Buffer.alloc(12),
      authTag: Buffer.alloc(16),
      keyVersion: 1,
    },
    now: T0,
  });

const expectConflict = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    expect((error as CoreError).code).toBe("MANAGED_OAUTH_ATTEMPT_CONFLICT");
    return;
  }
  throw new Error("Expected an attempt conflict");
};

describe("ManagedOAuthAttemptEntity", () => {
  concurrentTest("expires 10 minutes after it is created", () => {
    const attempt = newAttempt();
    expect(attempt.expiresAt.getTime() - T0.getTime()).toBe(
      MANAGED_OAUTH_ATTEMPT_TTL_MS,
    );
    expect(attempt.isExpiredAt(attempt.expiresAt)).toBe(true);
  });

  concurrentTest("can begin an exchange only once", () => {
    const exchanging = newAttempt().beginExchange(T1);
    expect(exchanging.status).toBe("exchanging");
    expectConflict(() => exchanging.beginExchange(T1));
  });

  concurrentTest("refuses to begin an expired exchange", () => {
    const attempt = newAttempt();
    expectConflict(() => attempt.beginExchange(attempt.expiresAt));
  });

  concurrentTest("drops the verifier once the exchange is over", () => {
    const candidateId = createUuidV7();
    const succeeded = newAttempt().beginExchange(T1).succeed(candidateId, T1);
    expect(succeeded.progress).toEqual({
      status: "succeeded",
      candidateGrantId: candidateId,
    });
    const failed = newAttempt().fail("missing_refresh", T1);
    expect(failed.progress).toEqual({
      status: "failed",
      failureCode: "missing_refresh",
    });
    expectConflict(() => failed.cancel(T1));
  });
});
