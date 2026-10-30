import type { UuidV7 } from "../../../common/contracts/uuid-v7";
import { buildTaskRunFailurePayload } from "./build-task-run-failure-payload";
import type {
  ProjectWorkLogger,
  TaskRunWorkerClient,
} from "../contracts/process-project-work-types";

type ClaimedTaskRunFailureInputError =
  | Error
  | { message?: string | undefined }
  | string
  | number
  | boolean
  | null
  | undefined;

function getFailureMessage(
  errorJson: { message?: string | undefined } | null | undefined,
) {
  if (errorJson && typeof errorJson === "object" && "message" in errorJson) {
    return String(errorJson.message);
  }

  return "unknown";
}

export async function failClaimedTaskRunIfStillRunning(
  client: TaskRunWorkerClient,
  logger: ProjectWorkLogger,
  input: {
    taskRunId: UuidV7;
    claimToken: string;
    error: ClaimedTaskRunFailureInputError;
  },
) {
  logger.log("step", "Checking claimed step status after failure", {
    taskRunId: input.taskRunId,
  });
  const task = await client.getTaskRun({
    taskRunId: input.taskRunId,
  });

  if (task.status !== "running") {
    logger.log(
      "step",
      "Claimed step already left running state after failure",
      {
        taskRunId: input.taskRunId,
        status: task.status,
      },
    );
    return task.status;
  }

  const failurePayload = buildTaskRunFailurePayload(input.error);
  logger.log("step", "Reporting claimed step failure", {
    taskRunId: input.taskRunId,
    code: failurePayload.errorJson.code,
    message: getFailureMessage(failurePayload.errorJson),
  });
  await client.failTaskRun({
    taskRunId: input.taskRunId,
    claimToken: input.claimToken,
    resultJson: failurePayload.resultJson,
    errorJson: failurePayload.errorJson,
  });

  logger.log("step", "Reported claimed step failure", {
    taskRunId: input.taskRunId,
    status: "failed",
  });
  return "failed";
}
