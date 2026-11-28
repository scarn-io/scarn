import { describe, expect, test } from "bun:test";
import { createUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import {
  buildPreviewToken,
  PREVIEW_TOKEN_TTL_MS,
  previewTokenExpiry,
  verifyPreviewToken,
} from "@/tasks/artifact-share/domain/preview-token";
import {
  buildShareToken,
  verifyShareToken,
} from "@/tasks/artifact-share/domain/share-token";

describe("preview tokens", () => {
  const secret = "unit-test-secret";
  const now = new Date("2026-11-26T12:00:00.000Z");
  const claims = () => ({
    bundleId: createUuidV7(),
    userId: "user_123",
    exp: previewTokenExpiry(now),
  });

  test("a built token verifies to its claims until it expires", () => {
    const input = claims();
    const token = buildPreviewToken(secret, input);

    expect(token).toMatch(/^pv1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(token).not.toContain("/");
    expect(verifyPreviewToken(secret, token, now)).toEqual(input);
    expect(
      verifyPreviewToken(secret, token, new Date(input.exp.getTime() - 1)),
    ).toEqual(input);
    expect(verifyPreviewToken(secret, token, input.exp)).toBeNull();
  });

  test("lasts 15 minutes", () => {
    expect(PREVIEW_TOKEN_TTL_MS).toBe(15 * 60 * 1000);
    expect(previewTokenExpiry(now).getTime() - now.getTime()).toBe(
      PREVIEW_TOKEN_TTL_MS,
    );
  });

  test("does not verify under another secret or when tampered with", () => {
    const input = claims();
    const token = buildPreviewToken(secret, input);
    expect(verifyPreviewToken("rotated", token, now)).toBeNull();

    const [prefix = "", , mac = ""] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ b: input.bundleId, u: "someone-else", e: 9e9 }),
    ).toString("base64url");
    expect(
      verifyPreviewToken(secret, `${prefix}.${forged}.${mac}`, now),
    ).toBeNull();
    expect(verifyPreviewToken(secret, `${token}x`, now)).toBeNull();
    expect(verifyPreviewToken(secret, "", now)).toBeNull();
    expect(verifyPreviewToken(secret, "pv1..", now)).toBeNull();
  });

  test("share and preview tokens never verify as each other", () => {
    const shareId = createUuidV7();
    const shareToken = buildShareToken(secret, shareId);
    expect(verifyPreviewToken(secret, shareToken, now)).toBeNull();

    const previewToken = buildPreviewToken(secret, claims());
    expect(verifyShareToken(secret, previewToken)).toBeNull();

    const [, encodedClaims = ""] = previewToken.split(".");
    const shareMac = buildShareToken(secret, shareId).split(".")[1] ?? "";
    expect(
      verifyPreviewToken(secret, `pv1.${encodedClaims}.${shareMac}`, now),
    ).toBeNull();
  });

  test("rejects a signed token whose claims are malformed", () => {
    const token = buildPreviewToken(secret, {
      bundleId: "not-a-uuid" as ReturnType<typeof createUuidV7>,
      userId: "u",
      exp: previewTokenExpiry(now),
    });
    expect(verifyPreviewToken(secret, token, now)).toBeNull();
  });
});
