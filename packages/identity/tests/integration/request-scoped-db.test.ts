import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import pg from "pg";
import {
  currentDb,
  getDb,
  getSqlClient,
  runWithSqlClient,
} from "@/lib/db";
import { authVerifications } from "@/lib/db/schema";

const openScopedSql = () =>
  new pg.Pool({
    connectionString: process.env["DATABASE_URL"] ?? "",
    max: 1,
    application_name: "request-scoped-db-test",
  });

const applicationName = async (pool: pg.Pool): Promise<string> => {
  const { rows } = await pool.query<{ name: string }>(
    "select current_setting('application_name') as name",
  );
  return rows[0]?.name ?? "";
};

describe("runWithSqlClient", () => {
  test("binds getDb and getSqlClient to the given client inside the scope only", async () => {
    const scoped = openScopedSql();
    try {
      const shared = getDb();

      await runWithSqlClient(scoped, async () => {
        expect(getDb()).not.toBe(shared);
        expect(getSqlClient()).toBe(scoped);
        expect(await applicationName(getSqlClient())).toBe(
          "request-scoped-db-test",
        );
      });

      expect(getDb()).toBe(shared);
      expect(getSqlClient()).not.toBe(scoped);
    } finally {
      await scoped.end();
    }
  });

  test("reuses one Drizzle client and parses rows like the shared client", async () => {
    const first = openScopedSql();
    const second = openScopedSql();
    try {
      const expiresAt = new Date("2026-01-02T03:04:05.000Z");
      const identifier = `request-scoped-db-test-${crypto.randomUUID()}`;
      await getDb()
        .insert(authVerifications)
        .values({ identifier, value: "v", expiresAt });
      const byIdentifier = eq(authVerifications.identifier, identifier);

      const expected = await getDb()
        .select()
        .from(authVerifications)
        .where(byIdentifier);

      const firstDb = runWithSqlClient(first, () => getDb());
      const [viaSelect, viaQuery, secondDb] = await runWithSqlClient(
        second,
        async () => [
          await getDb().select().from(authVerifications).where(byIdentifier),
          await getDb().query.authVerifications.findMany({
            where: { identifier },
          }),
          getDb(),
        ],
      );

      expect(secondDb).toBe(firstDb);
      expect(viaSelect).toEqual(expected);
      expect(viaQuery).toEqual(expected);
      expect(expected[0]?.expiresAt).toEqual(expiresAt);

      const rawQuery = "select '2026-01-02'::date as day, now() as at";
      type RawRow = { day: unknown; at: unknown };
      const {
        rows: [sharedRaw],
      } = await getDb().execute<RawRow>(rawQuery);
      const {
        rows: [scopedRaw],
      } = await runWithSqlClient(
        first,
        async () => await getDb().execute<RawRow>(rawQuery),
      );
      expect(typeof scopedRaw?.day).toBe(typeof sharedRaw?.day);
      expect(typeof scopedRaw?.at).toBe(typeof sharedRaw?.at);

      await getDb().delete(authVerifications).where(byIdentifier);
    } finally {
      await first.end();
      await second.end();
    }
  });

  test("currentDb follows the scope on every access", async () => {
    const scoped = openScopedSql();
    try {
      expect(currentDb._.relations).toBe(getDb()._.relations);
      expect(Object.keys(currentDb.query)).toEqual(Object.keys(getDb().query));

      await runWithSqlClient(scoped, async () => {
        const {
          rows: [row],
        } = await currentDb.transaction(async (tx) =>
          tx.execute<{ name: string }>(
            "select current_setting('application_name') as name",
          ),
        );
        expect(row?.name).toBe("request-scoped-db-test");
      });
    } finally {
      await scoped.end();
    }
  });
});
