import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import yargs from "yargs/yargs";
import type { CommandModule } from "yargs";
import type { LogLine, TaskRunDebugClient } from "@scarn/shared-core";
import { createArtifactsCommand } from "../src/commands/artifacts";
import { createLogsCommand } from "../src/commands/logs";
import {
  downloadToNewFile,
  type TaskRunDebugDependencies,
} from "../src/lib/task-run-debug-dependencies";
import { createFullLogSaver } from "../src/lib/task-log-cache";
import { runCli } from "./utils";

setDefaultTimeout(15_000);

const TASK_ID = "0196a000-0000-7000-8000-0000000000c1";
const TASK_RUN_ID = "0196a000-0000-7000-8000-0000000000e1";
const ARTIFACT_ID = "0196a000-0000-7000-8000-0000000000f1";

const tempDir = mkdtempSync(path.join(os.tmpdir(), "scarn-logs-test-"));
afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const ok = <T>(data: T) => Promise.resolve({ data, error: undefined });
const notFound = () =>
  Promise.resolve({
    data: undefined,
    error: { status: 404, detail: "not found" },
  });

const taskRun = {
  id: TASK_RUN_ID,
  taskId: TASK_ID,
  number: 2,
  reason: "retry",
  workItemId: null,
  name: null,
  kind: "agent",
  previousTaskRunId: null,
  baseBranch: null,
  baseCommit: null,
  heartbeatSeconds: null,
  status: "running",
  claimedBy: null,
  claimedAt: null,
  lastHeartbeatAt: null,
  leaseExpiresAt: null,
  executionTimeoutSeconds: null,
  executionDeadlineAt: null,
  startedAt: null,
  completedAt: null,
  resultJson: null,
  errorJson: null,
  workBranch: null,
  createdFromBranch: null,
  sessionRestored: null,
  createdAt: "2026-01-02T00:00:00.000Z",
} as const;

const logLine = (seq: number, content: string): LogLine => ({
  seq,
  stream: "worker",
  ts: "2026-01-02T00:00:00.000Z",
  content,
  level: "info",
});

type Calls = { froms: number[]; sleeps: number[]; downloads: string[] };

function fakeDependencies(calls: Calls): TaskRunDebugDependencies {
  const client: TaskRunDebugClient = {
    tasks: {
      getTaskRuns: ({ path: { taskId } }) =>
        taskId === TASK_ID ? ok([taskRun]) : notFound(),
    },
    taskRuns: {
      getTaskRun: ({ path: { taskRunId } }) =>
        taskRunId === TASK_RUN_ID ? ok(taskRun) : notFound(),
      readTaskLogs: ({ query }) => {
        calls.froms.push(query.from);
        if (query.from === 0) {
          return ok({
            lines: [logLine(1, "starting"), logLine(2, "boom: it broke")],
            nextOffset: 2,
            complete: false,
          });
        }
        if (query.from === 2) {
          return ok({
            lines: [logLine(3, "after the fix")],
            nextOffset: 3,
            complete: false,
          });
        }
        return ok({ lines: [], nextOffset: query.from, complete: true });
      },
      getTaskLogArchive: () => ok({ url: null, sizeBytes: 0 }),
      listTaskArtifacts: () =>
        ok([
          {
            id: ARTIFACT_ID,
            relativeStorePath: "shots/home.png",
            sizeBytes: 3,
            contentType: "image/png",
            kind: "image",
            createdAt: "2026-01-02T00:01:00.000Z",
          },
        ]),
      listTaskArtifactFailures: () => ok([]),
      getArtifactDownloadUrl: () =>
        ok({
          url: "https://store.example/home.png",
          sizeBytes: 3,
          contentType: "image/png",
          relativeStorePath: "shots/home.png",
        }),
    },
  };
  return {
    connect: () =>
      Promise.resolve({ client, headers: { Authorization: "Bearer test" } }),
    saveFullLog: createFullLogSaver(tempDir),
    sleep: (ms) => {
      calls.sleeps.push(ms);
      return Promise.resolve();
    },
    download: (url, outPath) => {
      calls.downloads.push(url);
      writeFileSync(outPath, "png", { flag: "wx" });
      return Promise.resolve({ bytes: 3 });
    },
  };
}

async function runCommand(
  build: (deps: TaskRunDebugDependencies) => CommandModule<object, object>,
  args: readonly string[],
): Promise<{ stdout: string; calls: Calls }> {
  const calls: Calls = { froms: [], sleeps: [], downloads: [] };
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  try {
    await yargs([...args])
      .command(build(fakeDependencies(calls)))
      .strict()
      .exitProcess(false)
      .showHelpOnFail(false)
      .fail((message, error) => {
        throw error instanceof Error ? error : new Error(message);
      })
      .parseAsync();
  } finally {
    process.stdout.write = originalWrite;
  }
  return { stdout: chunks.join(""), calls };
}

