import { z } from "zod";
import type { AnyJsonValue } from "@scarn/core/common/contracts/json";
import { createTolerantReader } from "@scarn/core/lib/db/stored-json";

/**
 * Read-side schema for the JSON columns of `task_runs`: `result_json` and
 * `error_json`. Tolerant, not versioned: they hold opaque results and a loose
 * error; only pinned keys are read.
 *
 * - `result_json` is opaque JSON: whatever the worker reported.
 * - `error_json` is whatever the worker reported (the complete-run contract
 *   takes any JSON), or the `{ code, message, … }` this code writes when a
 *   run times out or is abandoned. The keys read from it are `name`,
 *   `message` and `cause` (`namedRunError`, which checks their types itself)
 *   and, in SQL, `error_json ->> 'message'` on a string or object
 *   (`task-message-sql.ts` `taskErrorMessageSql`). So any JSON reads; a
 *   key of an unexpected type is ignored where it is read, not here.
 *
 * The instruction columns a run joins from `tasks` are read by the `tasks`
 * reader (`readStoredTaskInstructions` in `task-stored.ts`).
 *
 * Structural only and frozen here. If code ever branches on more of these
 * columns than the keys above, promote `task_runs` to versioned. See
 * `docs/persistence/json-columns.md`.
 */
const storedTaskRunV1Schema = z.object({
  resultJson: z.json().nullable(),
  errorJson: z.json().nullable(),
});

/** A run's JSON columns, read into the current domain shapes. */
export type StoredTaskRunDocument = {
  resultJson: AnyJsonValue | null;
  errorJson: AnyJsonValue | null;
};

/** The JSON columns of a `task_runs` row. */
export type StoredTaskRunColumns = {
  resultJson: unknown;
  errorJson: unknown;
};

export const readStoredTaskRun = createTolerantReader<
  StoredTaskRunDocument,
  StoredTaskRunColumns
>(storedTaskRunV1Schema);
