import { describe, expect, test } from "bun:test";
import {
  formatTaskRunLogs,
  renderTaskRunLogText,
  selectLogLines,
  taskRunLogsJson,
} from "../src/format-task-run-logs";
import {
  followTaskRunLogs,
  gatherTaskRunLogs,
  resolveTaskRun,
} from "../src/gather-task-run-logs";
import type { ApiResult } from "../src/lib/api-result";
import type { LogLine } from "../src/lib/api-types";
import type { TaskRunDebugClient } from "../src/lib/task-run-debug-client";
import { LIVE_LOG_PAGE_SIZE } from "../src/load-task-log-lines";
import {
  findArtifact,
  formatArtifactList,
  gatherArtifacts,
  resolveArtifactDownload,
} from "../src/task-run-artifacts";
import {
  makeArtifact,
  makeTaskRun,
  TASK_ID,
  TASK_RUN_ID,
} from "./task-fixtures";

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`rejected with a non-Error: ${String(error)}`);
  }
  throw new Error("expected the promise to reject");
}

const headers = { Authorization: "Bearer test" };

const ok = <T>(data: T): Promise<ApiResult<T>> =>
  Promise.resolve({ data, error: undefined });
const fail = <T>(status: number): Promise<ApiResult<T>> =>
  Promise.resolve({ data: undefined, error: { status, detail: "nope" } });

const line = (seq: number, overrides: Partial<LogLine> = {}): LogLine => ({
  seq,
  stream: "worker",
  ts: "2026-01-02T00:00:00.000Z",
  content: `line ${String(seq)}`,
  level: "info",
  ...overrides,
});

function buildClient(
  overrides: Partial<TaskRunDebugClient["taskRuns"]> = {},
  getTaskRuns: TaskRunDebugClient["tasks"]["getTaskRuns"] = () => fail(404),
): TaskRunDebugClient {
  return {
    tasks: { getTaskRuns },
    taskRuns: {
      getTaskRun: () => fail(404),
      readTaskLogs: () => ok({ lines: [], nextOffset: 0, complete: false }),
      getTaskLogArchive: () => ok({ url: null, sizeBytes: 0 }),
      listTaskArtifacts: () => ok([makeArtifact()]),
      listTaskArtifactFailures: () => ok([]),
      getArtifactDownloadUrl: () =>
        ok({
          url: "https://store.example/report.md",
          sizeBytes: 2048,
          contentType: "text/markdown",
          relativeStorePath: "report.md",
        }),
      ...overrides,
    },
  };
}

describe("resolveTaskRun", () => {
  test("returns the Task run when the id is a Task run id", async () => {
    const client = buildClient({ getTaskRun: () => ok(makeTaskRun()) });
    const run = await resolveTaskRun({ client, headers, id: TASK_RUN_ID });
    expect(run.id).toBe(TASK_RUN_ID);
  });

  test("falls back to the Task's latest run, or run N with runNumber", async () => {
    const runs = [
      makeTaskRun({ id: "run-2", number: 2 }),
      makeTaskRun({ id: "run-1", number: 1 }),
    ];
    const client = buildClient({}, () => ok(runs));
    expect((await resolveTaskRun({ client, headers, id: TASK_ID })).id).toBe(
      "run-2",
    );
    expect(
      (await resolveTaskRun({ client, headers, id: TASK_ID, runNumber: 1 })).id,
    ).toBe("run-1");
    expect(
      (
        await rejection(
          resolveTaskRun({ client, headers, id: TASK_ID, runNumber: 5 }),
        )
      ).message,
    ).toContain("has no run #5 (runs: 1, 2)");
  });

  test("names both kinds of id when neither exists", async () => {
    expect(
      (
        await rejection(
          resolveTaskRun({ client: buildClient(), headers, id: "missing" }),
        )
      ).message,
    ).toContain("No Task run or Task with id missing.");
  });
});

describe("gatherTaskRunLogs", () => {
  test("pages the live feed and filters to the requested stream", async () => {
    const froms: number[] = [];
    const firstPage = Array.from({ length: LIVE_LOG_PAGE_SIZE }, (_, index) =>
      line(index + 1),
    );
    const client = buildClient({
      readTaskLogs: ({ query }) => {
        froms.push(query.from);
        return query.from === 0
          ? ok({
              lines: firstPage,
              nextOffset: LIVE_LOG_PAGE_SIZE,
              complete: false,
            })
          : ok({
              lines: [line(LIVE_LOG_PAGE_SIZE + 1, { stream: "ai-server" })],
              nextOffset: LIVE_LOG_PAGE_SIZE + 1,
              complete: false,
            });
      },
    });
    const gathered = await gatherTaskRunLogs({
      client,
      headers,
      run: makeTaskRun({ completedAt: null, status: "running" }),
      stream: "ai-server",
    });
    expect(froms).toEqual([0, LIVE_LOG_PAGE_SIZE]);
    expect(gathered.lines.map((entry) => entry.seq)).toEqual([
      LIVE_LOG_PAGE_SIZE + 1,
    ]);
    expect(gathered.nextOffset).toBe(LIVE_LOG_PAGE_SIZE + 1);
    expect(gathered.source).toBe("live");
  });

  test("falls back to the live feed when a finished run is not archived yet", async () => {
    const client = buildClient({
      readTaskLogs: () =>
        ok({ lines: [line(1)], nextOffset: 1, complete: false }),
    });
    const gathered = await gatherTaskRunLogs({
      client,
      headers,
      run: makeTaskRun(),
      stream: "all",
    });
    expect(gathered.source).toBe("live");
    expect(gathered.lines).toHaveLength(1);
  });

  test("fails with the archive's reason when there is nothing to show", async () => {
    expect(
      (
        await rejection(
          gatherTaskRunLogs({
            client: buildClient(),
            headers,
            run: makeTaskRun(),
            stream: "all",
          }),
        )
      ).message,
    ).toContain("no log archive is available");
  });
});

