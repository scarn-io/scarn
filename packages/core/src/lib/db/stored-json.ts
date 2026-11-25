import { z } from "zod";
import type { Logger } from "@scarn/observability/logging";

/**
 * Shared plumbing for reading stored JSON columns. A versioned
 * `<thing>-stored.ts` declares its frozen per-version schemas and upgrades
 * and builds its reader with {@link createStoredReader}; a tolerant one
 * builds it with {@link createTolerantReader}. Both return the same
 * {@link StoredReadResult}, so promoting a tolerant column to versioned only
 * changes the reader file. Bulk reads go through
 * {@link readRowsSkippingUnreadable}; single reads throw a
 * `PersistenceError`. See `docs/persistence/json-columns.md`.
 */

export type StoredReadResult<T> =
  { success: true; value: T } | { success: false; reason: string };

/** Parses a row's JSON columns stored at one schema version into the current shape. */
export type StoredVersionRead<Columns, T> = (
  columns: Columns,
) => z.ZodSafeParseResult<T>;

export type StoredReader<Columns, T> = (
  schemaVersion: number,
  columns: Columns,
) => StoredReadResult<T>;

export type TolerantReader<Columns, T> = (
  columns: Columns,
) => StoredReadResult<T>;

const fromSafeParse = <T>(
  parsed: z.ZodSafeParseResult<T>,
): StoredReadResult<T> =>
  parsed.success
    ? { success: true, value: parsed.data }
    : { success: false, reason: z.prettifyError(parsed.error) };

/**
 * Builds a reader that dispatches on `schema_version`: each entry of
 * `byVersion` parses that version's columns and upgrades them to the
 * current shape. An unknown version is unreadable, not an error.
 */
export const createStoredReader = <
  Columns,
  T,
  Version extends number,
>(definition: {
  current: NoInfer<Version>;
  byVersion: Record<Version, StoredVersionRead<Columns, T>>;
}): StoredReader<Columns, T> => {
  const { current, byVersion } = definition;
  const isKnownVersion = (version: number): version is Version =>
    Object.hasOwn(byVersion, version);
  return (schemaVersion, columns) => {
    if (!isKnownVersion(schemaVersion)) {
      return {
        success: false,
        reason: `unknown schema_version ${String(schemaVersion)} (current is ${String(current)})`,
      };
    }
    return fromSafeParse(byVersion[schemaVersion](columns));
  };
};

/** Builds a reader for an unversioned column from its structural stored schema. */
export const createTolerantReader =
  <T, Columns = unknown>(schema: z.ZodType<T>): TolerantReader<Columns, T> =>
  (columns) =>
    fromSafeParse(schema.safeParse(columns));

/**
 * Reads every row, logging and leaving out the ones that are unreadable so
 * one bad row doesn't fail the batch. `describe` gives the log fields that
 * identify a row (table, ids).
 */
export const readRowsSkippingUnreadable = <Row, T>(
  rows: readonly Row[],
  read: (row: Row) => StoredReadResult<T>,
  logger: Logger,
  describe: (row: Row) => Record<string, unknown>,
): T[] =>
  rows.flatMap((row) => {
    const result = read(row);
    if (!result.success) {
      logger.error(
        { ...describe(row), reason: result.reason },
        "Stored row is unreadable; skipping it",
      );
      return [];
    }
    return [result.value];
  });
