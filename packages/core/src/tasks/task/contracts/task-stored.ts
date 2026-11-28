import { z } from "zod";
import type {
  AnyJsonObject,
  AnyJsonValue,
} from "@scarn/core/common/contracts/json";
import { createStoredReader } from "@scarn/core/lib/db/stored-json";
import {
  storedGrantsV1,
  storedRetryV1,
  storedStepEntrypointV1,
  storedToolCallV1,
} from "@scarn/core/pipeline-definitions/step-definition/contracts/step-definition-stored";
import type {
  TaskEntrypoint,
  TaskToolCall,
} from "@scarn/core/tasks/task-run/domain/task-run-entity";
import type { Grant } from "../domain/grants";
import type { WorkItemChange } from "./work-item-change-contracts";
import type { TaskEnvironmentSelection } from "../domain/task-environment-selection";
import { readStoredTaskEnvironmentSelection } from "./task-environment-selection-contracts";

/**
 * Read-side schemas for the JSON columns of `tasks`, one per
 * `schema_version`. The version covers all ten columns together:
 * `entrypoint_json`, `tool_call_json`, `result_schema_json`, `input_json`,
 * `retry_json`, `environment_selection_json`, `grants_json`,
 * `held_work_item_changes_json`, `result_json` and `error_json`.
 *
 * A Task's instructions are a snapshot copied from its step definition (or
 * pipeline node) when it is created, and the worker executes from them for
 * as long as the Task lives, so every version must keep reading every row
 * written at it.
 *
 * - `entrypoint_json`, `tool_call_json` and `grants_json` reuse the frozen
 *   step-definition v1 shapes (`step-definition-stored.ts`).
 * - `retry_json` reuses the step-definition v1 entry shape, loose: a Task
 *   created by a pipeline step copies the node's `retry`, whose entries also
 *   carry `intervalSeconds`, `backoffRate` and `maxDelaySeconds`, and those
 *   are kept.
 * - `environment_selection_json` versions itself inside the JSON; v1 reads
 *   it with `readStoredTaskEnvironmentSelection`.
 * - `held_work_item_changes_json` is a list of `WorkItemChange`s; rows
 *   written before the column existed read its default `[]`.
 * - `result_schema_json`, `input_json` and `result_json` are opaque JSON.
 * - `error_json` is a loose `{ name, message, cause? }` (as
 *   `taskStateForRun` and `maxTurnsExceeded` write it) with `name` and
 *   `message` pinned. SQL reads `tasks.error_json ->> 'message'`
 *   (`task-message-sql.ts` `taskErrorMessageSql`, and the standalone-Task
 *   search in `project-runs-sql.ts` `standaloneTaskRows`).
 *
 * Structural only: the write rules (`TaskEntity.create`, `taskGrants`,
 * `grantsSchema`) are not re-applied. The parsed document is cast to
 * {@link StoredTaskDocument}, trusting that this code wrote it through those
 * rules.
 *
 * A breaking change to any of these columns adds a new version, a stored
 * schema for it, a `vN → vN+1` converter and a fixture under
 * `tests/tasks/task/fixtures/`. See `docs/persistence/json-columns.md`.
 */

const storedTaskRetryV1 = z.array(storedRetryV1.element.loose());

const storedTaskErrorV1 = z.looseObject({
  name: z.string(),
  message: z.string(),
  cause: z.json().optional(),
});

const storedTaskEnvironmentSelectionV1 = z
  .unknown()
  .transform((stored, context) => {
    const read = readStoredTaskEnvironmentSelection(stored);
    if (!read.success) {
      context.addIssue({ code: "custom", message: read.reason });
      return z.NEVER;
    }
    return read.selection;
  });

/**
 * `held_work_item_changes_json`: the frozen v1 shape of a
 * `WorkItemChange` (`work-item-change-contracts.ts`), structural only.
 */
