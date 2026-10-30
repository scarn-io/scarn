import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Info as ToolInfo } from "@opencode/plugin/promise/tool";
import { loadCurrentExecutionInfo } from "./_shared/current-execution";
import { resolveWorktree } from "./_shared/resolve-worktree";

export const SCARN_END_CONVERSATION_TOOL = "scarn-end-conversation";

export const END_CONVERSATION_RELATIVE_PATH = ".scarn/end-conversation.json";

export const END_CONVERSATION_REFUSED_MESSAGE =
  "This step ends with findings; call `scarn-submit-step-findings`.";

export const END_CONVERSATION_ACCEPTED_MESSAGE =
  "End your turn now with your closing message.";

/**
 * Records that the agent wants to end a conversation step, by writing
 * {@link END_CONVERSATION_RELATIVE_PATH}. The closing message is the agent's
 * final message, which the worker reads once the turn ends. Refuses (without
 * writing anything) when the step has a result schema, since such a step ends
 * with findings instead.
 */
export async function endConversation(directory: string): Promise<string> {
  const worktree = await resolveWorktree(directory);
  const { resultSchemaJson } = await loadCurrentExecutionInfo(worktree);
  if (resultSchemaJson !== null) {
    return END_CONVERSATION_REFUSED_MESSAGE;
  }

  const filePath = path.join(worktree, END_CONVERSATION_RELATIVE_PATH);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `${JSON.stringify({ endedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
  return END_CONVERSATION_ACCEPTED_MESSAGE;
}

/** The `scarn-end-conversation` tool, bound to the plugin's directory. */
export function createScarnEndConversationTool(directory: string): ToolInfo {
  return {
    name: SCARN_END_CONVERSATION_TOOL,
    description:
      "End this conversation once it has reached its goal. Call this, then end your turn with a closing message. Only for conversation steps; a step with findings ends with scarn-submit-step-findings.",
    input: { type: "object", properties: {} },
    options: { codemode: false },
    execute: async () => ({ content: await endConversation(directory) }),
  };
}
