import { describe, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@/lib/db/schema";
import {
  storedJsonRegistry,
  type StoredJsonEntry,
} from "@/lib/db/stored-json-registry";
import { concurrentTest } from "tests/utils";

const coreRoot = join(import.meta.dir, "../../..");

type JsonTable = { table: string; jsonColumns: string[]; columns: string[] };

const jsonTables: JsonTable[] = Object.values<unknown>(schema)
  .filter((value): value is PgTable => is(value, PgTable))
  .map((table) => {
    const config = getTableConfig(table);
    return {
      table: config.name,
      columns: config.columns.map((column) => column.name),
      jsonColumns: config.columns
        .filter((column) => column.getSQLType() === "jsonb")
        .map((column) => column.name),
    };
  })
  .filter((table) => table.jsonColumns.length > 0);

const registryByTable = new Map(
  storedJsonRegistry.map((entry) => [entry.table, entry]),
);

const registered = (
  entry: StoredJsonEntry,
): entry is Exclude<StoredJsonEntry, { status: "pending" }> =>
  entry.status === "versioned" || entry.status === "tolerant";

describe("stored JSON registry", () => {
  concurrentTest("finds the jsonb columns in schema.ts", () => {
    expect(jsonTables.length).toBeGreaterThan(0);
  });

  concurrentTest("registers every jsonb column", () => {
    const unregistered = jsonTables.flatMap(({ table, jsonColumns }) => {
      const entry = registryByTable.get(table);
      return jsonColumns
        .filter((column) => !entry?.columns.includes(column))
        .map((column) => `${table}.${column}`);
    });
    expect(unregistered).toEqual([]);
  });

  concurrentTest("registers no table or column that isn't jsonb", () => {
    const jsonColumnsByTable = new Map(
      jsonTables.map((table) => [table.table, table.jsonColumns]),
    );
    const stale = storedJsonRegistry.flatMap(({ table, columns }) =>
      columns
        .filter((column) => !jsonColumnsByTable.get(table)?.includes(column))
        .map((column) => `${table}.${column}`),
    );
    expect(stale).toEqual([]);
  });

  concurrentTest("registers each table once", () => {
    expect(registryByTable.size).toBe(storedJsonRegistry.length);
  });

  concurrentTest("leaves no entry pending", () => {
    const pending = storedJsonRegistry
      .filter((entry) => entry.status === "pending")
      .map((entry) => entry.table);
    expect(pending).toEqual([]);
  });

  concurrentTest("gives every versioned table a schema_version column", () => {
    const columnsByTable = new Map(
      jsonTables.map((table) => [table.table, table.columns]),
    );
    const missing = storedJsonRegistry
      .filter((entry) => entry.status === "versioned")
      .filter(
        (entry) => !columnsByTable.get(entry.table)?.includes("schema_version"),
      )
      .map((entry) => entry.table);
    expect(missing).toEqual([]);
  });

  concurrentTest(
    "gives every versioned and tolerant entry its fixtures and reader",
    () => {
      const missing = storedJsonRegistry
        .filter(registered)
        .flatMap((entry) => [
          ...(existsSync(join(coreRoot, "tests", entry.fixtures))
            ? []
            : [`${entry.table}: fixtures ${entry.fixtures}`]),
          ...(existsSync(join(coreRoot, "src", entry.reader))
            ? []
            : [`${entry.table}: reader ${entry.reader}`]),
        ]);
      expect(missing).toEqual([]);
    },
  );

  concurrentTest("gives every tolerant entry a reason", () => {
    const missing = storedJsonRegistry
      .filter(
        (entry) => entry.status === "tolerant" && entry.reason.trim() === "",
      )
      .map((entry) => entry.table);
    expect(missing).toEqual([]);
  });
});
