import { afterEach, describe, expect, spyOn, test, vi } from "bun:test";
import { parseUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import { handOverAgentTask } from "../../../../src/work/task-run/application/process-project-work-yield";
import type {
  ProcessProjectWorkDeps,
  StartedClaimedTask,
} from "../../../../src/work/task-run/contracts/process-project-work-types";

const TASK_ID = parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe003");
const EXPORTED = {
  info: { id: "ses_1" },
  messages: [{ type: "assistant", content: [{ type: "text", text: "hi" }] }],
};

describe("handOverAgentTask", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("reports the saved session's key and uploaded size with the yield", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((() =>
      Promise.resolve(new Response("", { status: 200 }))) as unknown as typeof fetch);
    const yieldTaskRun = vi.fn(() => Promise.resolve());
    const deps = {
      workerClient: {
        createSessionUploadUrl: vi.fn(() =>
          Promise.resolve({
            uploadUrl: "https://objects.local/put",
            objectKey: `tasks/${TASK_ID}/session.json`,
            expiresInSeconds: 900,
          }),
        ),
        yieldTaskRun,
      },
      agentRunner: { exportSession: vi.fn(() => Promise.resolve(EXPORTED)) },
    } as unknown as ProcessProjectWorkDeps;
    const startedTask = {
      taskRunId: TASK_ID,
      claimToken: "claim-token",
      environment: {
        workBranch: "scarn/task-1",
        createdFromBranch: "main",
        commitAndPushWorkBranch: () => Promise.resolve({ pushed: true }),
      },
    } as unknown as StartedClaimedTask;

    await handOverAgentTask({
      deps,
      startedTask,
      server: {
        baseUrl: "http://127.0.0.1:4096",
        password: "pw",
        workspaceFolder: "/workspaces/repo",
      },
      agentSessionId: "ses_1",
      logStream: { flush: () => Promise.resolve(), mask: (text) => text },
      logger: { debug: vi.fn(), log: vi.fn(), error: vi.fn() },
      message: "Which env?",
    });

    const uploaded = fetchSpy.mock.calls[0]?.[1]?.body as Uint8Array;
    expect(yieldTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionObjectKey: `tasks/${TASK_ID}/session.json`,
        sessionSizeBytes: uploaded.byteLength,
      }),
    );
  });
});
