import type { GrantRequest } from "@scarn/sdk/contracts/grant-request";
import type { WorkItemChange } from "@scarn/sdk/contracts/work-item-changes";
import type { UuidV7 } from "../../../common/contracts/uuid-v7";

/** What the worker sends when it parks a Task as yielded. */
export type YieldTaskRunInput = {
  taskRunId: UuidV7;
  claimToken: string;
  workBranch: string | null;
  createdFromBranch: string | null;
  sessionObjectKey: string | null;
  sessionSizeBytes: number | null;
  sessionRestored: boolean | null;
  message: string;
  /** What the agent asked for with `scarn-request-access`, if anything. */
  grantRequest?: GrantRequest | undefined;
  /** Changes recorded so far; held and applied when the Task succeeds. */
  workItemChanges?: WorkItemChange[] | undefined;
};
