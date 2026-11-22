import { describe, expect, test } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { signGitHubAppJwt } from "@/integrations/github-installation/infra/github-app-jwt";

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const base64UrlDecode = (input: string): Buffer =>
  Buffer.from(
    input.replace(/-/g, "+").replace(/_/g, "/") +
      "=".repeat((4 - (input.length % 4)) % 4),
    "base64",
  );

describe("signGitHubAppJwt", () => {
  test("produces an RS256-verifiable JWT with the expected claims", () => {
    const now = new Date("2026-05-24T12:00:00Z");
    const appId = "123456";

    const jwt = signGitHubAppJwt({
      appId,
      privateKey,
      now,
      ttlSeconds: 300,
    });

    const [headerPart, payloadPart, signaturePart] = jwt.split(".");
    expect(headerPart).toBeTruthy();
    expect(payloadPart).toBeTruthy();
    expect(signaturePart).toBeTruthy();

    const header = JSON.parse(
      base64UrlDecode(headerPart ?? "").toString("utf8"),
    ) as { alg: string; typ: string };
    const payload = JSON.parse(
      base64UrlDecode(payloadPart ?? "").toString("utf8"),
    ) as { iat: number; exp: number; iss: string };

    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(payload.iss).toBe(appId);

    const expectedIat = Math.floor(now.getTime() / 1000) - 60;
    expect(payload.iat).toBe(expectedIat);
    expect(payload.exp).toBe(expectedIat + 300 + 60);

    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${headerPart ?? ""}.${payloadPart ?? ""}`);
    verifier.end();
    const isValid = verifier.verify(
      publicKey,
      base64UrlDecode(signaturePart ?? ""),
    );
    expect(isValid).toBe(true);
  });
});
