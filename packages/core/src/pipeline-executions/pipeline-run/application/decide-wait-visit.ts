import { CoreValidationError } from "@scarn/core/lib/errors";
import type { Result } from "@scarn/core/lib/result";
import {
  decideWaitVisitInputSchema,
  type DecideWaitVisitInput,
  type PipelineExecutionContract,
} from "../contracts/pipeline-run-contracts";
import type { Ignored } from "../domain/engine/types";
import type { AdvanceError } from "./advance-pipeline-run";
import {
  commandPipelineRun,
  fixedEvent,
  type PipelineRunCommandDeps,
} from "./command-pipeline-run";

/** The body as stored: trimmed, with an empty or missing body as null. */
const normaliseBody = (body: string | null | undefined): string | null => {
  const trimmed = body?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
};

const rejectionOf = (ignored: Ignored): CoreValidationError =>
  ignored.kind === "invalid_decision"
    ? new CoreValidationError(
        `The decision isn't valid: ${ignored.message}`,
        "PIPELINE_RUN_DECISION_INVALID",
      )
    : new CoreValidationError(
        `The visit can't be decided: ${ignored.message}`,
        "PIPELINE_RUN_VISIT_NOT_WAITING",
      );

/**
 * Records a decision on a waiting decision visit. The wait's result becomes
 * `{ action, body }` and the run continues from it.
 */
export const decideWaitVisit = async (
  input: DecideWaitVisitInput,
  deps: PipelineRunCommandDeps,
): Promise<Result<PipelineExecutionContract, AdvanceError>> => {
  const parsed = decideWaitVisitInputSchema.parse(input);
  const outcome = await commandPipelineRun(
    parsed.pipelineExecutionId,
    {
      event: fixedEvent({
        type: "decision_made",
        visitId: parsed.visitId,
        action: parsed.action,
        body: normaliseBody(parsed.body),
        userId: deps.userAuthz.actorId,
      }),
      verify: (advanced) =>
        advanced.ignored === null ? null : rejectionOf(advanced.ignored),
    },
    deps,
  );
  return outcome.ok
    ? { ok: true, value: outcome.value.pipelineExecution }
    : outcome;
};
