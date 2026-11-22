import { CoreError } from "@scarn/core/lib/errors";

/**
 * A description write named a `descriptionVersion` the stored item has moved
 * past: someone wrote the description since the writer read it (409).
 */
export class WorkItemDescriptionConflict extends CoreError {
  constructor(workItemId: string, expectedVersion: number) {
    super({
      code: "WORK_ITEM_DESCRIPTION_CONFLICT",
      message: `Work item ${workItemId} description changed since version ${String(expectedVersion)}; read it again`,
      status: 409,
      meta: { workItemId, expectedVersion },
    });
  }
}
