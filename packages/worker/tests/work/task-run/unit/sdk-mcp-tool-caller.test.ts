import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { McpToolCallInput } from "../../../../src/work/task-run/application/mcp-tool-caller";
import { SdkMcpToolCaller } from "../../../../src/work/task-run/infra/sdk-mcp-tool-caller";
import {
  FIXTURE_STRUCTURED_CONTENT,
  serveToolCallFixtureOverHttp,
} from "./fixtures/tool-call-mcp-server";

/**
 * Real round trips against the fixture MCP server, over stdio (a bun child
 * process) and Streamable HTTP (an in-process `Bun.serve`).
 */

const FIXTURE_SERVER_PATH = path.join(
  import.meta.dirname,
  "fixtures",
  "tool-call-mcp-server.ts",
);

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "scarn-mcp-caller-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function stdioInput(
  overrides: Partial<McpToolCallInput> & {
    environment?: Record<string, string>;
  },
): McpToolCallInput {
  const { environment, ...rest } = overrides;
  return {
    server: {
      type: "local",
      command: [process.execPath, "run", FIXTURE_SERVER_PATH],
      environment: {
        FIXTURE_CALLS_FILE: path.join(scratch, "calls"),
        FIXTURE_PID_FILE: path.join(scratch, "pid"),
        ...environment,
      },
    },
    placement: { kind: "host", workspaceDir: scratch },
    tool: "echo",
    args: { text: "hi" },
    env: hostEnv(),
    timeoutMs: 15_000,
    signal: new AbortController().signal,
    ...rest,
  };
}

function hostEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function recordedCalls(): string[] {
  const file = path.join(scratch, "calls");
  return existsSync(file)
    ? readFileSync(file, "utf8").split("\n").filter(Boolean)
    : [];
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await Bun.sleep(20);
  }
}

describe("SdkMcpToolCaller over stdio on the host", () => {
  const caller = new SdkMcpToolCaller();

  test("returns the tool's content with null structuredContent", async () => {
    expect(await caller.call(stdioInput({}))).toEqual({
      status: "ok",
      content: [{ type: "text", text: "echo: hi" }],
      structuredContent: null,
    });
  });

  test("keeps structuredContent", async () => {
    const outcome = await caller.call(stdioInput({ tool: "structured" }));

    expect(outcome).toMatchObject({
      status: "ok",
      structuredContent: FIXTURE_STRUCTURED_CONTENT,
    });
  });

  test("an isError result is a tool_error with its content", async () => {
    expect(await caller.call(stdioInput({ tool: "fails" }))).toEqual({
      status: "tool_error",
      content: [{ type: "text", text: "the tool failed" }],
    });
  });

  test("an unknown tool is unavailable: tool_not_found", async () => {
    const outcome = await caller.call(stdioInput({ tool: "nope" }));

    expect(outcome).toMatchObject({
      status: "unavailable",
      reason: "tool_not_found",
    });
    expect(recordedCalls()).toEqual(["nope"]);
  });

  test("a server that exits on start is unavailable: start, with its stderr", async () => {
    const outcome = await caller.call(
      stdioInput({ environment: { FIXTURE_CRASH_ON_START: "1" } }),
    );

    expect(outcome).toMatchObject({ status: "unavailable", reason: "start" });
  });

  test("a missing command is unavailable: start", async () => {
    const outcome = await caller.call(
      stdioInput({
        server: { type: "local", command: ["scarn-no-such-mcp-server"] },
      }),
    );

    expect(outcome).toMatchObject({ status: "unavailable", reason: "start" });
  });

  test("a failed start is retried once before tools/call", async () => {
    const outcome = await caller.call(
      stdioInput({
        environment: { FIXTURE_CRASH_ONCE_FILE: path.join(scratch, "once") },
      }),
    );

    expect(outcome).toMatchObject({ status: "ok" });
    expect(recordedCalls()).toEqual(["echo"]);
  });

  test("a server that dies after tools/call is sent is not retried", async () => {
    const outcome = await caller.call(stdioInput({ tool: "crash" }));

    expect(outcome).toMatchObject({ status: "unavailable", reason: "connect" });
    expect(recordedCalls()).toEqual(["crash"]);
  });

  test("a call that outlives timeoutMs is a timeout and stops the server", async () => {
    const outcome = await caller.call(
      stdioInput({ tool: "sleep", args: { ms: 60_000 }, timeoutMs: 1_500 }),
    );

    expect(outcome).toEqual({ status: "timeout" });
    const pid = Number(readFileSync(path.join(scratch, "pid"), "utf8"));
    await waitFor(() => !isAlive(pid));
  });

  test("aborting mid-call returns aborted and the server process is gone", async () => {
    const controller = new AbortController();
    const pending = caller.call(
      stdioInput({
        tool: "sleep",
        args: { ms: 60_000 },
        signal: controller.signal,
      }),
    );
    await waitFor(() => recordedCalls().length === 1);
    const pid = Number(readFileSync(path.join(scratch, "pid"), "utf8"));
    expect(isAlive(pid)).toBe(true);

    controller.abort();

    expect(await pending).toEqual({ status: "aborted" });
    expect(isAlive(pid)).toBe(false);
  });

  test("an already-aborted signal never starts the server", async () => {
    const controller = new AbortController();
    controller.abort();

    expect(
      await caller.call(stdioInput({ signal: controller.signal })),
    ).toEqual({ status: "aborted" });
    expect(existsSync(path.join(scratch, "pid"))).toBe(false);
  });

  test("resolves the server's cwd against the workspace dir", async () => {
    const outcome = await caller.call(
      stdioInput({
        server: {
          type: "local",
          command: [process.execPath, "run", "tool-call-mcp-server.ts"],
          cwd: "{env:FIXTURE_DIR}",
        },
        placement: { kind: "host", workspaceDir: "/" },
        env: { ...hostEnv(), FIXTURE_DIR: path.dirname(FIXTURE_SERVER_PATH) },
      }),
    );

    expect(outcome).toMatchObject({ status: "ok" });
  });
});

