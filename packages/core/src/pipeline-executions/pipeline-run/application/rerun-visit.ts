import type { Result } from "@scarn/core/lib/result";
import {
  rerunVisitInputSchema,
  type PipelineExecutionContract,
  type RerunVisitInput,
} from "../contracts/pipeline-run-contracts";
import type { AdvanceError } from "./advance-pipeline-run";
import {
  commandPipelineRun,
  fixedEvent,
  type PipelineRunCommandDeps,
} from "./command-pipeline-run";

/**
 * Reruns from a visit: supersedes it and every visit after it, cancels their
 * Tasks and creates a fresh visit for the node. Other lanes keep running.
 */
export const rerunVisit = async (
  input: RerunVisitInput,
  deps: PipelineRunCommandDeps,
): Promise<Result<PipelineExecutionContract, AdvanceError>> => {
  const parsed = rerunVisitInputSchema.parse(input);
  const outcome = await commandPipelineRun(
    parsed.pipelineExecutionId,
    {
      event: fixedEvent({
        type: "rerun_from",
        visitId: parsed.visitId,
        userId: deps.userAuthz.actorId,
      }),
    },
    deps,
  );
  return outcome.ok
    ? { ok: true, value: outcome.value.pipelineExecution }
    : outcome;
};