const runLogs = (args: readonly string[]) =>
  runCommand(
    (deps) =>
      createLogsCommand(deps) as unknown as CommandModule<object, object>,
    ["logs", ...args],
  );
const runArtifacts = (args: readonly string[]) =>
  runCommand(createArtifactsCommand, ["artifacts", ...args]);

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`rejected with a non-Error: ${String(error)}`);
  }
  throw new Error("expected the promise to reject");
}

const savedLogPath = path.join(tempDir, `${TASK_RUN_ID}-all.log`);

describe("scarn logs", () => {
  test("--help lists the flags", async () => {
    const result = await runCli(["logs", "--help"]);
    expect(result.exitCode).toBe(0);
    for (const flag of [
      "--stream",
      "--tail",
      "--grep",
      "--since-line",
      "--follow",
      "--run",
    ]) {
      expect(result.stdout).toContain(flag);
    }
  });

  test("a Task id resolves to its latest run, saves the full log and ends with hints", async () => {
    const { stdout } = await runLogs([TASK_ID]);
    expect(stdout).toContain(`full log: ${savedLogPath}`);
    expect(readFileSync(savedLogPath, "utf8")).toContain("boom: it broke");
    expect(
      stdout.trimEnd().endsWith(`→ scarn task-runs view ${TASK_RUN_ID}`),
    ).toBe(true);
    expect(stdout).toContain(`→ scarn artifacts list ${TASK_RUN_ID}`);
  });

  test("--grep prints numbered matches and points to the saved file", async () => {
    const { stdout } = await runLogs([TASK_RUN_ID, "--grep", "boom"]);
    expect(stdout).toContain(`Full log: ${savedLogPath}`);
    expect(stdout).toMatch(/\d+ {2}\[info\] .* boom: it broke/);
    expect(stdout).not.toContain("starting");
  });

  test("--json prints one document", async () => {
    const { stdout } = await runLogs([TASK_RUN_ID, "--json", "--tail", "1"]);
    const body = JSON.parse(stdout) as {
      taskRunId: string;
      savedTo: string;
      lines: { text: string }[];
    };
    expect(body.taskRunId).toBe(TASK_RUN_ID);
    expect(body.savedTo).toBe(savedLogPath);
    expect(body.lines).toHaveLength(1);
  });

  test("--follow polls from the cursor until archived", async () => {
    const { stdout, calls } = await runLogs([TASK_RUN_ID, "--follow"]);
    expect(calls.froms).toEqual([0, 2, 3]);
    expect(calls.sleeps).toEqual([2_000]);
    expect(stdout).toContain("worker │ [info]");
    expect(stdout).toContain("after the fix");
    expect(readFileSync(savedLogPath, "utf8")).toContain("after the fix");
    expect(
      stdout.trimEnd().endsWith(`→ scarn task-runs view ${TASK_RUN_ID}`),
    ).toBe(true);
  });

  test("rejects --follow with --json, and --run past the last run", async () => {
    expect(
      (await rejection(runLogs([TASK_RUN_ID, "--follow", "--json"]))).message,
    ).toContain("--follow cannot be combined with --json");
    expect(
      (await rejection(runLogs([TASK_ID, "--run", "7"]))).message,
    ).toContain("has no run #7");
  });
});

describe("scarn artifacts", () => {
  test("list ends with the download hint", async () => {
    const { stdout } = await runArtifacts(["list", TASK_RUN_ID, "--failures"]);
    expect(stdout).toContain("shots/home.png");
    expect(stdout).toContain("Failed uploads: none");
    expect(stdout).toContain(
      `→ scarn artifacts download ${TASK_RUN_ID} ${ARTIFACT_ID}`,
    );
  });

  test("download by file name saves to --out and refuses to overwrite", async () => {
    const outPath = path.join(tempDir, "home.png");
    const { stdout, calls } = await runArtifacts([
      "download",
      TASK_RUN_ID,
      "home.png",
      "--out",
      outPath,
    ]);
    expect(calls.downloads).toEqual(["https://store.example/home.png"]);
    expect(stdout).toContain(`to ${outPath}`);
    expect(
      (
        await rejection(
          runArtifacts([
            "download",
            TASK_RUN_ID,
            ARTIFACT_ID,
            "--out",
            outPath,
          ]),
        )
      ).message,
    ).toContain("already exists");
  });

  test("downloadToNewFile streams the body and never overwrites", async () => {
    const outPath = path.join(tempDir, "streamed.bin");
    const fakeFetch = (() =>
      Promise.resolve(new Response("hello"))) as unknown as typeof fetch;
    expect(await downloadToNewFile("https://x", outPath, fakeFetch)).toEqual({
      bytes: 5,
    });
    expect(readFileSync(outPath, "utf8")).toBe("hello");
    expect(
      (await rejection(downloadToNewFile("https://x", outPath, fakeFetch)))
        .message,
    ).toContain("EEXIST");
  });
});