const storedWorkItemChangeV1 = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("label"),
    workItemId: z.string(),
    add: z.array(z.string()).optional(),
    remove: z.array(z.string()).optional(),
  }),
  z.object({
    kind: z.literal("block"),
    blockedWorkItemId: z.string(),
    blockingWorkItemId: z.string(),
    remove: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("describe"),
    workItemId: z.string(),
    description: z.string(),
    descriptionVersion: z.number(),
  }),
  z.object({
    kind: z.literal("comment"),
    workItemId: z.string(),
    body: z.string(),
  }),
  z.object({
    kind: z.literal("close"),
    workItemId: z.string(),
    reason: z.string(),
    resolution: z.string().nullable().optional(),
  }),
]);

export const storedWorkItemChangesV1 = z.array(storedWorkItemChangeV1);

const storedTaskInstructionsV1Shape = {
  entrypointJson: storedStepEntrypointV1.nullable(),
  toolCallJson: storedToolCallV1.nullable(),
  resultSchemaJson: z.json().nullable(),
  inputJson: z.json().nullable(),
};

const storedTaskInstructionsV1Schema = z.object(storedTaskInstructionsV1Shape);

const storedTaskV1Schema = z.object({
  ...storedTaskInstructionsV1Shape,
  retryJson: storedTaskRetryV1.nullable(),
  environmentSelectionJson: storedTaskEnvironmentSelectionV1,
  grantsJson: storedGrantsV1,
  heldWorkItemChangesJson: storedWorkItemChangesV1,
  resultJson: z.json().nullable(),
  errorJson: storedTaskErrorV1.nullable(),
});

/** The instructions a Task's runs read from it, in the current domain shapes. */
export type StoredTaskInstructions = {
  entrypointJson: TaskEntrypoint | null;
  toolCallJson: TaskToolCall | null;
  resultSchemaJson: AnyJsonObject | null;
  inputJson: AnyJsonValue | null;
};

/** A Task's JSON columns, read into the current domain shapes. */
export type StoredTaskDocument = StoredTaskInstructions & {
  retryJson: AnyJsonValue | null;
  environmentSelection: TaskEnvironmentSelection | null;
  grants: Grant[];
  heldWorkItemChanges: WorkItemChange[];
  resultJson: AnyJsonValue | null;
  errorJson: AnyJsonValue | null;
};

export const CURRENT_TASK_SCHEMA_VERSION = 1;

/** The JSON columns of a `tasks` row that its runs read. */
export type StoredTaskInstructionColumns = {
  entrypointJson: unknown;
  toolCallJson: unknown;
  resultSchemaJson: unknown;
  inputJson: unknown;
};

/** The JSON columns of a `tasks` row. */
export type StoredTaskColumns = StoredTaskInstructionColumns & {
  retryJson: unknown;
  environmentSelectionJson: unknown;
  grants: unknown;
  heldWorkItemChangesJson: unknown;
  resultJson: unknown;
  errorJson: unknown;
};

/**
 * Reads a row's JSON columns at `schemaVersion` into the current shapes, or
 * explains why they are unreadable.
 */
export const readStoredTask = createStoredReader<
  StoredTaskColumns,
  StoredTaskDocument,
  1
>({
  current: CURRENT_TASK_SCHEMA_VERSION,
  byVersion: {
    1: (columns) =>
      storedTaskV1Schema
        .transform(
          ({
            environmentSelectionJson,
            grantsJson,
            heldWorkItemChangesJson,
            ...rest
          }) => ({
            ...rest,
            environmentSelection: environmentSelectionJson,
            grants: grantsJson,
            heldWorkItemChanges: heldWorkItemChangesJson,
          }),
        )
        .safeParse({
          ...columns,
          grantsJson: columns.grants,
        }) as z.ZodSafeParseResult<StoredTaskDocument>,
  },
});

/**
 * Reads only the instruction columns a Task's runs carry (`task_runs` joins
 * them from `tasks`), at the Task's `schemaVersion`.
 */
export const readStoredTaskInstructions = createStoredReader<
  StoredTaskInstructionColumns,
  StoredTaskInstructions,
  1
>({
  current: CURRENT_TASK_SCHEMA_VERSION,
  byVersion: {
    1: (columns) =>
      storedTaskInstructionsV1Schema.safeParse(
        columns,
      ) as z.ZodSafeParseResult<StoredTaskInstructions>,
  },
});
