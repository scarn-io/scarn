/**
 * Prompt markers that script how `FakeAiServer` ends a turn, the way a real
 * agent would in a conversation:
 *   - {@link buildForcedEndTurnPrompt}: end the turn straight away with the
 *     given text as the final message, calling no tool (the message the
 *     worker hands over to the person).
 *   - {@link buildForcedEndConversationPrompt}: force a
 *     `scarn-end-conversation` call, then end the turn with the given text
 *     (the closing message).
 *
 * The tool is forced through the regular forced-tool-call marker. The final
 * text has its own marker because it is needed on the NEXT request, whose
 * last user message is the `tool_result`, not the prompt: it is read from the
 * latest user message that carries one.
 */
import { currentTurn, currentTurnHasToolResult } from "./current-turn";
import {
  buildForcedToolCallPrompt,
  extractMessageText,
  type MarkerCarryingMessage,
} from "./forced-tool-call-marker";

export const SCARN_END_CONVERSATION_TOOL = "scarn-end-conversation";

const FINAL_TEXT_MARKER_START = "<<scarn-fake-final-text>>";
const FINAL_TEXT_MARKER_END = "<</scarn-fake-final-text>>";

/** How the current turn's prompt asked the fake agent to end its turn. */
export type ForcedTurnEnd = {
  finalText: string;
  /** End on the first request instead of after a forced tool call. */
  withoutToolCall: boolean;
};

function buildFinalTextMarker(payload: ForcedTurnEnd): string {
  return `${FINAL_TEXT_MARKER_START}${JSON.stringify(payload)}${FINAL_TEXT_MARKER_END}`;
}

/** Prompt text that makes the fake agent end its turn with `finalText`, calling no tool. */
export function buildForcedEndTurnPrompt(finalText: string): string {
  return buildFinalTextMarker({ finalText, withoutToolCall: true });
}

/** Prompt text that makes the fake agent call `scarn-end-conversation`, then say `finalText`. */
export function buildForcedEndConversationPrompt(finalText: string): string {
  return `${buildForcedToolCallPrompt(SCARN_END_CONVERSATION_TOOL, {})} ${buildFinalTextMarker({ finalText, withoutToolCall: false })}`;
}

function parseTurnEnd(text: string): ForcedTurnEnd | undefined {
  const start = text.indexOf(FINAL_TEXT_MARKER_START);
  const end = text.indexOf(FINAL_TEXT_MARKER_END);
  if (start === -1 || end === -1 || end <= start) return undefined;
  try {
    const payload = JSON.parse(
      text.slice(start + FINAL_TEXT_MARKER_START.length, end),
    ) as { finalText?: unknown; withoutToolCall?: unknown };
    if (typeof payload.finalText !== "string") return undefined;
    return {
      finalText: payload.finalText,
      withoutToolCall: payload.withoutToolCall === true,
    };
  } catch {
    return undefined;
  }
}

/**
 * The turn end from the latest user message carrying a final-text marker, or
 * `undefined` when none does.
 */
export function parseForcedTurnEndFromMessages(
  messages: MarkerCarryingMessage[],
): ForcedTurnEnd | undefined {
  for (const message of [...messages].reverse()) {
    if (message.role !== "user") continue;
    const turnEnd = parseTurnEnd(extractMessageText(message.content));
    if (turnEnd !== undefined) return turnEnd;
  }
  return undefined;
}

/**
 * The final text the current turn ends with (its marker's, or
 * `defaultFinalText`), and whether this request ends the turn: once the turn
 * holds a `tool_result`, or straight away for an end-turn marker.
 */
export function resolveTurnEnd(
  messages: MarkerCarryingMessage[],
  defaultFinalText: string,
): { finalText: string; endsTurn: boolean } {
  const turnEnd = parseForcedTurnEndFromMessages(currentTurn(messages));
  return {
    finalText: turnEnd?.finalText ?? defaultFinalText,
    endsTurn:
      turnEnd?.withoutToolCall === true || currentTurnHasToolResult(messages),
  };
}
