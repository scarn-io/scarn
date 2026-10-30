import { afterEach, describe, expect, test, vi } from "bun:test";
import { runAgentStepBranch } from "../../../../src/work/task-run/application/process-claimed-task-run-agent-branch";
import type {
  ProcessProjectWorkDeps,
  TaskRuntimeEnvironment,
  TaskRunWorkerContext,
} from "../../../../src/work/task-run/contracts/process-project-work-types";
import { DefaultOpencodeStepRunner } from "../../../../src/work/task-run/infra/opencode-step-runner";
import { createWorkerContext } from "./helpers/claimed-task-fixtures";

const WORKSPACE_FOLDER = "/workspaces/repo";
const DOWNLOAD_URL = "https://objects.local/tasks/prev/session.json?sig=1";
const REPLY = "Reply from Alex: staging, please.";
const EXPORTED = {
  info: { id: "ses_prev", location: { directory: WORKSPACE_FOLDER } },
  messages: [{ id: "msg_1", type: "user" }],
};

const previousFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = previousFetch;
});

type Recorded = { method: string; path: string; body: unknown };

/**
 * A fake OpenCode server (and object store) behind `fetch`: serves the export
 * download and the session routes the runner calls, recording each request.
 */
function installFakeOpencode(options: {
  exported?: unknown;
  downloadStatus?: number;
  importFails?: boolean;
}): Recorded[] {
  const requests: Recorded[] = [];
  const json = (data: object, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json" },
    });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.href
          : input,
    );
    const method = (request?.method ?? init?.method ?? "GET").toUpperCase();
    const rawBody = request ? await request.text() : init?.body;
    const body =
      typeof rawBody === "string" && rawBody !== ""
        ? (JSON.parse(rawBody) as unknown)
        : undefined;
    requests.push({ method, path: url.pathname, body });

    if (url.href === DOWNLOAD_URL) {
      const status = options.downloadStatus ?? 200;
      return status === 200
        ? json(options.exported ?? EXPORTED)
        : new Response("gone", { status });
    }
    if (url.pathname === "/api/experimental/session/import") {
      return options.importFails
        ? json({ error: { message: "bad export" } }, 400)
        : json({ data: { id: "ses_imported" } });
    }
    if (url.pathname === "/api/session") {
      return json({ data: { id: "ses_fresh" } });
    }
    if (url.pathname.endsWith("/prompt")) {
      return json({ data: { id: "inbox-1" } });
    }
    throw new Error(`Unexpected request: ${method} ${url.pathname}`);
  }) as unknown as typeof fetch;
  return requests;
}

function environment(): TaskRuntimeEnvironment {
  return {
    workspacePath: "/tmp/ws",
    workspaceFolder: WORKSPACE_FOLDER,
    resolvedBranch: "main",
    workBranch: null,
    createdFromBranch: null,
    devcontainerConfigPath: "",
    runtimeContainerId: null,
    agent: {
      baseUrl: "http://127.0.0.1:4096",
      password: "pw",
      version: "0.0.0-test",
      logDirectory: "/tmp/logs",
    },
    aiImage: "",
    networkName: "",
    secretValues: [],
    cleanup: () => Promise.resolve(),
  };
}

async function runBranch(workerContext: TaskRunWorkerContext) {
  const logger = { debug: vi.fn(), log: vi.fn(), error: vi.fn() };
  const onSessionCreated = vi.fn();
  const result = await runAgentStepBranch({
    deps: {
      agentRunner: new DefaultOpencodeStepRunner(),
    } as unknown as ProcessProjectWorkDeps,
    logger,
    reporter: {
      startActivity: vi.fn(),
      info: vi.fn(),
      success: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      event: vi.fn(),
    },
    workerContext,
    environment: environment(),
    taskRunId: workerContext.task.id,
    localRuntimeSessionId: "local-1",
    stepArtifactsDir: "/tmp/ws/.scarn/step-artifacts",
    workerEnv: {},
    promptEnv: {},
    onSessionCreated,
  });
  return { result, logger, onSessionCreated };
}

function contextWithRestore(): TaskRunWorkerContext {
  return {
    ...createWorkerContext(),
    restoreSession: { downloadUrl: DOWNLOAD_URL, message: REPLY },
  };
}

const prompts = (requests: Recorded[]) =>
  requests.filter((request) => request.path.endsWith("/prompt"));

describe("runAgentStepBranch — restoring a saved session", () => {
  test("sends the reply into the imported session without resending the step prompt", async () => {
    const requests = installFakeOpencode({});

    const { result, onSessionCreated } = await runBranch(contextWithRestore());

    expect(result).toEqual({
      sessionId: "ses_imported",
      sessionRestored: true,
    });
    expect(requests.find((r) => r.path.endsWith("/import"))?.body).toEqual({
      ...EXPORTED,
      location: { directory: WORKSPACE_FOLDER },
    });
    expect(requests.some((r) => r.path === "/api/session")).toBe(false);
    expect(prompts(requests)).toEqual([
      {
        method: "POST",
        path: "/api/session/ses_imported/prompt",
        body: { text: REPLY },
      },
    ]);
    expect(onSessionCreated).toHaveBeenCalledWith(
      "ses_imported",
      expect.objectContaining({ workspaceFolder: WORKSPACE_FOLDER }),
    );
  });

  test("tells the agent its workspace moved when the export's directory differs", async () => {
    const requests = installFakeOpencode({
      exported: {
        ...EXPORTED,
        info: { id: "ses_prev", location: { directory: "/workspaces/old" } },
      },
    });

    await runBranch(contextWithRestore());

    expect(prompts(requests)[0]?.body).toEqual({
      text:
        "Your workspace moved from `/workspaces/old` to `/workspaces/repo`; " +
        `the files are the same as when you asked.\n\n${REPLY}`,
    });
  });

  test("falls back to the step prompt when the import fails", async () => {
    const requests = installFakeOpencode({ importFails: true });

    const { result, logger } = await runBranch(contextWithRestore());

    expect(result).toEqual({ sessionId: "ses_fresh", sessionRestored: false });
    expect(prompts(requests)).toEqual([
      {
        method: "POST",
        path: "/api/session/ses_fresh/prompt",
        body: { text: expect.stringContaining("Header\nOpen ") as string },
      },
    ]);
    expect(logger.log).toHaveBeenCalledWith(
      "step",
      expect.stringContaining("Could not restore the agent session"),
      expect.objectContaining({
        reason: expect.stringContaining(
          "importing the saved session failed",
        ) as string,
      }),
    );
  });

  test("falls back to the step prompt when the download fails", async () => {
    const requests = installFakeOpencode({ downloadStatus: 404 });

    const { result } = await runBranch(contextWithRestore());

    expect(result).toEqual({ sessionId: "ses_fresh", sessionRestored: false });
    expect(requests.some((r) => r.path.endsWith("/import"))).toBe(false);
  });

  test("reports nothing to restore when the context has no saved session", async () => {
    const requests = installFakeOpencode({});

    const { result } = await runBranch({
      ...createWorkerContext(),
      restoreSession: null,
    });

    expect(result).toEqual({ sessionId: "ses_fresh", sessionRestored: null });
    expect(requests.map((r) => r.path)).toEqual([
      "/api/session",
      "/api/session/ses_fresh/prompt",
    ]);
  });
});
