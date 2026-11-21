import { afterAll, beforeAll, describe, expect, test, vi } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { MANAGED_RUNTIMES } from "../../../../src/runtime/runtime-service/domain/managed-runtimes";
import { buildTaskRunFailurePayload } from "../../../../src/work/task-run/application/build-task-run-failure-payload";
import { MCP_TOOL_RESULT_MAX_BYTES } from "../../../../src/work/task-run/application/mcp-tool-step-observability";
import { runMcpToolStepBranch } from "../../../../src/work/task-run/application/process-claimed-task-run-mcp-tool-branch";
import { buildFindingsSubmissionPath } from "../../../../src/work/task-run/application/process-project-work-findings";
import type {
  LaunchedRuntime,
  ProjectWorkLogger,
  TaskRunWorkerContext,
} from "../../../../src/work/task-run/contracts/process-project-work-types";
import { noopReporter } from "../../../../src/work/task-run/contracts/work-reporter";
import { createMcpToolStepWorkerContext } from "../unit/helpers/claimed-task-fixtures";

/**
 * The `mcp_tool` branch end to end with the real `SdkMcpToolCaller`: the
 * fixture stdio server, bundled to one file, runs inside the managed `bun1`
 * image through `docker exec -i`, and the branch renders args, calls the
 * tool, logs the call and writes the findings submission. Starts from a
 * launched runtime (the launch itself is covered by the 7b tests).
 */

const integrationEnabled = process.env["SCARN_INTEGRATION"] === "true";
const IMAGE = MANAGED_RUNTIMES.bun1.image;
const SERVER_DIR = "/srv/mcp";
const ENV_SECRET = "fixture-env-secret-value";
const ARG_SECRET = "confidential-arg-value";

const execFileAsync = promisify(execFile);

async function docker(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args);
  return stdout.trim();
}

async function settle(promise: Promise<void>): Promise<Error | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

describe.skipIf(!integrationEnabled)(
  "mcp_tool branch with the stdio server in the managed bun container (integration)",
  () => {
    let containerId: string;
    let scratch: string;

    beforeAll(async () => {
      scratch = mkdtempSync(path.join(tmpdir(), "scarn-mcp-branch-docker-"));
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
      containerId = await docker(
        "run",
        "-d",
        "--rm",
        "--user",
        MANAGED_RUNTIMES.bun1.remoteUser,
        IMAGE,
        "sleep",
        "600",
      );
      await docker(
        "exec",
        "-u",
        "root",
        containerId,
        "mkdir",
        "-p",
        SERVER_DIR,
      );
      await docker("cp", bundle, `${containerId}:${SERVER_DIR}/server.js`);
    }, 180_000);

    afterAll(async () => {
      await docker("rm", "-f", containerId).catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    });

    async function run(input: { tool: string; text: string }) {
      const workspacePath = mkdtempSync(path.join(scratch, "workspace-"));
      const base = createMcpToolStepWorkerContext();
      const workerContext: TaskRunWorkerContext = {
        ...base,
        task: {
          ...base.task,
          inputJson: { text: input.text },
          toolCall: {
            server: "fixture",
            tool: input.tool,
            argsTemplate: { text: "{{input.text}}" },
            toolSchemas: { input: { type: "object" }, output: null },
          },
        },
      };
      const environment = {
        workspacePath,
        mcpTool: {
          servers: {
            fixture: {
              type: "local",
              command: ["bun", "run", "{env:SERVER_FILE}"],
              environment: { FIXTURE_TOKEN: "{env:FIXTURE_TOKEN}" },
            },
          },
          env: { SERVER_FILE: "server.js", FIXTURE_TOKEN: ENV_SECRET },
          placement: {
            kind: "container",
            containerId,
            workspaceDir: SERVER_DIR,
          },
        },
      } as unknown as LaunchedRuntime;
      const logger = {
        debug: vi.fn<ProjectWorkLogger["debug"]>(),
        log: vi.fn<ProjectWorkLogger["log"]>(),
        error: vi.fn<ProjectWorkLogger["error"]>(),
      };
      const failure = await settle(
        runMcpToolStepBranch({
          deps: {},
          logger,
          reporter: noopReporter,
          workerContext,
          environment,
          taskRunId: "task-run-id",
          localRuntimeSessionId: "local-session-id",
          promptEnv: { FIXTURE_TOKEN: ENV_SECRET },
        }),
      );
      const log = [...logger.debug.mock.calls, ...logger.log.mock.calls]
        .map(
          ([scope, message, details]) =>
            `[${scope}] ${message} ${JSON.stringify(details ?? {})}`,
        )
        .join("\n");
      return { failure, log, logger, workspacePath };
    }

    test("calls the tool in the container, logs the call and writes the findings", async () => {
      const { failure, log, logger, workspacePath } = await run({
        tool: "echo",
        text: ARG_SECRET,
      });

      expect(failure).toBeUndefined();
      const submission = JSON.parse(
        await readFile(buildFindingsSubmissionPath(workspacePath), "utf8"),
      ) as { findingsJson: unknown };
      expect(submission.findingsJson).toEqual({
        content: [{ type: "text", text: `echo: ${ARG_SECRET}` }],
        structuredContent: null,
      });
      const messages = logger.log.mock.calls.map(([, message]) => message);
      expect(messages).toContain("mcp: starting fixture (local)");
      expect(
        messages.some((message) =>
          /^mcp: fixture\.echo called in \d+\.\ds \(ok\)$/.test(message),
        ),
      ).toBe(true);
      expect(log).toContain('"argKeys":["text"]');
      expect(log).toContain('"contentBlocks":1');
      expect(log).not.toContain(ARG_SECRET);
      expect(log).not.toContain(ENV_SECRET);
    }, 60_000);

    test("a result over the cap fails the step with Scarn.McpOutputInvalid", async () => {
      const { failure, logger } = await run({
        tool: "echo",
        text: "x".repeat(MCP_TOOL_RESULT_MAX_BYTES),
      });

      expect(buildTaskRunFailurePayload(failure).errorJson.name).toBe(
        "Scarn.McpOutputInvalid",
      );
      expect(failure?.message).toContain("over the 1 MiB limit");
      expect(logger.log.mock.calls.at(-1)?.[1]).toMatch(/\(ok\)$/);
    }, 60_000);
  },
);
