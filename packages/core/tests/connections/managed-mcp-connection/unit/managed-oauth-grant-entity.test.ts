import { describe, expect } from "bun:test";
import { randomBytes } from "node:crypto";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import {
  ManagedGrantCrypto,
  type ManagedGrantCredentials,
} from "@/connections/managed-mcp-connection/application/managed-grant-crypto";
import {
  MANAGED_REFRESH_STALE_MS,
  ManagedOAuthGrantEntity,
  newManagedOAuthGrantId,
} from "@/connections/managed-mcp-connection/domain/managed-oauth-grant-entity";
import { CoreError } from "@/lib/errors";
import { AesGcmSecretCipher } from "@/secrets/secret/infra/aes-gcm-secret-cipher";
import { concurrentTest } from "tests/utils";

const authorizedAt = new Date("2026-11-17T10:00:00.000Z");
const claimedAt = new Date("2026-11-17T10:30:00.000Z");
const later = (ms: number) => new Date(claimedAt.getTime() + ms);

const newCrypto = () =>
  new ManagedGrantCrypto(
    new AesGcmSecretCipher({
      keys: new Map([[1, randomBytes(32)]]),
      currentKeyVersion: 1,
    }),
  );

const credentials = (accessToken: string): ManagedGrantCredentials => ({
  accessToken,
  tokenType: "bearer",
  accessExpiresAt: new Date("2026-11-17T11:00:00.000Z"),
  refreshToken: `${accessToken}-refresh`,
});

const target = (grant: ManagedOAuthGrantEntity) => ({
  projectId: grant.projectId,
  connectionId: grant.connectionId,
  grantId: grant.id,
  credentialVersion: grant.credentialVersion,
});

const newGrant = (crypto = newCrypto()) => {
  const ids = {
    id: newManagedOAuthGrantId(),
    projectId: createUuidV7(),
    connectionId: createUuidV7(),
  };
  const aadTarget = { ...ids, grantId: ids.id, credentialVersion: 1 };
  return ManagedOAuthGrantEntity.create({
    ...ids,
    clientId: "https://scarn.test/oauth/client-metadata.json",
    issuer: "https://mcp.notion.com",
    resource: "https://mcp.notion.com/mcp",
    credentialVersion: 1,
    encryptedCredentials: crypto.encryptCredentials(
      aadTarget,
      credentials("first"),
    ),
    encryptedIdentity: crypto.encryptIdentity(aadTarget, {
      userId: "notion-user-1",
      userName: null,
      workspaceId: null,
      workspaceName: null,
    }),
    grantedScopes: [],
    authorizedAt,
    createdByUserId: createUuidV7(),
  });
};

