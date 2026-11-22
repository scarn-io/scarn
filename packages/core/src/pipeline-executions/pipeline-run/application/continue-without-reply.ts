import { CoreValidationError } from "@scarn/core/lib/errors";
import type { Result } from "@scarn/core/lib/result";
import {
  continueWithoutReplyInputSchema,
  type ContinueWithoutReplyInput,
  type PipelineExecutionContract,
} from "../contracts/pipeline-run-contracts";
import type { AdvanceError } from "./advance-pipeline-run";
import {
  commandPipelineRun,
  fixedEvent,
  type PipelineRunCommandDeps,
} from "./command-pipeline-run";

/**
 * Resumes a visit waiting on an open question without a reply: the question
 * becomes answered with no answer comment and the run continues.
 */
export const continueWithoutReply = async (
  input: ContinueWithoutReplyInput,
  deps: PipelineRunCommandDeps,
): Promise<Result<PipelineExecutionContract, AdvanceError>> => {
  const parsed = continueWithoutReplyInputSchema.parse(input);
  const outcome = await commandPipelineRun(
    parsed.pipelineExecutionId,
    {
      event: fixedEvent({
        type: "question_answered",
        questionId: parsed.questionId,
        userId: deps.userAuthz.actorId,
        answer: null,
      }),
      verify: (advanced) =>
        advanced.ignored === null
          ? null
          : new CoreValidationError(
              `The question can't be continued: ${advanced.ignored.message}`,
              "PIPELINE_RUN_QUESTION_NOT_OPEN",
            ),
    },
    deps,
  );
  return outcome.ok
    ? { ok: true, value: outcome.value.pipelineExecution }
    : outcome;
};
