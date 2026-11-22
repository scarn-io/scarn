import { createSign } from "node:crypto";

const base64UrlEncode = (input: Buffer | string): string =>
  (typeof input === "string" ? Buffer.from(input) : input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export type SignGitHubAppJwtInput = {
  appId: string;
  privateKey: string;
  now?: Date;
  ttlSeconds?: number;
};

export const signGitHubAppJwt = ({
  appId,
  privateKey,
  now = new Date(),
  ttlSeconds = 540,
}: SignGitHubAppJwtInput): string => {
  const issuedAt = Math.floor(now.getTime() / 1000) - 60;
  const expiresAt = issuedAt + ttlSeconds + 60;

  const header = base64UrlEncode(
    JSON.stringify({ alg: "RS256", typ: "JWT" }),
  );
  const payload = base64UrlEncode(
    JSON.stringify({ iat: issuedAt, exp: expiresAt, iss: appId }),
  );
  const signingInput = `${header}.${payload}`;

  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = base64UrlEncode(signer.sign(privateKey));

  return `${signingInput}.${signature}`;
};
