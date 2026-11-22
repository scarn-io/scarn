/**
 * Every workspace's integration tests share one Postgres, and the `jwt()`
 * plugin signs with the newest `identity.jwks` row, whose private key is
 * encrypted with `BETTER_AUTH_SECRET`. A row left behind by a run under another
 * secret makes `GET /api/auth/token` fail with "Failed to decrypt private
 * key", so every suite that mints tokens uses {@link TEST_BETTER_AUTH_SECRET}
 * and calls {@link removeUndecryptableSigningKeys} first. Only rows this secret
 * cannot open are removed, so a concurrently running suite never loses the key
 * it signs with.
 */
import { inArray } from "drizzle-orm";
import { symmetricDecrypt } from "better-auth/crypto";
import { getDb } from "../../../src/lib/db";
import { authJwks } from "../../../src/lib/db/schema";
import { getBetterAuthSecret } from "../../../src/lib/env";

export const TEST_BETTER_AUTH_SECRET = "scarn-test-better-auth-secret";

const canDecrypt = async (
  secret: string,
  privateKey: string,
): Promise<boolean> => {
  try {
    await symmetricDecrypt({
      key: secret,
      data: JSON.parse(privateKey) as string,
    });
    return true;
  } catch {
    return false;
  }
};

export const removeUndecryptableSigningKeys = async (): Promise<void> => {
  const secret = getBetterAuthSecret();
  const rows = await getDb()
    .select({ id: authJwks.id, privateKey: authJwks.privateKey })
    .from(authJwks);
  const undecryptable: string[] = [];
  for (const row of rows) {
    if (!(await canDecrypt(secret, row.privateKey))) undecryptable.push(row.id);
  }
  if (undecryptable.length === 0) return;
  await getDb().delete(authJwks).where(inArray(authJwks.id, undecryptable));
};
