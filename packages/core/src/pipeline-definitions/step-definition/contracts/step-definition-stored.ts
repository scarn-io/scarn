import { z } from "zod";
import type { AnyJsonObject } from "@scarn/core/common/contracts/json";
import { createStoredReader } from "@scarn/core/lib/db/stored-json";
import type { Grant } from "@scarn/core/tasks/task/domain/grants";
import type { RetryPolicyEntry } from "@scarn/core/tasks/task/domain/retry-decision";
import type {
  StepConcurrency,
  StepDefinitionEntrypoint,
  StepDefinitionToolCall,
} from "../domain/step-definition-entity";

/**
 * Read-side schemas for the JSON columns of `step_definitions`, one per
 * `schema_version`. The version covers all eight columns together:
 * `entrypoint_json`, `tool_call_json`, `input_schema_json`,
 * `result_schema_json`, `errors_json`, `retry_json`, `grants_json` and
 * `concurrency_json`.
 *
 * Structural only: the write-side rules (`StepDefinitionEntity.create`, the
 * step-definition contracts, `grantsSchema`) are not re-applied, so
 * tightening them never makes a stored step definition unreadable. Error
 * names are not trimmed or checked for uniqueness, retry entries are not
 * checked against the declared errors, grant actions and scopes are plain
 * strings, and concurrency bounds are not checked. Each version's shape is
 * frozen here.
 *
 * The stored grants, JSON Schemas and tool-call shapes are wider than the
 * domain types (`Grant`, `AnyJsonObject`, `StepDefinitionToolCall`); the
 * parsed document is cast to {@link StoredStepDefinitionDocument}, trusting
 * that this code wrote them through the write rules.
 *
 * `tasks` copies `entrypoint`, `tool_call`, `retry` and `grants` from its
 * step, so those shapes are exported for its stored reader.
 *
 * A breaking change to any of these columns adds a new version, a stored
 * schema for it, a `vN → vN+1` converter and a fixture under
 * `tests/pipeline-definitions/step-definition/fixtures/`. See
 * `docs/persistence/json-columns.md`.
 */

const storedJsonSchemaV1 = z.union([
  z.record(z.string(), z.json()),
  z.boolean(),
]);

export const storedStepEntrypointV1 = z.looseObject({
  sourceFile: z.string(),
});

export const storedToolCallV1 = z.looseObject({
  server: z.string(),
  tool: z.string(),
  argsTemplate: z.json(),
  toolSchemas: z.looseObject({
    input: storedJsonSchemaV1,
    output: storedJsonSchemaV1.nullable(),
  }),
});

export const storedRetryV1 = z.array(
  z.object({
    on: z.array(z.string()),
    maxAttempts: z.number(),
  }),
);

export const storedGrantV1 = z.object({
  resource: z.string(),
  action: z.string(),
  scope: z.string(),
  labels: z.array(z.string()).optional(),
  keyPrefix: z.string().optional(),
});

export const storedGrantsV1 = z.array(storedGrantV1);

export const storedStepConcurrencyV1 = z.object({
  max: z.number(),
  waiting: z.number(),
});

const storedStepDefinitionV1Schema = z.object({
  entrypointJson: storedStepEntrypointV1.nullable(),
  toolCallJson: storedToolCallV1.nullable(),
  inputSchemaJson: z.json(),
  resultSchemaJson: z.json().nullable(),
  errorsJson: z.array(z.string()),
  retryJson: storedRetryV1,
  grantsJson: storedGrantsV1,
  concurrencyJson: storedStepConcurrencyV1.nullable(),
});

/** A step definition's JSON columns, read into the current domain shapes. */
export type StoredStepDefinitionDocument = {
  entrypointJson: StepDefinitionEntrypoint | null;
  toolCallJson: StepDefinitionToolCall | null;
  inputSchemaJson: AnyJsonObject;
  resultSchemaJson: AnyJsonObject | null;
  errorsJson: string[];
  retryJson: RetryPolicyEntry[];
  grantsJson: Grant[];
  concurrencyJson: StepConcurrency | null;
};

export const CURRENT_STEP_DEFINITION_SCHEMA_VERSION = 1;

/** The JSON columns of a `step_definitions` row. */
export type StoredStepDefinitionColumns = {
  entrypointJson: unknown;
  toolCallJson: unknown;
  inputSchemaJson: unknown;
  resultSchemaJson: unknown;
  errorsJson: unknown;
  retryJson: unknown;
  grantsJson: unknown;
  concurrencyJson: unknown;
};

/**
 * Reads a row's JSON columns at `schemaVersion` into the current shapes, or
 * explains why they are unreadable.
 */
export const readStoredStepDefinition = createStoredReader<
  StoredStepDefinitionColumns,
  StoredStepDefinitionDocument,
  1
>({
  current: CURRENT_STEP_DEFINITION_SCHEMA_VERSION,
  byVersion: {
    1: (columns) =>
      storedStepDefinitionV1Schema.safeParse(
        columns,
      ) as z.ZodSafeParseResult<StoredStepDefinitionDocument>,
  },
});
