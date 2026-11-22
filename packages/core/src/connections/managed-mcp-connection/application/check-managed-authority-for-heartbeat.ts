import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { TaskRunEntity } from "@scarn/core/tasks/task-run/domain/task-run-entity";
import type { ManagedAuthorityLossReason } from "../domain/managed-launch-connection-entity";
import { decideSealAuthority } from "../domain/managed-seal-authority";
import {
  readManagedAuthorityChecks,
  type ReadManagedAuthorityChecksDeps,
} from "./read-managed-authority-checks";

export type ManagedAuthorityStatus =
  | "ok"
  | { lost: ManagedAuthorityLossReason };

/**
 * The heartbeat's fast path of the authority fence (decision 3): the seal's
 * pinned-authority check without the operation rules, so an idle run learns
 * of a loss at its next heartbeat. A pending refresh is `ok` here; only the
 * seal waits on it. Records no event: the seal fence records the loss when
 * it fails the run.
 */
export const checkManagedAuthorityForHeartbeat = async (
  run: Pick<TaskRunEntity, "id" | "projectId">,
  now: Date,
  deps: ReadManagedAuthorityChecksDeps,
  tx: DbExecutor,
): Promise<ManagedAuthorityStatus> => {
  const checks = await readManagedAuthorityChecks(run, deps, tx);
  if (checks.length === 0) {
    return "ok";
  }
  const decision = decideSealAuthority(checks, [], now);
  return decision.kind === "lost" && decision.losses[0]
    ? { lost: decision.losses[0].reason }
    : "ok";
};
