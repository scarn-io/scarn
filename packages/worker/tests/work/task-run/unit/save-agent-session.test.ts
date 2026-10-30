import { describe, expect, test, vi } from "bun:test";
import { parseUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import { saveAgentSession } from "../../../../src/work/task-run/application/save-agent-session";
import type {
  ExportedAgentSession,
  ProcessProjectWorkDeps,
  StartedClaimedTask,
} from "../../../../src/work/task-run/contracts/process-project-work-types";

const TASK_ID = parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe003");
const SERVER = {
  baseUrl: "http://127.0.0.1:4096",
  password: "pw",
  workspaceFolder: "/workspaces/repo",
};
const EXPORTED: ExportedAgentSession = {
  info: { id: "ses_1", location: { directory: "/workspaces/repo" } },
  messages: [
    { type: "assistant", content: [{ type: "text", text: "token hunter2" }] },
  ],
};

function setup(options: {
  exportSession?: (() => Promise<ExportedAgentSession>) | null;
  uploadStatus?: number;
}) {
  const createSessionUploadUrl = vi.fn(() =>
    Promise.resolve({
      uploadUrl: "https://objects.local/put",
      objectKey: `tasks/${TASK_ID}/session.json`,
      expiresInSeconds: 900,
    }),
  );
  const fetchImpl = vi.fn<
    (url: string, init: RequestInit) => Promise<Response>
  >(() =>
    Promise.resolve(new Response("", { status: options.uploadStatus ?? 200 })),
  );
  const exportSession =
    options.exportSession === null
      ? undefined
      : vi.fn(options.exportSession ?? (() => Promise.resolve(EXPORTED)));
  const logger = { debug: vi.fn(), log: vi.fn(), error: vi.fn() };
  const run = () =>
    saveAgentSession({
      deps: {
        workerClient: { createSessionUploadUrl },
        agentRunner: { exportSession },
      } as unknown as ProcessProjectWorkDeps,
      startedTask: {
        taskRunId: TASK_ID,
        claimToken: "claim-token",
      } as StartedClaimedTask,
      server: SERVER,
      agentSessionId: "ses_1",
      mask: (text) => text.replaceAll("hunter2", "***"),
      logger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
  return { run, createSessionUploadUrl, fetchImpl, exportSession, logger };
}

describe("saveAgentSession", () => {
  test("uploads the masked export and returns its key", async () => {
    const harness = setup({});

    expect(await harness.run()).toBe(`tasks/${TASK_ID}/session.json`);

    const [url, init] = harness.fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://objects.local/put");
    expect(init?.method).toBe("PUT");
    const uploaded = new TextDecoder().decode(init?.body as Uint8Array);
    expect(uploaded).not.toContain("hunter2");
    expect(JSON.parse(uploaded)).toEqual({
      ...EXPORTED,
      messages: [
        { type: "assistant", content: [{ type: "text", text: "token ***" }] },
      ],
    });
    expect(harness.createSessionUploadUrl).toHaveBeenCalledWith({
      taskRunId: TASK_ID,
      claimToken: "claim-token",
      sizeBytes: Buffer.byteLength(uploaded),
    });
  });

  test("returns null without uploading when the export fails", async () => {
    const harness = setup({
      exportSession: () => Promise.reject(new Error("export broke")),
    });

    expect(await harness.run()).toBeNull();
    expect(harness.createSessionUploadUrl).not.toHaveBeenCalled();
    expect(harness.logger.error).toHaveBeenCalledWith(
      "worker",
      expect.stringContaining("Could not save the agent session"),
      expect.objectContaining({ error: "export broke" }),
    );
  });

  test("returns null when the upload is rejected", async () => {
    const harness = setup({ uploadStatus: 403 });

    expect(await harness.run()).toBeNull();
  });

  test("returns null when the runner cannot export", async () => {
    const harness = setup({ exportSession: null });

    expect(await harness.run()).toBeNull();
    expect(harness.createSessionUploadUrl).not.toHaveBeenCalled();
  });
});
