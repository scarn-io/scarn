import { describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import { getDb } from "@/lib/db";
import { managedOAuthClients } from "@/lib/db/schema";
import { concurrentTest } from "tests/utils";

const NOW = new Date("2026-11-19T12:00:00.000Z");
const REDIRECT_URI = "https://scarn.test/api/oauth/mcp/callback";

const clientRow = (
  issuer: string,
  overrides: Partial<typeof managedOAuthClients.$inferInsert> = {},
) => ({
  id: createUuidV7(),
  issuer,
  redirectUri: REDIRECT_URI,
  clientId: `client-${createUuidV7()}`,
  registeredAt: NOW,
  ...overrides,
});

const pgCodeOf = async (promise: Promise<unknown>): Promise<string | null> => {
  try {
    await promise;
    return null;
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause;
    return cause?.code ?? (error as { code?: string }).code ?? null;
  }
};

/**
 * `managed_oauth_clients` keeps at most one live (not stale) client per
 * authorization server and redirect URI; stale clients stay as history.
 */
describe("managed_oauth_clients live-client index", () => {
  concurrentTest(
    "a second live client for the same issuer and redirect URI is refused",
    async () => {
      const issuer = `https://as-${createUuidV7()}.test`;
      await getDb().insert(managedOAuthClients).values(clientRow(issuer));

      expect(
        await pgCodeOf(
          getDb().insert(managedOAuthClients).values(clientRow(issuer)),
        ),
      ).toBe("23505");
    },
  );

  concurrentTest(
    "a stale client and a live one for the same issuer and redirect URI coexist",
    async () => {
      const issuer = `https://as-${createUuidV7()}.test`;
      await getDb()
        .insert(managedOAuthClients)
        .values([
          clientRow(issuer, { staleAt: NOW }),
          clientRow(issuer, { staleAt: NOW }),
          clientRow(issuer),
        ]);

      const rows = await getDb()
        .select({ staleAt: managedOAuthClients.staleAt })
        .from(managedOAuthClients)
        .where(eq(managedOAuthClients.issuer, issuer));
      expect(rows).toHaveLength(3);
      expect(rows.filter((row) => row.staleAt === null)).toHaveLength(1);
    },
  );

  concurrentTest(
    "live clients for other redirect URIs on the same issuer coexist",
    async () => {
      const issuer = `https://as-${createUuidV7()}.test`;
      await getDb()
        .insert(managedOAuthClients)
        .values([
          clientRow(issuer),
          clientRow(issuer, {
            redirectUri: "https://staging.scarn.test/api/oauth/mcp/callback",
          }),
        ]);

      expect(
        await getDb()
          .select({ id: managedOAuthClients.id })
          .from(managedOAuthClients)
          .where(eq(managedOAuthClients.issuer, issuer)),
      ).toHaveLength(2);
    },
  );
});
