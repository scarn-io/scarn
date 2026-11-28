import { describe, expect, test } from "bun:test";
import { createUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import {
  buildShareToken,
  verifyShareToken,
} from "@/tasks/artifact-share/domain/share-token";
import {
  artifactShareUrl,
  createArtifactSharingConfig,
  resolveArtifactSharingConfig,
} from "@/tasks/artifact-share/domain/artifact-sharing-config";

describe("share tokens", () => {
  const secret = "unit-test-secret";

  test("a built token verifies to its share id", () => {
    const shareId = createUuidV7();
    const token = buildShareToken(secret, shareId);

    expect(token).toStartWith(`${shareId}.`);
    expect(token).toMatch(/^[0-9a-f-]+\.[A-Za-z0-9_-]+$/);
    expect(buildShareToken(secret, shareId)).toBe(token);
    expect(verifyShareToken(secret, token)).toBe(shareId);
  });

  test("a token does not verify under another secret", () => {
    const token = buildShareToken(secret, createUuidV7());
    expect(verifyShareToken("rotated", token)).toBeNull();
  });

  test("one share's MAC does not verify another share id", () => {
    const [, mac] = buildShareToken(secret, createUuidV7()).split(".");
    const otherId = createUuidV7();
    expect(verifyShareToken(secret, `${otherId}.${String(mac)}`)).toBeNull();
  });

  test.each([
    "",
    ".",
    "no-dot",
    "not-a-uuid.abc",
    `${createUuidV7()}.`,
    `${createUuidV7()}.tampered`,
  ])("rejects a malformed token %p", (token) => {
    expect(verifyShareToken(secret, token)).toBeNull();
  });
});

describe("artifact sharing config", () => {
  test("is enabled only when both the content URL and secret are set", () => {
    expect(
      resolveArtifactSharingConfig({
        SCARN_ARTIFACT_CONTENT_URL: " https://content.example.test// ",
        ARTIFACT_SHARE_SECRET: " s3cret ",
      }),
    ).toEqual({
      contentUrl: "https://content.example.test",
      shareSecret: "s3cret",
      contentOriginSecret: null,
      enabled: true,
      disabledReason: null,
    });
    expect(
      resolveArtifactSharingConfig({ ARTIFACT_SHARE_SECRET: "s" }).enabled,
    ).toBe(false);
    expect(
      resolveArtifactSharingConfig({
        SCARN_ARTIFACT_CONTENT_URL: "https://c.test",
        ARTIFACT_SHARE_SECRET: "  ",
      }),
    ).toEqual({
      contentUrl: "https://c.test",
      shareSecret: null,
      contentOriginSecret: null,
      enabled: false,
      disabledReason: "not_configured",
    });
    expect(createArtifactSharingConfig({}).enabled).toBe(false);
  });

  test("builds the share URL under /s/<token>/", () => {
    expect(artifactShareUrl("https://c.test", "abc.def")).toBe(
      "https://c.test/s/abc.def/",
    );
  });
});
