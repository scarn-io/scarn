/**
 * What the monitor does when an agent's turn ends without findings.
 *
 * A step with a result schema owes findings; one without (a conversation
 * step) talks until it calls `scarn-end-conversation`, which writes
 * {@link buildEndConversationPath}. In order:
 *
 * 1. a Task whose agent called `scarn-wait-for-work` waits on its work item
 *    (the server fails it when it has no turns left);
 * 2. a conversation step with the end marker ends;
 * 3. with turns left and a non-empty final message, the turn is handed over;
 * 4. with no turns left in a run, the agent gets one more message saying so,
 *    and the decision waits for that turn to end;
 * 5. otherwise a conversation step ends, and a step with a schema takes the
 *    missing-findings path. A Task outside a run has no turns and never hands
 *    over.
 *
 * Ending completes the Task with `{ summary }`, the agent's final message.
 * No session is saved: nothing will restore it.
 */
import { TASK_AGENT } from "@scarn/opencode-plugin";
import { access, rm } from "node:fs/promises";
import path from "node:path";
import { readWorkItemChanges } from "@scarn/sdk/contracts/work-item-changes";
import type { AnyJsonValue } from "../../../common/contracts/json";
import type {
  CommitAndPushWorkBranchResult,
  OpencodeServerHandle,
  ProcessProjectWorkDeps,
  ProjectWorkLogger,
  StartedClaimedTask,
} from "../contracts/process-project-work-types";
import { tryReadCurrentExecutionInfo } from "./process-project-work-findings";
import { hasWaitForWorkMarker } from "../contracts/wait-for-work-marker";
import {
  handOverAgentTask,
  waitForWorkAgentTask,
} from "./process-project-work-yield";

const END_CONVERSATION_RELATIVE_PATH = ".scarn/end-conversation.json";

export const FINDINGS_LAST_TURN_PROMPT =
  "You can't hand the conversation back again in this step. Submit your findings with what's settled, and list what's still open.";

export const CONVERSATION_LAST_TURN_PROMPT =
  "This is the last turn. Call `scarn-end-conversation` now.";

export function buildEndConversationPath(workspacePath: string): string {
  return path.join(workspacePath, END_CONVERSATION_RELATIVE_PATH);
}

async function hasEndConversationMarker(
  workspacePath: string,
): Promise<boolean> {
  try {
    await access(buildEndConversationPath(workspacePath));
    return true;
  } catch {
    return false;
  }
}

/**
 * `lastTurnPrompted` is set once the no-turns-left message is sent;
 * `graceWaitedMs` is the poll sleep time since, which the monitor adds to
 * after every `continue`.
 */
export type TurnEndState = {
  lastTurnPrompted: boolean;
  graceWaitedMs: number;
};

export type TurnEndAction =
  | { kind: "hand-over"; message: string }
  | { kind: "wait-for-work" }
  | { kind: "end"; summary: string }
  | { kind: "continue" }
  | { kind: "missing-findings" };

type TurnEndInput = {
  deps: ProcessProjectWorkDeps;
  startedTask: StartedClaimedTask;
  server: OpencodeServerHandle;
  agentSessionId: string;
  state: TurnEndState;
  graceMs: number;
  mask: (text: string) => string;
  logger: ProjectWorkLogger;
};

type BeforeComplete = (ctx: {
  findingsJson: AnyJsonValue;
}) => Promise<CommitAndPushWorkBranchResult | undefined>;