describe("followTaskRunLogs", () => {
  test("polls from the cursor until the run is archived", async () => {
    const froms: number[] = [];
    const sleeps: number[] = [];
    const received: number[][] = [];
    const client = buildClient({
      readTaskLogs: ({ query }) => {
        froms.push(query.from);
        return query.from === 3
          ? ok({ lines: [line(4)], nextOffset: 4, complete: false })
          : ok({ lines: [], nextOffset: query.from, complete: true });
      },
    });
    const followed = await followTaskRunLogs({
      client,
      headers,
      taskRunId: TASK_RUN_ID,
      stream: "all",
      from: 3,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      onLines: (lines) => received.push(lines.map((entry) => entry.seq)),
    });
    expect(froms).toEqual([3, 4]);
    expect(sleeps).toEqual([2_000]);
    expect(received).toEqual([[4]]);
    expect(followed.map((entry) => entry.seq)).toEqual([4]);
  });
});

describe("formatTaskRunLogs", () => {
  const gathered = {
    run: makeTaskRun(),
    source: "archive" as const,
    requestedStream: "all" as const,
    lines: [line(1, { content: "boot" }), line(2, { content: "boom" })],
    nextOffset: 2,
  };
  const fullText = renderTaskRunLogText(gathered);
  const saved = { path: "/home/me/.scarn/task-logs/run-all.log" };

  test("prints the log with where it was saved, then the next commands", () => {
    const output = formatTaskRunLogs({
      gathered,
      fullText,
      saved,
      selection: {},
    });
    expect(output).toContain(
      `Logs for Task run ${TASK_RUN_ID} (complete) · full log: ${saved.path}`,
    );
    expect(
      output.trimEnd().endsWith(`→ scarn task-runs view ${TASK_RUN_ID}`),
    ).toBe(true);
  });

  test("--grep prints matches with their line numbers in the saved file", () => {
    const output = formatTaskRunLogs({
      gathered,
      fullText,
      saved,
      selection: { grep: /boom/ },
    });
    const numbered = selectLogLines(fullText, { grep: /boom/ });
    expect(numbered).toHaveLength(1);
    expect(fullText.split("\n")[(numbered[0]?.line ?? 0) - 1]).toContain(
      "boom",
    );
    expect(output).toContain(`Full log: ${saved.path}`);
    expect(output).toContain(`${String(numbered[0]?.line)}  [info]`);
    expect(output).not.toContain("boot");
  });

  test("--since-line and --tail combine", () => {
    const all = selectLogLines(fullText, {});
    const selected = selectLogLines(fullText, { sinceLine: 1, tail: 1 });
    expect(selected).toEqual(all.slice(-1));
  });

  test("json carries the selection and where the log was saved", () => {
    const json = taskRunLogsJson({
      gathered,
      fullText,
      saved: { error: "disk full" },
      selection: { tail: 1 },
    });
    expect(json.savedTo).toBeNull();
    expect(json.saveError).toBe("disk full");
    expect(json.lines).toHaveLength(1);
  });
});

describe("artifacts", () => {
  test("lists artifacts and failures and ends with the download hint", async () => {
    const client = buildClient({
      listTaskArtifactFailures: () =>
        ok([
          {
            id: "failure-1",
            taskRunId: TASK_RUN_ID,
            relativeStorePath: "trace.zip",
            attemptedSizeBytes: 10,
            kind: "playwright-trace",
            errorCode: "UPLOAD_FAILED",
            errorMessage: "timed out",
            httpStatus: 503,
            createdAt: "2026-01-02T00:01:06.000Z",
          },
        ]),
    });
    const gathered = await gatherArtifacts({
      client,
      headers,
      taskRunId: TASK_RUN_ID,
      failures: true,
    });
    const output = formatArtifactList(gathered);
    expect(output).toContain("UPLOAD_FAILED (HTTP 503): timed out");
    expect(
      output
        .trimEnd()
        .split("\n")
        .includes(
          `→ scarn artifacts download ${TASK_RUN_ID} ${makeArtifact().id}`,
        ),
    ).toBe(true);
  });

  test("finds an artifact by id, path, then unambiguous file name", () => {
    const nested = makeArtifact({
      id: "a2",
      relativeStorePath: "shots/home.png",
    });
    const artifacts = [makeArtifact(), nested];
    expect(findArtifact(artifacts, "a2")).toBe(nested);
    expect(findArtifact(artifacts, "shots/home.png")).toBe(nested);
    expect(findArtifact(artifacts, "home.png")).toBe(nested);
    expect(() => findArtifact(artifacts, "nope.png")).toThrow(
      "No artifact nope.png",
    );
  });

  test("resolves the presigned URL and rejects a missing one", async () => {
    const resolved = await resolveArtifactDownload({
      client: buildClient(),
      headers,
      taskRunId: TASK_RUN_ID,
      ref: "report.md",
    });
    expect(resolved.url).toBe("https://store.example/report.md");
    expect(
      (
        await rejection(
          resolveArtifactDownload({
            client: buildClient({
              getArtifactDownloadUrl: () =>
                ok({
                  url: null,
                  sizeBytes: 0,
                  contentType: null,
                  relativeStorePath: "report.md",
                }),
            }),
            headers,
            taskRunId: TASK_RUN_ID,
            ref: "report.md",
          }),
        )
      ).message,
    ).toContain("has no download URL");
  });
});
