import { describe, expect, test } from "bun:test";
import { formatRunList, formatVisitThread } from "../src/format-runs";
import {
  findPipelineDefinition,
  gatherRunList,
  gatherVisitThread,
} from "../src/gather-runs";
import type {
  RunListItem,
  RunVisit,
  RunWithVisits,
  VisitThread,
} from "../src/lib/run-api-types";
import type { RunReadClient } from "../src/lib/run-read-client";
import { resolveStepVisit } from "../src/lib/run-visits";

const RUN_ID = "0196a000-0000-7000-8000-0000000000bb";
const PROJECT_ID = "0196a000-0000-7000-8000-000000000001";
const PIPELINE_ID = "0196a000-0000-7000-8000-0000000000d1";
const headers = { Authorization: "Bearer test" };

const ok = <T>(data: T) => Promise.resolve({ data, error: undefined });

function visit(overrides: Partial<RunVisit>): RunVisit {
  return {
    id: "visit-1",
    nodeId: "build",
    nodeKind: "step",
    status: "succeeded",
    tasks: [],
    createdAt: "2026-01-02T00:00:00.000Z",
    completedAt: null,
    ...overrides,
  };
}

const run: RunWithVisits = {
  id: RUN_ID,
  workItemId: "work-item-1",
  workItemTitle: "Fix login",
  pipelineDefinitionId: PIPELINE_ID,
  status: "waiting",
  visits: [
    visit({ id: "visit-2", createdAt: "2026-01-02T00:02:00.000Z" }),
    visit({ id: "visit-1", status: "superseded" }),
    visit({
      id: "visit-3",
      status: "superseded",
      createdAt: "2026-01-02T00:03:00.000Z",
    }),
    visit({ id: "wait-1", nodeId: "approve", nodeKind: "wait" }),
  ],
};

const listItem: RunListItem = {
  id: RUN_ID,
  workItemId: "0196a000-0000-7000-8000-0000000000aa",
  workItemTitle: "Fix login",
  pipelineDefinitionId: PIPELINE_ID,
  status: "failed",
  waitingFor: null,
  error: { name: "StepFailed", message: "build failed" },
  startedAt: "2026-01-02T00:00:00.000Z",
  completedAt: "2026-01-02T00:10:00.000Z",
  createdAt: "2026-01-02T00:00:00.000Z",
  openNodeIds: [],
};

const thread: VisitThread = {
  visitId: "visit-2",
  nodeId: "build",
  runs: [
    {
      taskRunId: "run-1",
      previousTaskRunId: null,
      status: "failed",
      createdAt: "2026-01-02T00:02:00.000Z",
      messages: [],
      sessionRestored: null,
    },
    {
      taskRunId: "run-2",
      previousTaskRunId: "run-1",
      status: "running",
      createdAt: "2026-01-02T00:05:00.000Z",
      messages: [
        {
          id: "message-1",
          taskId: "run-2",
          authorUserId: "user-1",
          body: "Try the other port.\nThanks",
          quoteText: "listening on 3000",
          createdAt: "2026-01-02T00:04:00.000Z",
        },
      ],
      sessionRestored: true,
    },
  ],
};

type Calls = { listQuery?: unknown; threadPath?: unknown };

function fakeClient(calls: Calls): RunReadClient {
  return {
    pipelineExecutions: {
      listPipelineExecutions: ({ query }) => {
        calls.listQuery = query;
        return ok({
          items: [listItem],
          pagination: { page: 1, pageSize: 1, total: 3 },
        });
      },
      getPipelineExecution: () => ok(run),
      getVisitThread: ({ path }) => {
        calls.threadPath = path;
        return ok(thread);
      },
    },
    pipelineDefinitions: {
      listPipelineDefinitions: () =>
        ok([
          {
            id: PIPELINE_ID,
            key: "ship-it",
            name: "Ship it",
            archivedAt: null,
          },
        ]),
    },
  };
}

