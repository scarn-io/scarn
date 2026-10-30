/**
 * The monitor's hand-over path: the agent ended its turn without findings and
 * the step has turns left, so its final message goes to a person. The work
 * branch is committed and pushed, and the task is parked as yielded with that
 * message, along with the saved agent session (see `saveAgentSession`). No
 * artifacts are collected: the attempt has no result for them to belong to.
 */
import { saveAgentSession } from "./save-agent-session";
import type {
  OpencodeServerHandle,
  ProcessProjectWorkDeps,
  ProjectWorkLogger,
  StartedClaimedTask,
} from "../contracts/process-project-work-types";

export async function handOverAgentTask(input: {
  deps: ProcessProjectWorkDeps;
  startedTask: StartedClaimedTask;
  server: OpencodeServerHandle;
  agentSessionId: string;
  /** The agent's final message, already masked. */
  message: string;
  logStream: { flush(): Promise<void>; mask(text: string): string };
  logger: ProjectWorkLogger;
}): Promise<void> {
  const { deps, startedTask, logger } = input;

  const pushOutcome = await startedTask.environment.commitAndPushWorkBranch?.({
    yielded: true,
  });
  const sessionObjectKey = await saveAgentSession({
    deps,
    startedTask,
    server: input.server,
    agentSessionId: input.agentSessionId,
    mask: (text) => input.logStream.mask(text),
    logger,
  });

  logger.log("worker", "Agent ended its turn; handing over to a person", {
    taskRunId: startedTask.taskRunId,
    messageLength: input.message.length,
  });
  await input.logStream.flush();

  await deps.workerClient.yieldTaskRun({
    taskRunId: startedTask.taskRunId,
    claimToken: startedTask.claimToken,
    message: input.message,
    workBranch:
      pushOutcome?.pushed === false ? null : startedTask.environment.workBranch,
    createdFromBranch: startedTask.environment.createdFromBranch,
    sessionObjectKey,
    sessionRestored: startedTask.sessionRestored ?? null,
  });
}
