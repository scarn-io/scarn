import { access, mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
  END_CONVERSATION_ACCEPTED_MESSAGE,
  END_CONVERSATION_REFUSED_MESSAGE,
  END_CONVERSATION_RELATIVE_PATH,
  endConversation,
} from "./scarn-end-conversation";

async function workspaceWith(
  resultSchemaJson: Record<string, unknown> | null,
): Promise<string> {
  const workspacePath = await mkdtemp(
    path.join(os.tmpdir(), "scarn-end-conversation-"),
  );
  await mkdir(path.join(workspacePath, ".scarn/current-execution"), {
    recursive: true,
  });
  await Bun.write(
    path.join(workspacePath, ".scarn/current-execution/execution.json"),
    JSON.stringify({
      taskRunId: "task-1",
      resultSchemaJson,
      turnsRemaining: 3,
    }),
  );
  return workspacePath;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("endConversation", () => {
  test.concurrent(
    "refuses without writing the marker when the step has a result schema",
    async () => {
      const workspacePath = await workspaceWith({ type: "object" });

      expect(await endConversation(workspacePath)).toBe(
        END_CONVERSATION_REFUSED_MESSAGE,
      );
      expect(
        await exists(path.join(workspacePath, END_CONVERSATION_RELATIVE_PATH)),
      ).toBe(false);
    },
  );

  test.concurrent(
    "writes the marker and tells the agent to end its turn on a conversation step",
    async () => {
      const workspacePath = await workspaceWith(null);

      expect(await endConversation(workspacePath)).toBe(
        END_CONVERSATION_ACCEPTED_MESSAGE,
      );
      const marker = JSON.parse(
        await readFile(
          path.join(workspacePath, END_CONVERSATION_RELATIVE_PATH),
          "utf8",
        ),
      ) as { endedAt?: unknown };
      expect(typeof marker.endedAt).toBe("string");
    },
  );
});