describe("resolveStepVisit", () => {
  test("defaults to the latest non-superseded visit, numbered oldest first", () => {
    const resolved = resolveStepVisit(run, "build", undefined);
    expect(resolved.visit.id).toBe("visit-2");
    expect(resolved.attemptNumber).toBe(2);
    expect(resolved.attemptCount).toBe(3);
  });

  test("--attempt picks the nth visit", () => {
    expect(resolveStepVisit(run, "build", 1).visit.id).toBe("visit-1");
  });

  test("names the visited steps and attempts when the pick misses", () => {
    expect(() => resolveStepVisit(run, "deploy", undefined)).toThrow(
      'Step "deploy" has no visits in pipeline run 0196a000-0000-7000-8000-0000000000bb. Visited steps: build, approve.',
    );
    expect(() => resolveStepVisit(run, "build", 4)).toThrow(
      "Available attempts: 1, 2, 3.",
    );
  });
});

describe("findPipelineDefinition", () => {
  test("matches an id or a key and lists keys when neither matches", () => {
    const definitions = [
      { id: PIPELINE_ID, key: "ship-it", name: "Ship it", archivedAt: null },
    ];
    expect(findPipelineDefinition(definitions, "ship-it").id).toBe(PIPELINE_ID);
    expect(findPipelineDefinition(definitions, PIPELINE_ID).key).toBe(
      "ship-it",
    );
    expect(() => findPipelineDefinition(definitions, "nope")).toThrow(
      'No pipeline "nope" in this project. Pipelines: ship-it.',
    );
  });
});

describe("runs list", () => {
  test("resolves the pipeline key and renders rows with the thread hint", async () => {
    const calls: Calls = {};
    const gathered = await gatherRunList({
      client: fakeClient(calls),
      headers,
      projectId: PROJECT_ID,
      pipeline: "ship-it",
      status: "failed",
      limit: 1,
    });

    expect(calls.listQuery).toEqual({
      projectId: PROJECT_ID,
      pipelineId: PIPELINE_ID,
      workItemId: undefined,
      status: "failed",
      sort: "newest",
      page: 1,
      pageSize: 1,
    });
    expect(formatRunList(gathered)).toMatchInlineSnapshot(`
"Pipeline runs (1 of 3), newest first
  ✗ 0196a000…00bb  ship-it  Fix login
      0196a000-0000-7000-8000-0000000000bb  failed  finished 2026-01-02T00:10:00.000Z
      work item 0196a000-0000-7000-8000-0000000000aa
      error: StepFailed: build failed
  … 2 more; raise --limit or narrow the filters

→ scarn runs thread 0196a000-0000-7000-8000-0000000000bb --step <key>"
`);
  });

  test("says so when nothing matches", () => {
    expect(
      formatRunList({
        page: { items: [], pagination: { page: 1, pageSize: 25, total: 0 } },
        pipelineKeys: {},
      }),
    ).toBe("No pipeline runs match.");
  });
});

describe("runs thread", () => {
  test("fetches the resolved visit's thread and renders every run", async () => {
    const calls: Calls = {};
    const gathered = await gatherVisitThread({
      client: fakeClient(calls),
      headers,
      runId: RUN_ID,
      stepKey: "build",
    });

    expect(calls.threadPath).toEqual({
      pipelineExecutionId: RUN_ID,
      visitId: "visit-2",
    });
    expect(formatVisitThread(gathered)).toMatchInlineSnapshot(`
"Thread of step "build" in pipeline run 0196a000-0000-7000-8000-0000000000bb
Visit:   visit-2  ✓ succeeded  (attempt 2 of 3)
Created: 2026-01-02T00:02:00.000Z

Run 1  ✗ failed  run-1  2026-01-02T00:02:00.000Z
  (no messages)

Run 2  ● running  run-2  2026-01-02T00:05:00.000Z  session restored
  2026-01-02T00:04:00.000Z  from user-1
    > listening on 3000
    Try the other port.
    Thanks

→ scarn logs run-2"
`);
  });

  test("refuses wait nodes, which have no thread", async () => {
    let message = "";
    try {
      await gatherVisitThread({
        client: fakeClient({}),
        headers,
        runId: RUN_ID,
        stepKey: "approve",
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('"approve" is a wait node');
  });
});
