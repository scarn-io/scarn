/**
 * Which part of a conversation `FakeAiServer` answers. A restored session's
 * history already holds earlier turns' tool results, so only the current turn
 * (from the latest user prompt onward) decides whether to force a tool call
 * or end the turn.
 */
import type { MarkerCarryingMessage } from "./forced-tool-call-marker";

function carriesToolResult(message: MarkerCarryingMessage): boolean {
  return (
    Array.isArray(message.content) &&
    message.content.some((block) => block.type === "tool_result")
  );
}

/** The messages from the latest user message without a `tool_result` onward. */
export function currentTurn<T extends MarkerCarryingMessage>(
  messages: T[],
): T[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user" && !carriesToolResult(message)) {
      return messages.slice(index);
    }
  }
  return messages;
}

/** Whether the current turn already holds a `tool_result`. */
export function currentTurnHasToolResult(
  messages: MarkerCarryingMessage[],
): boolean {
  return currentTurn(messages).some(carriesToolResult);
}
