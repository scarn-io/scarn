import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import type { WorkItemSort } from "./work-item-contracts";

const SCORE_TOKEN_PATTERN = /^score:([^:]+):([^:]+):([^:]+):(asc|desc)$/;

/**
 * Parse the `sort` URL token into the structured contract shape. Shared
 * between the browser (which writes the token) and this route (which reads
 * it), so the two can never drift onto separate grammars — the mistake
 * already flagged for the `f.` prefix constant in
 * `docs/plans/work-item-filter-bar.md` Phase 6.
 *
 * Total, not throwing: an unrecognized or malformed token returns
 * `undefined` rather than rejecting the request, matching every other
 * clause's tolerance rule in this codebase (see
 * `project-work-items-query.ts`'s `parseTimeBound`).
 */
export const parseWorkItemSortToken = (
  raw: string | undefined,
): WorkItemSort | undefined => {
  if (raw === "created-desc") return { kind: "created", direction: "desc" };
  if (raw === "created-asc") return { kind: "created", direction: "asc" };
  if (raw === "updated-desc") return { kind: "updated", direction: "desc" };
  if (raw === "updated-asc") return { kind: "updated", direction: "asc" };

  const score = SCORE_TOKEN_PATTERN.exec(raw ?? "");
  if (!score) return undefined;

  const [, rawPipelineDefinitionId, stepKey, signalKey, direction] = score;
  if (!rawPipelineDefinitionId || !stepKey || !signalKey || !direction) {
    return undefined;
  }

  const pipelineDefinitionId = uuidV7Schema.safeParse(rawPipelineDefinitionId);
  return pipelineDefinitionId.success
    ? {
        kind: "score",
        pipelineDefinitionId: pipelineDefinitionId.data,
        stepKey,
        signalKey,
        direction: direction as "asc" | "desc",
      }
    : undefined;
};
