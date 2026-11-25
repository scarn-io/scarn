import { z } from "zod";
import type {
  JsonObject,
  JsonValue,
} from "@scarn/sdk/contracts/pipeline-document";
import {
  createStoredReader,
  createTolerantReader,
} from "@scarn/core/lib/db/stored-json";
import type {
  EngineError,
  Routing,
  VisitTransition,
} from "../domain/engine/types";

/**
 * Read-side schemas for the pipeline-run engine state: the JSON columns of
 * `lanes` and `node_visits` (versioned, one `schema_version` per table) and
 * `pipeline_runs.error_json` (tolerant).
 *
 * Structural only, and frozen here. The engine and rerun/overrule read old
 * rows, so each version must keep reading every row written at it.
 *
 * - One {@link storedVisitTransitionV1} (`{ kind, index }`) is shared by
 *   `lanes.route`, `lanes.arrival_transition`, `node_visits.transition` and
 *   `routing_json.taken` / `overrules`. A breaking change to it bumps
 *   **both** tables in one PR.
 * - `kind` is any string: a retired or future kind still reads. The parsed
 *   document is cast to the domain's {@link VisitTransition} (a `kind`
 *   union), trusting the engine wrote it; the engine and the contract mapper
 *   decide what to do with a kind they don't know.
 * - `routing_json` is a loose object; `notes` entries only pin `kind`, so a
 *   retired note kind still reads. Unknown keys are kept, because overrule
 *   rewrites the column.
 * - `item_json`, `arrival_args_json`, `input_json` and `result_json` are
 *   opaque JSON.
 * - `error_json` (visits and runs) pins `message` only: SQL reads
 *   `error_json ->> 'message'` on both tables (`project-runs-sql.ts`).
 *
 * Upgrades are lazy: each row is read at its own version and upgraded in
 * memory; writers only write the current version. One run can hold rows at
 * different versions after a rerun. A breaking change adds a version, a
 * stored schema for it, a `vN → vN+1` converter and a fixture under
 * `tests/pipeline-executions/pipeline-run/fixtures/`. See
 * `docs/persistence/json-columns.md`.
 */

export const storedVisitTransitionV1 = z.object({
  kind: z.string(),
  index: z.number(),
});

const storedRoutingV1 = z.looseObject({
  checked: z
    .array(
      z.looseObject({
        index: z.number(),
        when: z.json().nullable(),
        matched: z.boolean(),
      }),
    )
    .optional(),
  taken: z.array(storedVisitTransitionV1).nullable().optional(),
  notes: z.array(z.looseObject({ kind: z.string() })).optional(),
  overrules: z
    .array(
      z.looseObject({
        from: z.array(storedVisitTransitionV1),
        to: z.array(storedVisitTransitionV1),
        byUserId: z.string(),
        at: z.string(),
        reason: z.string(),
        missingArgs: z
          .array(z.looseObject({ arg: z.string(), reference: z.string() }))
          .default([]),
      }),
    )
    .optional(),
});

const storedErrorV1 = z.looseObject({ message: z.string() });

const storedLaneV1Schema = z
  .object({
    itemJson: z.json().nullable(),
    routeJson: storedVisitTransitionV1,
    arrivalArgsJson: z.json().nullable(),
    arrivalTransitionJson: storedVisitTransitionV1.nullable(),
  })
  .transform((columns) => ({
    item: columns.itemJson,
    route: columns.routeJson,
    arrivalArgs: columns.arrivalArgsJson,
    arrivalTransition: columns.arrivalTransitionJson,
  }));

const storedNodeVisitV1Schema = z
  .object({
    transitionJson: storedVisitTransitionV1,
    routingJson: storedRoutingV1.nullable(),
    inputJson: z.json(),
    resultJson: z.json().nullable(),
    errorJson: storedErrorV1.nullable(),
  })
  .transform((columns) => ({
    transition: columns.transitionJson,
    routing: columns.routingJson,
    input: columns.inputJson,
    result: columns.resultJson,
    error: columns.errorJson,
  }));

export const CURRENT_LANE_SCHEMA_VERSION = 1;
export const CURRENT_NODE_VISIT_SCHEMA_VERSION = 1;

/** The JSON columns of a `lanes` row. */
export type StoredLaneColumns = {
  itemJson: unknown;
  routeJson: unknown;
  arrivalArgsJson: unknown;
  arrivalTransitionJson: unknown;
};

/** A lane's JSON columns, read into the current engine shapes. */
export type StoredLaneDocument = {
  item: JsonValue | null;
  route: VisitTransition;
  arrivalArgs: JsonObject | null;
  arrivalTransition: VisitTransition | null;
};

/** The JSON columns of a `node_visits` row. */
export type StoredNodeVisitColumns = {
  transitionJson: unknown;
  routingJson: unknown;
  inputJson: unknown;
  resultJson: unknown;
  errorJson: unknown;
};

/** A visit's JSON columns, read into the current engine shapes. */
export type StoredNodeVisitDocument = {
  transition: VisitTransition;
  routing: Routing | null;
  input: JsonObject;
  result: JsonValue | null;
  error: EngineError | null;
};

/** Reads a lane's JSON columns at `schemaVersion`, or explains why they are unreadable. */
export const readStoredLane = createStoredReader<
  StoredLaneColumns,
  StoredLaneDocument,
  1
>({
  current: CURRENT_LANE_SCHEMA_VERSION,
  byVersion: {
    1: (columns) =>
      storedLaneV1Schema.safeParse(
        columns,
      ) as z.ZodSafeParseResult<StoredLaneDocument>,
  },
});

/** Reads a visit's JSON columns at `schemaVersion`, or explains why they are unreadable. */
export const readStoredNodeVisit = createStoredReader<
  StoredNodeVisitColumns,
  StoredNodeVisitDocument,
  1
>({
  current: CURRENT_NODE_VISIT_SCHEMA_VERSION,
  byVersion: {
    1: (columns) =>
      storedNodeVisitV1Schema.safeParse(
        columns,
      ) as z.ZodSafeParseResult<StoredNodeVisitDocument>,
  },
});

/**
 * Reads `pipeline_runs.error_json`: a loose `{ name, message, cause? }` with
 * only `message` pinned. Tolerant, not versioned: the engine never branches
 * on a run's error.
 */
export const readStoredPipelineRunError = createTolerantReader(
  storedErrorV1.nullable() as unknown as z.ZodType<EngineError | null>,
);
