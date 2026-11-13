import type {
  AnyJsonObject,
  AnyJsonValue,
} from "../../../common/contracts/json";
import type { OpencodeServerHandle } from "../../../runtime/runtime-service/infra/opencode-server-contract";

/** Drives the agent session of a claimed task run. */
export type TaskAgentRunner = {
  promptAsync(input: {
    /**
     * The running server, including the workspace folder the agent operates
     * against (used as the OpenCode client `directory`).
     */
    server: OpencodeServerHandle;
    sessionTitle: string;
    promptText: string;
    agent: string;
    /**
     * Invoked as soon as the OpenCode session exists, but before the prompt
     * text is submitted to it. The caller uses this to attach its
     * conversation-event SSE subscription (`attachConversationStream`) ahead
     * of the prompt submission — OpenCode broadcasts the initial user
     * message's `message.part.updated` event exactly once, synchronously as
     * part of handling the prompt request, so a subscriber that attaches
     * only after `promptAsync` resolves permanently misses it. Awaited before
     * the prompt is sent, so the subscription is guaranteed live first.
     */
    onSessionCreated?: (input: { sessionId: string }) => void | Promise<void>;
  }): Promise<{
    sessionId: string;
  }>;
  getSessionStatus(input: {
    server: OpencodeServerHandle;
    sessionId: string;
  }): Promise<{
    running: boolean;
    /**
     * Present when opencode reports the session is retrying an upstream AI
     * request (e.g. an OpenAI `server_error`). Surfaced so the monitor can log
     * provider failures distinctly instead of burying them in the raw status.
     */
    providerError?:
      | {
          attempt: number;
          message: string;
        }
      | undefined;
  }>;
  sendRetryPrompt(input: {
    server: OpencodeServerHandle;
    sessionId: string;
    promptText: string;
    agent: string;
  }): Promise<void>;
  /** Stops whatever the session is doing; used when the run is aborted. */
  abort(input: {
    server: OpencodeServerHandle;
    sessionId: string;
  }): Promise<void>;
  /**
   * How the session's latest turn ended. `text` is the latest assistant
   * message's text, trimmed; empty when it has none. It is the message handed
   * to the person when the agent ends its turn, and the summary when a
   * conversation step ends. `error` describes why the turn failed (e.g. the
   * provider rejected the model); absent when it did not. Optional so runners
   * that never hand over can omit it; a runner without it reads as an empty,
   * successful turn.
   */
  readLastTurn?(input: {
    server: OpencodeServerHandle;
    sessionId: string;
  }): Promise<AgentTurn>;
  /**
   * The session's full export (`sanitize: false`), saved when the agent
   * yields so the Task that answers can restore it. Optional like
   * {@link readLastTurn}; without it a yield saves no session.
   */
  exportSession?(input: {
    server: OpencodeServerHandle;
    sessionId: string;
  }): Promise<ExportedAgentSession>;
  /**
   * Imports an exported session into this server at the handle's workspace,
   * calls `onSessionCreated` with the imported id (see
   * {@link TaskAgentRunner.promptAsync}), then sends `promptText` into it.
   * A failed import resolves `{ restored: false }` so the caller can fall
   * back to a fresh session; a failure after the import throws. Optional;
   * without it every run starts a fresh session.
   */
  restoreAndPrompt?(input: {
    server: OpencodeServerHandle;
    exported: ExportedAgentSession;
    promptText: string;
    onSessionCreated?: (input: { sessionId: string }) => void | Promise<void>;
  }): Promise<
    { restored: true; sessionId: string } | { restored: false; reason: string }
  >;
};

/** How an agent's latest turn ended; see {@link TaskAgentRunner.readLastTurn}. */
export type AgentTurn = {
  text: string;
  error?: string;
};

/**
 * An OpenCode session export (`session.export`): the session info and its
 * messages, opaque to the worker apart from `info.location.directory`.
 */
export type ExportedAgentSession = {
  info: AnyJsonObject;
  messages: AnyJsonValue[];
};
