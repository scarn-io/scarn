/**
 * Saves a yielding Task's agent session so the Task that answers can restore
 * it: exports the OpenCode session, masks secrets in it like any other log
 * output, and uploads it to the presigned URL the API mints. Best-effort: a
 * failure is logged and resolves null, and the Task yields without a session
 * (the answer then starts a fresh session from the transcript).
 */
import type {
  OpencodeServerHandle,
  ProcessProjectWorkDeps,
  ProjectWorkLogger,
  StartedClaimedTask,
} from "../contracts/process-project-work-types";

const SESSION_CONTENT_TYPE = "application/json";

export async function saveAgentSession(input: {
  deps: ProcessProjectWorkDeps;
  startedTask: StartedClaimedTask;
  server: OpencodeServerHandle;
  agentSessionId: string;
  mask(text: string): string;
  logger: ProjectWorkLogger;
  fetchImpl?: typeof fetch | undefined;
}): Promise<string | null> {
  const { deps, startedTask, logger } = input;
  const exportSession = deps.agentRunner.exportSession?.bind(deps.agentRunner);
  if (!exportSession) return null;
  try {
    const exported = await exportSession({
      server: input.server,
      sessionId: input.agentSessionId,
    });
    const masked = input.mask(JSON.stringify(exported));
    JSON.parse(masked);
    const body = new TextEncoder().encode(masked);

    const { uploadUrl, objectKey } =
      await deps.workerClient.createSessionUploadUrl({
        taskRunId: startedTask.taskRunId,
        claimToken: startedTask.claimToken,
        sizeBytes: body.byteLength,
      });
    const response = await (input.fetchImpl ?? fetch)(uploadUrl, {
      method: "PUT",
      body,
      headers: { "content-type": SESSION_CONTENT_TYPE },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `upload failed (${String(response.status)} ${response.statusText}): ${text}`,
      );
    }
    logger.log("worker", "Saved the agent session", {
      taskRunId: startedTask.taskRunId,
      sizeBytes: body.byteLength,
    });
    return objectKey;
  } catch (error) {
    logger.error(
      "worker",
      "Could not save the agent session; yielding without it",
      {
        taskRunId: startedTask.taskRunId,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return null;
  }
}
