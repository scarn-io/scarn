/**
 * Restores the previous Task's agent session into this run's OpenCode server
 * when the Task answers the question that Task asked: downloads the export,
 * imports it at the new workspace and sends the person's reply into it. Any
 * failure resolves `{ restored: false, reason }` before a session exists, so
 * the caller can start a fresh one from the step prompt instead.
 */
import type {
  ExportedAgentSession,
  OpencodeServerHandle,
  TaskAgentRunner,
} from "../contracts/process-project-work-types";
import type { RestoreSessionContract } from "../contracts/task-run-contracts";

export type RestoreAgentSessionResult =
  { restored: true; sessionId: string } | { restored: false; reason: string };

/**
 * The message sent into the restored session. The agent's earlier tool calls
 * name paths under the old workspace, so it is told when that moved.
 */
export function buildRestoredPromptText(input: {
  message: string;
  exportedDirectory: string | null;
  workspaceFolder: string;
}): string {
  if (
    input.exportedDirectory === null ||
    input.exportedDirectory === input.workspaceFolder
  ) {
    return input.message;
  }
  return (
    `Your workspace moved from \`${input.exportedDirectory}\` to ` +
    `\`${input.workspaceFolder}\`; the files are the same as when you asked.\n\n` +
    input.message
  );
}

function readExportedDirectory(exported: ExportedAgentSession): string | null {
  const location = exported.info["location"];
  if (location === null || typeof location !== "object") return null;
  if (Array.isArray(location)) return null;
  const directory = location["directory"];
  return typeof directory === "string" ? directory : null;
}

function parseExport(text: string): ExportedAgentSession {
  const parsed = JSON.parse(text) as {
    info?: unknown;
    messages?: unknown;
  } | null;
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    typeof parsed.info !== "object" ||
    parsed.info === null ||
    Array.isArray(parsed.info) ||
    !Array.isArray(parsed.messages)
  ) {
    throw new Error("the saved session is not an OpenCode session export");
  }
  return parsed as ExportedAgentSession;
}

async function downloadExport(
  downloadUrl: string,
  fetchImpl: typeof fetch,
): Promise<ExportedAgentSession> {
  const response = await fetchImpl(downloadUrl);
  if (!response.ok) {
    throw new Error(
      `downloading the saved session failed (${String(response.status)} ${response.statusText})`,
    );
  }
  return parseExport(await response.text());
}

export async function restoreAgentSession(input: {
  agentRunner: TaskAgentRunner;
  server: OpencodeServerHandle;
  restoreSession: RestoreSessionContract;
  onSessionCreated: (input: { sessionId: string }) => void | Promise<void>;
  fetchImpl?: typeof fetch | undefined;
}): Promise<RestoreAgentSessionResult> {
  const { agentRunner } = input;
  if (!agentRunner.restoreAndPrompt) {
    return {
      restored: false,
      reason: "this agent runner cannot restore sessions",
    };
  }
  let exported: ExportedAgentSession;
  try {
    exported = await downloadExport(
      input.restoreSession.downloadUrl,
      input.fetchImpl ?? fetch,
    );
  } catch (error) {
    return {
      restored: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  const promptText = buildRestoredPromptText({
    message: input.restoreSession.message,
    exportedDirectory: readExportedDirectory(exported),
    workspaceFolder: input.server.workspaceFolder,
  });
  const result = await agentRunner.restoreAndPrompt({
    server: input.server,
    exported,
    promptText,
    onSessionCreated: input.onSessionCreated,
  });
  return result.restored
    ? result
    : {
        restored: false,
        reason: `importing the saved session failed: ${result.reason}`,
      };
}
