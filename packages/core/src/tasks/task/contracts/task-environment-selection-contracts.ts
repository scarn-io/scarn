import { environmentNameSchema } from "@scarn/core/common/contracts/environment";
import { ENV_VAR_NAME_PATTERN } from "@scarn/sdk/env-vars";
import { z } from "zod";
import type { TaskEnvironmentSelection } from "../domain/task-environment-selection";

const secretNameSchema = z
  .string()
  .trim()
  .regex(ENV_VAR_NAME_PATTERN, "must match /^[A-Z_][A-Z0-9_]*$/");

/** A catalog connector one Task adds, with a project secret for each var it needs. */
export const extraConnectorSchema = z.strictObject({
  connectorId: z.string().trim().min(1),
  vars: z
    .record(z.string(), z.strictObject({ secret: secretNameSchema }))
    .default({}),
});

export type ExtraConnectorInput = z.input<typeof extraConnectorSchema>;

/** What a person chooses about a new Task's environment. */
export const taskEnvironmentInputSchema = z.strictObject({
  /** A named environment to run in instead of the step's own or the repo default. */
  name: environmentNameSchema.optional(),
  extraConnectors: z.array(extraConnectorSchema).optional(),
});

export type TaskEnvironmentInput = z.input<typeof taskEnvironmentInputSchema>;

/** A Task's stored selection as the API returns it; `null` when it adds no connectors. */
export const taskEnvironmentSelectionSchema = z.object({
  extraConnectors: z.array(extraConnectorSchema),
});

/**
 * Read-side schemas for `tasks.environment_selection_json`, one per
 * `schemaVersion`. Structural only, so tightening a write rule never makes a
 * stored row unreadable. A breaking change adds a new version and a
 * `vN → vN+1` converter.
 */
const storedTaskEnvironmentSelectionV1Schema = z.object({
  schemaVersion: z.literal(1),
  extraConnectors: z.array(
    z.object({
      connectorId: z.string(),
      vars: z.record(z.string(), z.object({ secret: z.string() })),
    }),
  ),
});

export const CURRENT_TASK_ENVIRONMENT_SELECTION_SCHEMA_VERSION = 1;

const storedTaskEnvironmentSelectionSchema = z.discriminatedUnion(
  "schemaVersion",
  [storedTaskEnvironmentSelectionV1Schema],
);

export type ReadStoredTaskEnvironmentSelectionResult =
  | { success: true; selection: TaskEnvironmentSelection | null }
  | { success: false; reason: string };

/** Reads a stored selection; `null` (no extras) reads as `null`. */
export const readStoredTaskEnvironmentSelection = (
  // eslint-disable-next-line local/no-unknown-parameter-type -- a jsonb column has no static shape
  stored: unknown,
): ReadStoredTaskEnvironmentSelectionResult => {
  if (stored === null || stored === undefined) {
    return { success: true, selection: null };
  }
  const parsed = storedTaskEnvironmentSelectionSchema.safeParse(stored);
  return parsed.success
    ? {
        success: true,
        selection: { extraConnectors: parsed.data.extraConnectors },
      }
    : { success: false, reason: z.prettifyError(parsed.error) };
};

/** The stored JSON of a selection at the current schema version. */
export const toStoredTaskEnvironmentSelection = (
  selection: TaskEnvironmentSelection | null,
) =>
  selection === null
    ? null
    : {
        schemaVersion: CURRENT_TASK_ENVIRONMENT_SELECTION_SCHEMA_VERSION,
        extraConnectors: selection.extraConnectors,
      };
