import { sql, type Column } from "drizzle-orm";

/**
 * Helpers for the handful of read models that have to be written as raw SQL.
 *
 * A projection that composes a `WITH` chain — the derived-status ladder, say —
 * cannot go through Drizzle's query builder, so it goes through `db.execute`.
 * That escape hatch also skips Drizzle's column decoders, which is where the
 * sharp edges live.
 */

/**
 * A `timestamptz` rendered as millisecond-precision ISO 8601 in UTC.
 *
 * `db.execute` bypasses Drizzle's column decoders, so a raw `timestamptz` comes
 * back as Postgres' own text rendering (`2026-07-30 21:38:26.312018+00`) — not
 * a `Date`, and not reliably parseable across engines. Formatting here produces
 * exactly what `Date.prototype.toISOString` produces, so the round trip through
 * `new Date(value)` is lossless.
 *
 * The fixed-width output also sorts lexicographically in chronological order,
 * which lets a query order on the same millisecond-truncated value the browser
 * would have compared.
 */
export const isoUtcText = (column: Column) =>
  sql`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
