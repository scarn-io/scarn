import type { AnyJsonValue } from "@scarn/core/common/contracts/json";
import type { AppendLogLineInput } from "@scarn/core/tasks/task-log/contracts/task-log-contracts";
import {
  failedLogLines,
  succeededLogLines,
} from "./seed-demo-execution-log-templates";

/**
 * The fabricated content one demo task is completed with: the log
 * burst appended to its feed, plus the result payload
 * `completeClaimedTaskRun` records.
 *
 * Log burst and result payload live together on purpose — a step's transcript
 * and the findings it claims have to agree.
 */
export type DemoFabricatedStepContent = {
  logLines: AppendLogLineInput[];
  resultJson: AnyJsonValue;
  errorJson: AnyJsonValue | null;
};

/**
 * The generic "reproduced it and wrote up a root cause" content used by every
 * succeeded step — i.e. the single step of `feature_qa`/`security_review`.
 */
const genericSucceededStepContent = (
  stepTitle: string,
  now: Date,
  withToolEvents: boolean,
): DemoFabricatedStepContent => ({
  logLines: succeededLogLines(stepTitle, now, withToolEvents),
  resultJson: {
    outcome: "reproduced",
    summaryOfFindings: `Reproduced "${stepTitle}" and identified a root cause.`,
  },
  errorJson: null,
});

/**
 * A succeeded step's fabricated content. Every fixture step gets the same
 * generic content today; `stepKey` is threaded through anyway so a future
 * step needing its own bespoke narrative has an obvious place to dispatch on.
 */
export const fabricatedSucceededStepContent = (input: {
  stepKey: string;
  stepTitle: string;
  now: Date;
  withToolEvents: boolean;
}): DemoFabricatedStepContent =>
  genericSucceededStepContent(input.stepTitle, input.now, input.withToolEvents);

/**
 * A failed step's content. Not keyed by step: a failed step with no `catch`
 * fails its whole run, so the `failed` fixtures only ever reach their
 * pipeline's first step.
 */
export const fabricatedFailedStepContent = (input: {
  stepTitle: string;
  now: Date;
  withToolEvents: boolean;
}): DemoFabricatedStepContent => ({
  logLines: failedLogLines(input.stepTitle, input.now, input.withToolEvents),
  resultJson: {
    outcome: "agent_error",
    summary: `Could not reproduce "${input.stepTitle}" — the workspace never became ready.`,
  },
  errorJson: {
    message: "Dev server did not become ready within the configured timeout.",
    code: "HEALTH_CHECK_TIMEOUT",
  },
});
