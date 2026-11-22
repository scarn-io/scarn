import { describe, expect, test } from "bun:test";
import pg from "pg";

/**
 * node-postgres parses only the types `pg-types` registers built in; an array
 * of an enum or a domain comes back as its raw `{...}` text. These tests pin
 * that the arrays we read still come back as arrays, and that no table gains
 * an array column whose element type `pg` would leave unparsed.
 */
describe("pg array parsing", () => {
  const withClient = async <T>(fn: (client: pg.Client) => Promise<T>) => {
    const client = new pg.Client({
      connectionString: process.env["DATABASE_URL"] ?? "",
    });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  };

  test("parses the built-in arrays our queries return", async () => {
    const {
      rows: [row],
    } = await withClient((client) =>
      client.query<Record<string, unknown>>(`
        select
          array['01a1a2e5-2004-76ee-8bca-d01e6cfbfd2d']::uuid[] as ids,
          '{}'::uuid[] as no_ids,
          '{bug,"needs triage"}'::text[] as labels,
          'running'::task_status as status
      `),
    );

    expect(row?.["ids"]).toEqual(["01a1a2e5-2004-76ee-8bca-d01e6cfbfd2d"]);
    expect(row?.["no_ids"]).toEqual([]);
    expect(row?.["labels"]).toEqual(["bug", "needs triage"]);
    expect(row?.["status"]).toBe("running");
  });

  test("no table column is an array of a user-defined type, or a domain", async () => {
    const { rows } = await withClient((client) =>
      client.query<{ column: string }>(`
        select c.table_schema || '.' || c.table_name || '.' || c.column_name as column
        from information_schema.columns c
        join pg_catalog.pg_type t on t.typname = c.udt_name
        join pg_catalog.pg_namespace n on n.oid = t.typnamespace and n.nspname = c.udt_schema
        where c.table_schema in ('app', 'identity', 'growth')
          and (t.typtype = 'd' or (t.typcategory = 'A' and t.typelem >= 16384))
      `),
    );

    expect(rows.map((c) => c.column)).toEqual([]);
  });
});
