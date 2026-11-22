import {
  CoreValidationError,
  InvariantViolationError,
  ResourceNotFoundError,
} from "@scarn/core/lib/errors";
import { assertNever } from "@scarn/core/lib/assert-never";
import { Result } from "@scarn/core/lib/result";
import type { StepDefinitionKind } from "@scarn/core/pipeline-definitions/step-definition/domain/step-definition-entity";
import { taskMessageEntityToContract } from "@scarn/core/tasks/task-message/application/task-message-contract-mapper";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { EngineEvent } from "../domain/engine/types";
import {
  sendVisitMessageInputSchema,
  type SendVisitMessageInput,
  type SendVisitMessageResult,
} from "../contracts/pipeline-run-contracts";
import type { PipelineRunEntity } from "../domain/pipeline-run-entity";
import type { AdvanceError } from "./advance-pipeline-run";
import {
  commandPipelineRun,
  type PipelineRunCommandDeps,
} from "./command-pipeline-run";

/**
 * The step kinds that run no agent, and so have no one to read a message,
 * named for the rejection: a code step runs a function, an MCP tool step
 * makes one tool call.
 */
const messagelessStepLabel = (kind: StepDefinitionKind): string | null => {
  switch (kind) {
    case "built_in":
    case "user_defined":
      return null;
    case "code":
      return "code steps";
    case "mcp_tool":
      return "MCP tool steps";
    default:
      return assertNever(kind);
  }
};

const rejectMessagelessStep = async (
  run: PipelineRunEntity,
  visitId: string,
  deps: PipelineRunCommandDeps,
  tx: DbExecutor,
): Promise<AdvanceError | null> => {
  const history = await deps.pipelineRunRepo.loadHistory(run.id, tx);
  const visit = history.visits.find((item) => item.id === visitId);
  if (!visit || visit.nodeKind !== "step") {
    return null;
  }
  const version = await deps.pipelineGraphVersionRepo.load(
    run.pipelineGraphVersionId,
    tx,
  );
  if (!version) {
    return new ResourceNotFoundError(
      "Pipeline graph version",
      run.pipelineGraphVersionId,
    );
  }
  const node = version.definitionJson.nodes[visit.nodeId];
  const stepDefinitionId =
    node?.kind === "step" ? version.stepDefinitionIdFor(node.step) : null;
  const stepDefinition = stepDefinitionId
    ? await deps.stepDefinitionRepo.load(stepDefinitionId, tx)
    : null;
  const label = stepDefinition
    ? messagelessStepLabel(stepDefinition.kind)
    : null;
  return label
    ? new CoreValidationError(
        `Messages can't be sent to ${label}`,
        "PIPELINE_RUN_MESSAGE_CODE_STEP",
      )
    : null;
};

/**
 * Reruns a step visit with a user's message: the rerun visit's new Task
 * carries the message, in the same transaction as the rerun. Only step
 * visits of agent steps accept messages; code and MCP tool steps are
 * rejected with `PIPELINE_RUN_MESSAGE_CODE_STEP`.
 */
export const sendVisitMessage = async (
  input: SendVisitMessageInput,
  deps: PipelineRunCommandDeps,
): Promise<Result<SendVisitMessageResult, AdvanceError>> => {
  const parsed = sendVisitMessageInputSchema.parse(input);
  const outcome = await commandPipelineRun(
    parsed.pipelineExecutionId,
    {
      event: async (run, tx) => {
        const rejected = await rejectMessagelessStep(
          run,
          parsed.visitId,
          deps,
          tx,
        );
        if (rejected) {
          return Result.err(rejected);
        }
        const event: EngineEvent = {
          type: "rerun_from",
          visitId: parsed.visitId,
          userId: deps.userAuthz.actorId,
          message: parsed.body,
        };
        return Result.ok(event);
      },
      verify: (advanced) =>
        advanced.messages.length > 0
          ? null
          : new CoreValidationError(
              "The rerun didn't queue a Task to carry the message",
              "PIPELINE_RUN_MESSAGE_NOT_QUEUED",
            ),
      options: { messageQuoteText: parsed.quoteText ?? null },
    },
    deps,
  );
  if (!outcome.ok) {
    return outcome;
  }
  const [message] = outcome.value.advanced.messages;
  if (!message) {
    throw new InvariantViolationError(
      "A verified message rerun returned no message",
      "PIPELINE_RUN_MESSAGE_MISSING",
    );
  }
  return Result.ok({
    message: taskMessageEntityToContract(message),
    pipelineExecution: outcome.value.pipelineExecution,
  });
};
