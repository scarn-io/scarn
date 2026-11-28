import { z } from "zod";
import { createStoredReader } from "@scarn/core/lib/db/stored-json";
import { storedGrantsV1 } from "@scarn/core/pipeline-definitions/step-definition/contracts/step-definition-stored";
import type { Grant } from "@scarn/core/tasks/task/domain/grants";

/**
 * Read-side schemas for the JSON columns of `task_grant_requests`
 * (`requested_json` and `approved_json`), one per `schema_version`. Both
 * reuse the frozen step-definition v1 grant shape (`storedGrantsV1`).
 *
 * Structural only: the write rules (`grantSchema`) are not re-applied. The
 * parsed grants are cast to `Grant[]`, trusting that this code wrote them
 * through those rules. See `docs/persistence/json-columns.md`.
 */

const storedGrantRequestV1Schema = z.object({
  requestedJson: storedGrantsV1,
  approvedJson: storedGrantsV1.nullable(),
});

export const CURRENT_GRANT_REQUEST_SCHEMA_VERSION = 1;

/** The JSON columns of a `task_grant_requests` row. */
export type StoredGrantRequestColumns = {
  requestedJson: unknown;
  approvedJson: unknown;
};

/** A request's JSON columns, read into the current domain shapes. */
export type StoredGrantRequestDocument = {
  requested: Grant[];
  approved: Grant[] | null;
};

/** Reads a row's JSON columns at `schemaVersion` into the current shapes. */
export const readStoredGrantRequest = createStoredReader<
  StoredGrantRequestColumns,
  StoredGrantRequestDocument,
  1
>({
  current: CURRENT_GRANT_REQUEST_SCHEMA_VERSION,
  byVersion: {
    1: (columns) =>
      storedGrantRequestV1Schema
        .transform(({ requestedJson, approvedJson }) => ({
          requested: requestedJson,
          approved: approvedJson,
        }))
        .safeParse(columns) as z.ZodSafeParseResult<StoredGrantRequestDocument>,
  },
});