describe("SdkMcpToolCaller over Streamable HTTP", () => {
  const caller = new SdkMcpToolCaller();
  let fixture: ReturnType<typeof serveToolCallFixtureOverHttp> | undefined;

  afterEach(async () => {
    await fixture?.stop();
    fixture = undefined;
  });

  function remoteInput(
    url: string,
    overrides: Partial<McpToolCallInput> = {},
  ): McpToolCallInput {
    return {
      server: {
        type: "remote",
        url: "{env:FIXTURE_URL}",
        headers: { Authorization: "Bearer {env:TOKEN}" },
      },
      placement: { kind: "host", workspaceDir: scratch },
      tool: "structured",
      args: {},
      env: { FIXTURE_URL: url, TOKEN: "t" },
      timeoutMs: 15_000,
      signal: new AbortController().signal,
      ...overrides,
    };
  }

  test("returns content and structuredContent", async () => {
    fixture = serveToolCallFixtureOverHttp({});

    expect(await caller.call(remoteInput(fixture.url))).toEqual({
      status: "ok",
      content: [
        { type: "text", text: JSON.stringify(FIXTURE_STRUCTURED_CONTENT) },
      ],
      structuredContent: FIXTURE_STRUCTURED_CONTENT,
    });
    expect(fixture.calls).toEqual(["structured"]);
  });

  test("an isError result is a tool_error", async () => {
    fixture = serveToolCallFixtureOverHttp({});

    expect(
      await caller.call(remoteInput(fixture.url, { tool: "fails" })),
    ).toMatchObject({ status: "tool_error" });
  });

  test("an unknown tool is unavailable: tool_not_found", async () => {
    fixture = serveToolCallFixtureOverHttp({});

    expect(
      await caller.call(remoteInput(fixture.url, { tool: "nope" })),
    ).toMatchObject({ status: "unavailable", reason: "tool_not_found" });
  });

  test("an unreachable server is unavailable: connect", async () => {
    fixture = serveToolCallFixtureOverHttp({});
    const url = fixture.url;
    await fixture.stop();
    fixture = undefined;

    expect(await caller.call(remoteInput(url))).toMatchObject({
      status: "unavailable",
      reason: "connect",
    });
  });

  test("a connection failure before tools/call is retried once", async () => {
    fixture = serveToolCallFixtureOverHttp({ failFirstRequests: 1 });

    expect(await caller.call(remoteInput(fixture.url))).toMatchObject({
      status: "ok",
    });
    expect(fixture.calls).toEqual(["structured"]);
  });

  test("a failure after tools/call was sent is not retried", async () => {
    fixture = serveToolCallFixtureOverHttp({ dropToolCalls: true });

    expect(await caller.call(remoteInput(fixture.url))).toMatchObject({
      status: "unavailable",
      reason: "connect",
    });
    expect(fixture.calls).toEqual(["structured"]);
  });

  test("a call that outlives timeoutMs is a timeout", async () => {
    fixture = serveToolCallFixtureOverHttp({});

    expect(
      await caller.call(
        remoteInput(fixture.url, {
          tool: "sleep",
          args: { ms: 60_000 },
          timeoutMs: 500,
        }),
      ),
    ).toEqual({ status: "timeout" });
  });

  test("aborting mid-call returns aborted", async () => {
    fixture = serveToolCallFixtureOverHttp({});
    const calls = fixture.calls;
    const controller = new AbortController();
    const pending = caller.call(
      remoteInput(fixture.url, {
        tool: "sleep",
        args: { ms: 60_000 },
        signal: controller.signal,
      }),
    );
    await waitFor(() => calls.length === 1);

    controller.abort();

    expect(await pending).toEqual({ status: "aborted" });
  });
});
