import {
  storedEnvironmentContentSchema,
  type EnvironmentContent,
} from "@scarn/core/common/contracts/environment";
import { createStoredReader } from "@scarn/core/lib/db/stored-json";

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

/** The JSON column of an `environment_versions` row, as read. */
export type StoredEnvironmentVersionColumns = { contentJson: unknown };

/**
 * Reads a version's `content_json` at `schemaVersion` into the current
 * shape, or explains why it is unreadable.
 */
export const readStoredEnvironmentContent = createStoredReader<
  StoredEnvironmentVersionColumns,
  EnvironmentContent,
  1
>({
  current: CURRENT_ENVIRONMENT_CONTENT_SCHEMA_VERSION,
  byVersion: {
    1: (columns) =>
      storedEnvironmentContentV1Schema.safeParse(columns.contentJson),
  },
});
