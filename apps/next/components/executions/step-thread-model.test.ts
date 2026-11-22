import { describe, expect, test } from "bun:test";
import {
  parseUuidV7,
  type NodeVisitContract,
  type VisitThreadContract,
} from "@scarn/api/frontend-contracts";
import {
  buildThreadRuns,
  isRunLive,
  runCause,
  runDurationMs,
  runStatusWord,
  runTailIndicator,
  sessionNote,
  visitThreadRuns,
  type StepThreadRun,
} from "./step-thread-model";

const VISIT_ID = parseUuidV7("019e9a92-b432-73e8-9341-3519156fa700");
const FIRST_TASK_ID = parseUuidV7("019e9a92-b432-73e8-9341-3519156fa698");
const SECOND_TASK_ID = parseUuidV7("019e9a92-b432-73e8-9341-3519156fa699");

const message = { id: "m1" } as unknown as StepThreadRun["messages"][number];

const NO_EXCHANGE = {
  sessionRestored: null,
} as const;

const visit = {
  id: VISIT_ID,
  nodeId: "fix",
  createdAt: "2026-01-01T11:59:00.000Z",
  tasks: [
    {
      taskId: FIRST_TASK_ID,
      attemptNumber: 1,
      status: "failed",
      startedAt: "2026-01-01T12:00:00.000Z",
      completedAt: "2026-01-01T12:00:05.000Z",
      workBranch: "work/fix",
    },
    {
      taskId: SECOND_TASK_ID,
      attemptNumber: 2,
      status: "abandoned",
      startedAt: "2026-01-01T12:01:00.000Z",
      completedAt: null,
      workBranch: "work/fix",
    },
  ],
} as unknown as NodeVisitContract;

describe("runCause", () => {
  const cause = (
    run: Partial<Parameters<typeof runCause>[0]> &
      Pick<Parameters<typeof runCause>[0], "runNumber" | "attemptNumber">,
  ) => runCause({ messages: [], ...run });

  test("a run with messages came from the person", () => {
    expect(
      cause({
        runNumber: 3,
        attemptNumber: 1,
        messages: [message],
      }),
    ).toBe("From your message");
  });

  test("the first run was started by the pipeline", () => {
    expect(cause({ runNumber: 1, attemptNumber: 1 })).toBe(
      "Started by pipeline",
    );
  });

  test("a later attempt of the same visit is a retry", () => {
    expect(cause({ runNumber: 2, attemptNumber: 2 })).toBe("Retry 1");
  });

  test("a later run without messages or retries is a re-run", () => {
    expect(cause({ runNumber: 2, attemptNumber: 1 })).toBe("Re-run");
  });
});

describe("sessionNote", () => {
  test("says whether the run restored its session or used the transcript", () => {
    expect(sessionNote({ sessionRestored: true })).toBe("Resumed its session");
    expect(sessionNote({ sessionRestored: false })).toBe(
      "Session not restored; continued from the transcript",
    );
    expect(sessionNote({ sessionRestored: null })).toBeNull();
  });
});

describe("runStatusWord", () => {
  test("uses plain words for statuses, including liveness outcomes", () => {
    expect(runStatusWord("succeeded")).toBe("done");
    expect(runStatusWord("yielded")).toBe("waiting for you");
    expect(runStatusWord("cancelled")).toBe("stopped");
    expect(runStatusWord("timeout")).toBe("timed out");
    expect(runStatusWord("abandoned")).toBe("abandoned");
  });
});

describe("isRunLive", () => {
  test("only non-terminal task statuses are live", () => {
    expect(isRunLive("running")).toBe(true);
    expect(isRunLive("queued")).toBe(true);
    expect(isRunLive("abandoned")).toBe(false);
    expect(isRunLive("succeeded")).toBe(false);
    expect(isRunLive("yielded")).toBe(false);
  });
});

describe("runDurationMs", () => {
  const startedAt = "2026-01-01T12:00:00.000Z";

  test("is null before the run starts", () => {
    expect(runDurationMs({ startedAt: null, completedAt: null }, 0)).toBeNull();
  });

  test("measures to completion, or to now while running", () => {
    expect(
      runDurationMs({ startedAt, completedAt: "2026-01-01T12:00:05.000Z" }, 0),
    ).toBe(5000);
    expect(
      runDurationMs(
        { startedAt, completedAt: null },
        Date.parse("2026-01-01T12:00:02.000Z"),
      ),
    ).toBe(2000);
  });
});

describe("buildThreadRuns", () => {
  test("joins thread runs to visit tasks, preferring the visit's task status", () => {
    const runs: VisitThreadContract["runs"] = [
      {
        taskRunId: FIRST_TASK_ID,
        previousTaskRunId: null,
        status: "failed",
        createdAt: "2026-01-01T12:00:00.000Z",
        messages: [],
        ...NO_EXCHANGE,
      },
      {
        taskRunId: SECOND_TASK_ID,
        previousTaskRunId: FIRST_TASK_ID,
        status: "running",
        createdAt: "2026-01-01T12:01:00.000Z",
        messages: [],
        ...NO_EXCHANGE,
      },
    ];

    const [first, second] = buildThreadRuns(runs, [visit]);

    expect(first).toMatchObject({
      runNumber: 1,
      visitId: VISIT_ID,
      attemptNumber: 1,
      completedAt: "2026-01-01T12:00:05.000Z",
    });
    expect(second).toMatchObject({
      runNumber: 2,
      status: "abandoned",
      attemptNumber: 2,
      workBranch: "work/fix",
    });
  });

  test("keeps a run whose task isn't in the run detail", () => {
    const [run] = buildThreadRuns(
      [
        {
          taskRunId: FIRST_TASK_ID,
          previousTaskRunId: null,
          status: "queued",
          createdAt: "2026-01-01T12:00:00.000Z",
          messages: [],
          ...NO_EXCHANGE,
        },
      ],
      [],
    );

    expect(run).toMatchObject({
      status: "queued",
      visitId: null,
      attemptNumber: 1,
      startedAt: null,
    });
  });
});

describe("visitThreadRuns", () => {
  test("turns each visit task into a run section, chained in order", () => {
    const runs = visitThreadRuns(visit);

    expect(runs.map((run) => run.previousTaskRunId)).toEqual([
      null,
      FIRST_TASK_ID,
    ]);
    expect(runs.map((run) => run.runNumber)).toEqual([1, 2]);
    expect(runs[1]?.status).toBe("abandoned");
  });
});

describe("runTailIndicator", () => {
  const idle = { hasConversation: false, activityActive: false };

  test("shows nothing while the run waits for a worker", () => {
    expect(runTailIndicator({ status: "queued", ...idle })).toBeNull();
    expect(runTailIndicator({ status: "pending", ...idle })).toBeNull();
  });

  test("spins up once claimed but before the agent says anything", () => {
    expect(runTailIndicator({ status: "running", ...idle })).toBe(
      "spinning-up",
    );
  });

  test("thinks between activity rows once the agent is talking", () => {
    expect(
      runTailIndicator({
        status: "running",
        hasConversation: true,
        activityActive: false,
      }),
    ).toBe("thinking");
    expect(
      runTailIndicator({
        status: "running",
        hasConversation: true,
        activityActive: true,
      }),
    ).toBeNull();
  });

  test("shows nothing once the run has finished", () => {
    expect(
      runTailIndicator({
        status: "succeeded",
        hasConversation: true,
        activityActive: false,
      }),
    ).toBeNull();
  });
});