const expectCoreError = (fn: () => unknown, code: string) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CoreError);
    expect((error as CoreError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}`);
};

const liveCiphertext = (grant: ManagedOAuthGrantEntity) => {
  if (grant.credentials.status !== "live") {
    throw new Error("Expected a live grant");
  }
  return grant.credentials.encryptedCredentials;
};

describe("ManagedOAuthGrantEntity refresh claim", () => {
  concurrentTest("a new grant holds no claim", () => {
    const grant = newGrant();
    expect(grant.refreshClaim).toBeNull();
    expect(
      grant.isRefreshClaimStale(later(MANAGED_REFRESH_STALE_MS * 10)),
    ).toBe(false);
  });

  concurrentTest("claims a live grant", () => {
    const claimId = createUuidV7();
    const claimed = newGrant().claimRefresh(claimId, claimedAt);
    expect(claimed.refreshClaim).toEqual({ claimId, claimedAt });
    expect(claimed.updatedAt).toEqual(claimedAt);
    expect(claimed.credentialVersion).toBe(1);
  });

  concurrentTest(
    "a claim goes stale only after MANAGED_REFRESH_STALE_MS",
    () => {
      const claimed = newGrant().claimRefresh(createUuidV7(), claimedAt);
      expect(claimed.isRefreshClaimStale(later(MANAGED_REFRESH_STALE_MS))).toBe(
        false,
      );
      expect(
        claimed.isRefreshClaimStale(later(MANAGED_REFRESH_STALE_MS + 1)),
      ).toBe(true);
    },
  );

  concurrentTest("rejects a second claim while the first is fresh", () => {
    const claimed = newGrant().claimRefresh(createUuidV7(), claimedAt);
    expectCoreError(
      () =>
        claimed.claimRefresh(createUuidV7(), later(MANAGED_REFRESH_STALE_MS)),
      "MANAGED_CONNECTION_REFRESH_BUSY",
    );
  });

  concurrentTest("allows a new claim over a stale one", () => {
    const claimed = newGrant().claimRefresh(createUuidV7(), claimedAt);
    const next = createUuidV7();
    const reclaimed = claimed.claimRefresh(
      next,
      later(MANAGED_REFRESH_STALE_MS + 1),
    );
    expect(reclaimed.refreshClaim?.claimId).toBe(next);
  });

  concurrentTest("a retired grant can't be claimed", () => {
    const retired = newGrant().retire(claimedAt);
    expectCoreError(
      () => retired.claimRefresh(createUuidV7(), claimedAt),
      "MANAGED_OAUTH_GRANT_RETIRED",
    );
  });

  concurrentTest("retiring clears the claim", () => {
    const retired = newGrant()
      .claimRefresh(createUuidV7(), claimedAt)
      .retire(later(1));
    expect(retired.isRetired).toBe(true);
    expect(retired.refreshClaim).toBeNull();
  });

  concurrentTest("a retired grant can't be rehydrated with a claim", () => {
    const retired = newGrant().retire(claimedAt);
    expectCoreError(
      () =>
        ManagedOAuthGrantEntity.rehydrate({
          ...retired.toJSON(),
          refreshClaim: { claimId: createUuidV7(), claimedAt },
        }),
      "MANAGED_OAUTH_GRANT_INVALID",
    );
  });
});

describe("ManagedOAuthGrantEntity completeRefresh", () => {
  concurrentTest(
    "stores the new credentials under the next version and clears the claim",
    () => {
      const crypto = newCrypto();
      const claimId = createUuidV7();
      const claimed = newGrant(crypto).claimRefresh(claimId, claimedAt);
      const encrypted = crypto.encryptCredentials(
        {
          ...target(claimed),
          credentialVersion: claimed.credentialVersion + 1,
        },
        credentials("second"),
      );
      const completed = claimed.completeRefresh(claimId, encrypted, later(1));
      expect(completed.credentialVersion).toBe(2);
      expect(completed.refreshClaim).toBeNull();
      expect(completed.updatedAt).toEqual(later(1));
      expect(
        crypto.decryptCredentials(target(completed), liveCiphertext(completed)),
      ).toEqual(credentials("second"));
    },
  );

  concurrentTest("the old ciphertext no longer decrypts after the bump", () => {
    const crypto = newCrypto();
    const claimId = createUuidV7();
    const original = newGrant(crypto);
    const oldCiphertext = liveCiphertext(original);
    const claimed = original.claimRefresh(claimId, claimedAt);
    const completed = claimed.completeRefresh(
      claimId,
      crypto.encryptCredentials(
        { ...target(claimed), credentialVersion: 2 },
        credentials("second"),
      ),
      later(1),
    );
    expect(() =>
      crypto.decryptCredentials(target(completed), oldCiphertext),
    ).toThrow(CoreError);
  });

  concurrentTest("rejects a claim id that isn't the current one", () => {
    const claimed = newGrant().claimRefresh(createUuidV7(), claimedAt);
    expectCoreError(
      () =>
        claimed.completeRefresh(
          createUuidV7(),
          liveCiphertext(claimed),
          later(1),
        ),
      "MANAGED_CONNECTION_CHANGED",
    );
  });

  concurrentTest("rejects an unclaimed or retired grant", () => {
    const claimId: UuidV7 = createUuidV7();
    const grant = newGrant();
    const ciphertext = liveCiphertext(grant);
    expectCoreError(
      () => grant.completeRefresh(claimId, ciphertext, later(1)),
      "MANAGED_CONNECTION_CHANGED",
    );
    const retired = grant.claimRefresh(claimId, claimedAt).retire(later(1));
    expectCoreError(
      () => retired.completeRefresh(claimId, ciphertext, later(2)),
      "MANAGED_CONNECTION_CHANGED",
    );
  });
});

describe("ManagedOAuthGrantEntity releaseClaim", () => {
  concurrentTest("clears the claim and keeps the credentials", () => {
    const claimId = createUuidV7();
    const original = newGrant();
    const released = original
      .claimRefresh(claimId, claimedAt)
      .releaseClaim(claimId, later(1));
    expect(released.refreshClaim).toBeNull();
    expect(released.credentialVersion).toBe(1);
    expect(liveCiphertext(released)).toBe(liveCiphertext(original));
    expect(
      released.claimRefresh(createUuidV7(), later(2)).refreshClaim,
    ).not.toBeNull();
  });

  concurrentTest("rejects a claim id that isn't the current one", () => {
    const claimed = newGrant().claimRefresh(createUuidV7(), claimedAt);
    expectCoreError(
      () => claimed.releaseClaim(createUuidV7(), later(1)),
      "MANAGED_CONNECTION_CHANGED",
    );
  });
});
