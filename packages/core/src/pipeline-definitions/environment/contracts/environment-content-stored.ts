import {
  storedEnvironmentContentSchema,
  type EnvironmentContent,
} from "@scarn/core/common/contracts/environment";
import { z } from "zod";

/**
 * Read-side schemas for `environment_versions.content_json`, one per
 * `schema_version`. Structural only: unknown keys are stripped and write-time
 * rules are not re-applied, so tightening a write rule never makes a stored
 * version unreadable. A breaking change to the stored shape adds a new
 * version, a stored schema for it, a `vN → vN+1` converter and a fixture
 * under `tests/pipeline-definitions/environment/fixtures/`.
 */

export const storedEnvironmentContentV1Schema = storedEnvironmentContentSchema;

export const CURRENT_ENVIRONMENT_CONTENT_SCHEMA_VERSION = 1;

type EnvironmentContentSchemaVersion = 1;

/** The JSON column of an `environment_versions` row, as read. */
export type StoredEnvironmentVersionColumns = { contentJson: unknown };

const readStoredContentByVersion: Record<
  EnvironmentContentSchemaVersion,
  (
    columns: StoredEnvironmentVersionColumns,
  ) => z.ZodSafeParseResult<EnvironmentContent>
> = {
  1: (columns) =>
    storedEnvironmentContentV1Schema.safeParse(columns.contentJson),
};

const isKnownSchemaVersion = (
  version: number,
): version is EnvironmentContentSchemaVersion =>
  Object.hasOwn(readStoredContentByVersion, version);

export type ReadStoredEnvironmentContentResult =
  | { success: true; content: EnvironmentContent }
  | { success: false; reason: string };

/**
 * Reads a version's `content_json` at `schemaVersion` into the current
 * shape, or explains why it is unreadable.
 */
export const readStoredEnvironmentContent = (
  schemaVersion: number,
  columns: StoredEnvironmentVersionColumns,
): ReadStoredEnvironmentContentResult => {
  if (!isKnownSchemaVersion(schemaVersion)) {
    return {
      success: false,
      reason: `unknown schema_version ${String(schemaVersion)} (current is ${String(CURRENT_ENVIRONMENT_CONTENT_SCHEMA_VERSION)})`,
    };
  }
  const parsed = readStoredContentByVersion[schemaVersion](columns);
  return parsed.success
    ? { success: true, content: parsed.data }
    : { success: false, reason: z.prettifyError(parsed.error) };
};