export async function decideTurnEnd(
  input: TurnEndInput,
): Promise<TurnEndAction> {
  const { deps, startedTask, state, logger } = input;
  const { workspacePath } = startedTask.environment;
  const info = await tryReadCurrentExecutionInfo(workspacePath);
  const isConversation = info !== null && info.resultSchemaJson === null;
  const turnsRemaining = info?.turnsRemaining ?? null;
  const readFinalMessage = async () =>
    input.mask(
      (await deps.agentRunner.readLastAssistantText?.({
        server: input.server,
        sessionId: input.agentSessionId,
      })) ?? "",
    );

  if (await hasWaitForWorkMarker(workspacePath)) {
    return { kind: "wait-for-work" };
  }

  if (state.lastTurnPrompted) {
    if (state.graceWaitedMs < input.graceMs) return { kind: "continue" };
    return isConversation
      ? { kind: "end", summary: await readFinalMessage() }
      : { kind: "missing-findings" };
  }

  if (isConversation && (await hasEndConversationMarker(workspacePath))) {
    return { kind: "end", summary: await readFinalMessage() };
  }

  const finalMessage = await readFinalMessage();
  if (turnsRemaining !== null && turnsRemaining > 0 && finalMessage !== "") {
    return { kind: "hand-over", message: finalMessage };
  }

  if (turnsRemaining === 0) {
    logger.log(
      "worker",
      "Agent ended its turn with no turns left; telling it so",
      { taskRunId: startedTask.taskRunId, isConversation },
    );
    await deps.agentRunner.sendRetryPrompt({
      server: input.server,
      sessionId: input.agentSessionId,
      promptText: isConversation
        ? CONVERSATION_LAST_TURN_PROMPT
        : FINDINGS_LAST_TURN_PROMPT,
      agent: TASK_AGENT,
    });
    state.lastTurnPrompted = true;
    state.graceWaitedMs = 0;
    return { kind: "continue" };
  }

  return isConversation
    ? { kind: "end", summary: finalMessage }
    : { kind: "missing-findings" };
}

/**
 * Completes a conversation step with `{ summary }`. `onBeforeComplete` is the
 * monitor's commit-and-push and artifact collection, as for findings.
 */
export async function completeConversationTask(input: {
  deps: ProcessProjectWorkDeps;
  startedTask: StartedClaimedTask;
  summary: string;
  onBeforeComplete: BeforeComplete;
}): Promise<void> {
  const { deps, startedTask } = input;
  const resultJson = { summary: input.summary };
  const beforeComplete = await input.onBeforeComplete({
    findingsJson: resultJson,
  });

  await deps.workerClient.completeTaskRun({
    taskRunId: startedTask.taskRunId,
    claimToken: startedTask.claimToken,
    resultJson,
    errorJson: null,
    workBranch:
      beforeComplete?.pushed === false
        ? null
        : startedTask.environment.workBranch,
    createdFromBranch: startedTask.environment.createdFromBranch,
    sessionRestored: startedTask.sessionRestored ?? null,
    workItemChanges: await readWorkItemChanges(
      startedTask.environment.workspacePath,
    ),
  });

  await rm(buildEndConversationPath(startedTask.environment.workspacePath), {
    force: true,
  });
}

/**
 * Decides what an ended turn means ({@link decideTurnEnd}) and carries out a
 * hand-over or an end. `yielded` and `ended` mean the Task has left
 * `running`; the other outcomes are for the monitor to act on.
 */
export async function runTurnEnd(
  input: TurnEndInput & {
    logStream: { flush(): Promise<void>; mask(text: string): string };
    onBeforeComplete: BeforeComplete;
  },
): Promise<"yielded" | "ended" | "continue" | "missing-findings"> {
  const action = await decideTurnEnd(input);
  if (action.kind === "hand-over") {
    await handOverAgentTask({
      deps: input.deps,
      startedTask: input.startedTask,
      server: input.server,
      agentSessionId: input.agentSessionId,
      message: action.message,
      logStream: input.logStream,
      logger: input.logger,
    });
    return "yielded";
  }
  if (action.kind === "wait-for-work") {
    await waitForWorkAgentTask({
      deps: input.deps,
      startedTask: input.startedTask,
      server: input.server,
      agentSessionId: input.agentSessionId,
      logStream: input.logStream,
      logger: input.logger,
    });
    return "yielded";
  }
  if (action.kind === "end") {
    await completeConversationTask({
      deps: input.deps,
      startedTask: input.startedTask,
      summary: action.summary,
      onBeforeComplete: input.onBeforeComplete,
    });
    input.logger.log("worker", "Agent ended the conversation", {
      taskRunId: input.startedTask.taskRunId,
    });
    return "ended";
  }
  return action.kind;
}
