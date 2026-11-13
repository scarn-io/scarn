import { toOpencodeServerHandle } from "../../../runtime/runtime-service/infra/opencode-server-contract";
import type {
  ProcessProjectWorkDeps,
  ProjectWorkLogger,
  StartedClaimedTask,
} from "../contracts/process-project-work-types";

/**
 * Stops the agent session of an aborted run, so the agent stops working
 * before its runtime is torn down. Does nothing when the run was not aborted
 * or has no agent session. Best-effort: a failure is logged, not thrown.
 */
export async function abortAgentSessionIfRunAborted(
  deps: Pick<ProcessProjectWorkDeps, "agentRunner">,
  startedTask: StartedClaimedTask,
  logger: ProjectWorkLogger,
): Promise<void> {
  const agent = startedTask.environment.agent;
  const sessionId = startedTask.agentSessionId;
  if (!startedTask.run?.signal.aborted || !agent || !sessionId) return;

  logger.log("worker", "Aborting agent session for stopped run", {
    taskRunId: startedTask.taskRunId,
    agentSessionId: sessionId,
    reason: startedTask.run.abortReason(),
  });
  try {
    await deps.agentRunner.abort({
      server: toOpencodeServerHandle(
        agent,
        startedTask.environment.workspaceFolder,
      ),
      sessionId,
    });
  } catch (error) {
    logger.error("worker", "Failed to abort agent session", {
      taskRunId: startedTask.taskRunId,
      agentSessionId: sessionId,
      error,
    });
  }
}
