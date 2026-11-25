import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import { findGrant } from "@scarn/core/tasks/task/domain/grants";
import type { WorkItemRepo } from "@scarn/core/work-items/work-item/application/work-item-repo";
import {
  getTaskRunInputSchema,
  type GetTaskRunInput,
} from "../contracts/task-run-contracts";
import {
  latestTaskRunSourceUpdateInputSchema,
  type LatestTaskRunSourceUpdateContract,
  type LatestTaskRunSourceUpdateInput,
} from "../contracts/task-run-work-item-contracts";
import {
  grantMissing,
  requireCodeStepWorkItemAccess,
  type CodeStepWorkItemAccessDeps,
} from "./code-step-work-item-access";

export type LatestTaskRunSourceUpdateDeps = CodeStepWorkItemAccessDeps & {
  workItemRepo: Pick<WorkItemRepo, "maxSourceUpdatedAt">;
  dbExecutor?: DbExecutor | undefined;
};

/**
 * A code step's import cursor: the newest `sourceUpdatedAt` among its
 * project's items on `platform` whose `platformKey` starts with `keyPrefix`,
 * null when there is none. A poller resumes from it, so a run that died
 * part-way picks up after the last page it wrote. Needs the step's `read`
 * grant on `project` and the claiming user's `work-items:read`.
 */
export const latestTaskRunSourceUpdate = async (
  taskRunIdInput: GetTaskRunInput,
  input: LatestTaskRunSourceUpdateInput,
  deps: LatestTaskRunSourceUpdateDeps,
): Promise<
  Result<LatestTaskRunSourceUpdateContract, ResourceNotFoundError>
> => {
  const taskRunId = getTaskRunInputSchema.parse(taskRunIdInput);
  const parsed = latestTaskRunSourceUpdateInputSchema.parse(input);
  const db = deps.dbExecutor ?? getDb();

  return await db.transaction(async (tx) => {
    const access = await requireCodeStepWorkItemAccess(
      taskRunId,
      parsed.claimToken,
      "work-items:read",
      deps,
      tx,
    );
    if (!access.ok) {
      return Result.err(access.error);
    }
    const { run, task } = access.value;
    if (!findGrant(task.grants, "read", "project")) {
      throw grantMissing(
        "This step may not read its project's work items: it has no read grant on project",
      );
    }
    const latest = await deps.workItemRepo.maxSourceUpdatedAt(
      run.projectId,
      parsed.platform,
      parsed.keyPrefix,
      tx,
    );
    return Result.ok({ sourceUpdatedAt: latest?.toISOString() ?? null });
  });
};
