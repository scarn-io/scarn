/**
 * The monitor's yield paths. A hand-over: the agent ended its turn without
 * findings and the step has turns left, so its final message goes to a
 * person. A wait: the agent called `scarn-wait-for-work`, so the run waits on
 * its work item's blockers, carrying the work item changes its tools recorded
 * (the block on its own item among them); no message is posted. Either way
 * the work branch is committed and pushed, and the task is parked as yielded
 * along with the saved agent session (see `saveAgentSession`). No artifacts
 * are collected: the attempt has no result for them to belong to.
 */
import { readWorkItemChanges } from "@scarn/sdk/contracts/work-item-changes";
import { saveAgentSession } from "./save-agent-session";
import { removeWaitForWorkMarker } from "../contracts/wait-for-work-marker";
import type {
  OpencodeServerHandle,
  ProcessProjectWorkDeps,
  ProjectWorkLogger,
  StartedClaimedTask,
} from "../contracts/process-project-work-types";

type YieldInput = {
  deps: ProcessProjectWorkDeps;
  startedTask: StartedClaimedTask;
  server: OpencodeServerHandle;
  agentSessionId: string;
  logStream: { flush(): Promise<void>; mask(text: string): string };
  logger: ProjectWorkLogger;
};

/** Pushes the work branch and saves the session; the yield's shared fields. */
async function prepareYield(input: YieldInput, logMessage: string) {
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
  logger.log("worker", logMessage, { taskRunId: startedTask.taskRunId });
  await input.logStream.flush();
  return {
    taskRunId: startedTask.taskRunId,
    claimToken: startedTask.claimToken,
    workBranch:
      pushOutcome?.pushed === false ? null : startedTask.environment.workBranch,
    createdFromBranch: startedTask.environment.createdFromBranch,
    sessionObjectKey,
    sessionRestored: startedTask.sessionRestored ?? null,
  };
}

export async function handOverAgentTask(
  input: YieldInput & {
    /** The agent's final message, already masked. */
    message: string;
  },
): Promise<void> {
  const shared = await prepareYield(
    input,
    "Agent ended its turn; handing over to a person",
  );
  await input.deps.workerClient.yieldTaskRun({
    ...shared,
    message: input.message,
  });
}

export async function waitForWorkAgentTask(input: YieldInput): Promise<void> {
  const { workspacePath } = input.startedTask.environment;
  const shared = await prepareYield(
    input,
    "Agent ended its turn; waiting on its work item",
  );
  await input.deps.workerClient.yieldTaskRun({
    ...shared,
    kind: "wait_for_work",
    workItemChanges: await readWorkItemChanges(workspacePath),
  });
  await removeWaitForWorkMarker(workspacePath);
}
