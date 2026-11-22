import { spyOn } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  ACCESS_JWT_AUDIENCE,
  createAccessJwtVerifier,
  getAccessJwtVerifier,
} from "@scarn/identity";

const encodeSegment = (value: Record<string, unknown>): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

/**
 * An Ed25519 key pair for minting access JWTs in tests. `sign` produces a
 * token for `issuer`; `mockVerifier` points the shared access-JWT verifier at
 * this key (call it per test, since `mock.restore()` undoes it).
 */
export const createTestAccessJwt = async (issuer: string) => {
  const kid = randomUUID();
  const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]);
  const publicKey = JSON.stringify(
    await crypto.subtle.exportKey("jwk", keyPair.publicKey),
  );

  const sign = async (claims: Record<string, unknown> = {}) => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const signingInput = `${encodeSegment({ alg: "EdDSA", kid })}.${encodeSegment(
      {
        iss: issuer,
        aud: ACCESS_JWT_AUDIENCE,
        iat: nowSeconds,
        exp: nowSeconds + 15 * 60,
        ...claims,
      },
    )}`;
    const signature = await crypto.subtle.sign(
      { name: "Ed25519" },
      keyPair.privateKey,
      new TextEncoder().encode(signingInput),
    );
    return `${signingInput}.${Buffer.from(signature).toString("base64url")}`;
  };

  const mockVerifier = () => {
    const verifier = createAccessJwtVerifier({
      issuer,
      loadKeys: () =>
        Promise.resolve([
          { id: kid, publicKey, alg: "EdDSA", expiresAt: null },
        ]),
    });
    return spyOn(getAccessJwtVerifier(), "verify").mockImplementation(
      verifier.verify,
    );
  };

  return { sign, mockVerifier };
};
