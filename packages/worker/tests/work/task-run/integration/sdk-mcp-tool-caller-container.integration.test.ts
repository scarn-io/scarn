import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { McpToolCallInput } from "../../../../src/work/task-run/application/mcp-tool-caller";
import { SdkMcpToolCaller } from "../../../../src/work/task-run/infra/sdk-mcp-tool-caller";

/**
 * `SdkMcpToolCaller` with `placement: container`: the fixture server, bundled
 * to one file, runs inside a plain `oven/bun` container through
 * `docker exec -i`, and an abort must leave no server process behind in the
 * container.
 */

const integrationEnabled = process.env["SCARN_INTEGRATION"] === "true";
const IMAGE = "oven/bun:1.4.4";
const SERVER_IN_CONTAINER = "/srv/mcp/server.js";

const execFileAsync = promisify(execFile);

async function docker(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args);
  return stdout.trim();
}

async function serverProcessCount(containerId: string): Promise<number> {
  const out = await docker(
    "exec",
    "-e",
    "NEEDLE=server.js",
    containerId,
    "sh",
    "-c",
    'for f in /proc/[0-9]*/cmdline; do tr "\\0" "\\n" < "$f" 2>/dev/null | grep -qx "$NEEDLE" && echo x; done; true',
  );
  return out === "" ? 0 : out.split("\n").length;
}

describe.skipIf(!integrationEnabled)(
  "SdkMcpToolCaller in a container (integration)",
  () => {
    let containerId: string;
    let scratch: string;
    const caller = new SdkMcpToolCaller();

    beforeAll(async () => {
      scratch = mkdtempSync(path.join(tmpdir(), "scarn-mcp-caller-docker-"));
      const bundle = path.join(scratch, "server.js");
      await execFileAsync(process.execPath, [
        "build",
        path.join(
          import.meta.dirname,
          "..",
          "unit",
          "fixtures",
          "tool-call-mcp-server.ts",
        ),
        "--target=bun",
        `--outfile=${bundle}`,
      ]);
      containerId = await docker("run", "-d", "--rm", IMAGE, "sleep", "600");
      await docker("exec", containerId, "mkdir", "-p", "/srv/mcp");
      await docker("cp", bundle, `${containerId}:${SERVER_IN_CONTAINER}`);
    }, 120_000);

    afterAll(async () => {
      await docker("rm", "-f", containerId).catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    });

    function input(overrides: Partial<McpToolCallInput>): McpToolCallInput {
      return {
        server: {
          type: "local",
          command: ["bun", "run", "{env:SERVER_FILE}"],
          environment: { FIXTURE_CALLS_FILE: "/tmp/calls" },
        },
        placement: {
          kind: "container",
          containerId,
          workspaceDir: "/srv/mcp",
        },
        tool: "echo",
        args: { text: "from docker" },
        env: { SERVER_FILE: "server.js" },
        timeoutMs: 30_000,
        signal: new AbortController().signal,
        ...overrides,
      };
    }

    test("calls the tool over docker exec and stops the server", async () => {
      expect(await caller.call(input({}))).toEqual({
        status: "ok",
        content: [{ type: "text", text: "echo: from docker" }],
        structuredContent: null,
      });
      expect(await serverProcessCount(containerId)).toBe(0);
    }, 60_000);

    test("aborting mid-call kills the server inside the container", async () => {
      const controller = new AbortController();
      const pending = caller.call(
        input({
          tool: "sleep",
          args: { ms: 120_000 },
          signal: controller.signal,
        }),
      );
      const deadline = Date.now() + 30_000;
      while ((await serverProcessCount(containerId)) === 0) {
        if (Date.now() > deadline) throw new Error("server never started");
        await Bun.sleep(100);
      }
      await Bun.sleep(500);

      controller.abort();

      expect(await pending).toEqual({ status: "aborted" });
      expect(await serverProcessCount(containerId)).toBe(0);
    }, 60_000);
  },
);
