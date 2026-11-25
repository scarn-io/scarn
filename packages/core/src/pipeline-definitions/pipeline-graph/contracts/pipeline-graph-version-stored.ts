import { z } from "zod";
import type { PipelineDocument } from "@scarn/sdk/contracts/pipeline-document";
import { createStoredReader } from "@scarn/core/lib/db/stored-json";

/**
 * Read-side schemas for `pipeline_graph_versions.definition_json`, one per
 * `schema_version`. Structural only: publish rules (node id and alias
 * patterns, condition grammar, `each`/`partial` exclusivity, non-empty
 * strings, positive integers, enum membership of `match`, `for`, `op` and
 * `body`) are not re-applied, so tightening the SDK's
 * `pipelineDocumentSchema` never makes a published version unreadable.
 * Objects are loose: keys this shape doesn't name pass through untouched, so
 * an optional key added to the format later still reaches the engine.
 * Conditions are opaque objects and route args are any JSON. Each version's
 * shape is frozen here rather than imported from the SDK; the parsed value
 * is typed as the SDK's `PipelineDocument` because the engine consumes that
 * type, and the publish path already validated it against the SDK schema
 * when it was written.
 *
 * JSON keys read straight from SQL are part of this contract too, and a
 * breaking change to any of them needs a version bump:
 * - `definition_json -> 'nodes' -> <node id> ->> 'kind'` and `->> 'for'`
 *   (`project-runs-sql.ts`, `drizzle-project-inbox-wait-reader.ts`)
 * - `->> 'error'` (`project-runs-sql.ts`)
 * - `->> 'title'` and `-> 'actions'` (`drizzle-project-inbox-wait-reader.ts`)
 * - `->> 'step'` (`drizzle-comment-artifact-reader.ts`,
 *   `work-item-signal-score-subquery.ts`)
 *
 * A breaking change to the stored shape adds a new version, a stored schema
 * for it, a `vN → vN+1` converter and a fixture under
 * `tests/pipeline-definitions/pipeline-graph/fixtures/`. See
 * `docs/persistence/json-columns.md`.
 */

const storedConditionSchema = z.looseObject({});

const storedArgsSchema = z.record(z.string(), z.json());

const storedEachSchema = z.looseObject({
  over: z.string(),
  maxConcurrency: z.number().optional(),
  toleratedFailures: z.looseObject({}).optional(),
});

const storedRouteV1Schema = z.looseObject({
  when: storedConditionSchema.optional(),
  to: z.string(),
  pipeline: z.string().optional(),
  args: storedArgsSchema.optional(),
  each: storedEachSchema.optional(),
  partial: z.boolean().optional(),
  label: z.string().optional(),
  overridable: z.boolean().optional(),
});

const storedNextV1Schema = z.looseObject({
  match: z.string().optional(),
  routes: z.array(storedRouteV1Schema),
  otherwise: storedRouteV1Schema.optional(),
  overridable: z.boolean().optional(),
});

const storedRetryV1Schema = z.looseObject({
  on: z.array(z.string()),
  maxAttempts: z.number(),
  intervalSeconds: z.number().optional(),
  backoffRate: z.number().optional(),
  maxDelaySeconds: z.number().optional(),
});

const storedCatchV1Schema = z.looseObject({
  on: z.array(z.string()),
  to: z.string(),
  pipeline: z.string().optional(),
  args: storedArgsSchema.optional(),
});

const storedNodeV1Schema = z.discriminatedUnion("kind", [
  z.looseObject({
    kind: z.literal("step"),
    title: z.string().optional(),
    step: z.string(),
    next: storedNextV1Schema.optional(),
    retry: z.array(storedRetryV1Schema).optional(),
    catch: z.array(storedCatchV1Schema).optional(),
    timeoutSeconds: z.number().optional(),
    heartbeatSeconds: z.number().optional(),
    maxRuns: z.number().optional(),
    maxTurns: z.number().optional(),
  }),
  z.looseObject({
    kind: z.literal("wait"),
    title: z.string().optional(),
    for: z.string(),
    actions: z
      .array(
        z.looseObject({
          key: z.string(),
          label: z.string(),
          body: z.string().optional(),
        }),
      )
      .optional(),
    next: storedNextV1Schema.optional(),
    catch: z.array(storedCatchV1Schema).optional(),
    timeoutSeconds: z.number().optional(),
    maxRuns: z.number().optional(),
  }),
  z.looseObject({
    kind: z.literal("succeed"),
    title: z.string().optional(),
  }),
  z.looseObject({
    kind: z.literal("fail"),
    title: z.string().optional(),
    error: z.string().optional(),
    cause: z.string().optional(),
  }),
]);

export const storedPipelineDocumentV1Schema = z
  .looseObject({
    $schema: z.string().optional(),
    schemaVersion: z.literal(1),
    key: z.string(),
    title: z.string().optional(),
    timeoutSeconds: z.number().optional(),
    workItemFields: z.record(z.string(), z.string()).optional(),
    start: storedRouteV1Schema,
    nodes: z.record(z.string(), storedNodeV1Schema),
  })
  .transform((document) => document as PipelineDocument);

export const CURRENT_PIPELINE_GRAPH_VERSION_SCHEMA_VERSION = 1;

/** The JSON column of a `pipeline_graph_versions` row, as read. */
export type StoredPipelineGraphVersionColumns = { definitionJson: unknown };

/**
 * Reads a version's `definition_json` at `schemaVersion` into the current
 * shape, or explains why it is unreadable.
 */
export const readStoredPipelineDocument = createStoredReader<
  StoredPipelineGraphVersionColumns,
  PipelineDocument,
  1
>({
  current: CURRENT_PIPELINE_GRAPH_VERSION_SCHEMA_VERSION,
  byVersion: {
    1: (columns) =>
      storedPipelineDocumentV1Schema.safeParse(columns.definitionJson),
  },
});
