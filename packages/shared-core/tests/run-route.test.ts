import { describe, expect, test } from "bun:test";
import type { RunActionClient } from "../src/lib/action-clients";
import { ActionError } from "../src/lib/action-error";
import type { RunWithVisits } from "../src/lib/run-api-types";
import {
  formatOverrulePreview,
  formatRouteContext,
} from "../src/format-run-route";
import {
  loadRouteContext,
  overruleRoute,
  planOverrule,
  previewOverrule,
  RouteRefusal,
  type RouteContext,
} from "../src/run-route";

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error("expected the promise to reject with an Error");
}

const ok = <T>(data: T) => Promise.resolve({ data, error: undefined });

const document = (next: Record<string, unknown>) => ({
  schemaVersion: 1,
  key: "review",
  start: { to: "check" },
  nodes: {
    check: { kind: "step", step: "check", next },
    fix: { kind: "step", step: "fix" },
    docs: { kind: "step", step: "docs" },
    lint: { kind: "step", step: "lint" },
    done: { kind: "succeed" },
  },
});

const firstNext = {
  routes: [
    {
      when: { path: "result.verdict", op: "equal", value: "rejected" },
      to: "fix",
      label: "fix",
      overridable: true,
    },
  ],
  otherwise: { to: "done", label: "ship", overridable: true },
};

const allNext = {
  match: "all",
  overridable: true,
  routes: [
    { when: { path: "result.docs", op: "equal", value: true }, to: "docs" },
    { when: { path: "result.lint", op: "equal", value: true }, to: "lint" },
    { to: "fix" },
  ],
  otherwise: { to: "done" },
};

function makeRun(taken: { kind: "route" | "otherwise"; index: number }[]) {
  return {
    id: "run-1",
    workItemId: "wi-1",
    workItemTitle: "Fix login",
    pipelineDefinitionId: "pd-1",
    pipelineDefinitionVersionId: "pdv-2",
    status: "succeeded",
    visits: [
      {
        id: "v-check",
        nodeId: "check",
        nodeKind: "step",
        status: "succeeded",
        routing: {
          checked: [
            {
              index: 0,
              matched: false,
              when: {
                kind: "compare",
                result: false,
                left: { path: "result.verdict", value: "approved" },
                op: "equal",
                right: { value: "rejected" },
              },
            },
          ],
          taken,
        },
        tasks: [],
        createdAt: "2026-01-01",
        completedAt: null,
      },
    ],
  } satisfies RunWithVisits;
}

function client(
  next: Record<string, unknown>,
  taken: { kind: "route" | "otherwise"; index: number }[],
  overrule: RunActionClient["pipelineExecutions"]["overrulePipelineExecutionRoute"] = () =>
    Promise.reject(new Error("unused")),
): RunActionClient {
  const run = makeRun(taken);
  return {
    pipelineExecutions: {
      getPipelineExecution: () => ok(run),
      rerunPipelineExecutionVisit: () => ok(run),
      sendVisitMessage: () => Promise.reject(new Error("unused")),
      cancelPipelineExecution: () => ok(run),
      overrulePipelineExecutionRoute: overrule,
    },
    pipelineDefinitions: {
      listPipelineDefinitionVersions: () =>
        ok([
          {
            id: "pdv-1",
            pipelineDefinitionId: "pd-1",
            version: 1,
            schemaVersion: 1,
            contentHash: "a",
            createdAt: "x",
          },
          {
            id: "pdv-2",
            pipelineDefinitionId: "pd-1",
            version: 2,
            schemaVersion: 1,
            contentHash: "b",
            createdAt: "x",
          },
        ]),
      getPipelineDefinitionVersion: ({ path }) =>
        path.version === 2
          ? ok({
              id: "pdv-2",
              pipelineDefinitionId: "pd-1",
              version: 2,
              schemaVersion: 1,
              contentHash: "b",
              definition: document(next),
              steps: [],
              createdAt: "x",
            })
          : Promise.reject(new Error("wrong version")),
    },
  };
}

const load = (actionClient: RunActionClient) =>
  loadRouteContext({
    client: actionClient,
    runId: "run-1",
    stepKey: "check",
    attempt: undefined,
  });

describe("loadRouteContext", () => {
  test("reads the pinned version's routes with what was checked and taken", async () => {
    const context = await load(
      client(firstNext, [{ kind: "otherwise", index: 0 }]),
    );

    expect(context.match).toBe("first");
    expect(
      context.options.map(({ kind, to, label, taken, overridable }) => ({
        kind,
        to,
        label,
        taken,
        overridable,
      })),
    ).toEqual([
      {
        kind: "route",
        to: "fix",
        label: "fix",
        taken: false,
        overridable: true,
      },
      {
        kind: "otherwise",
        to: "done",
        label: "ship",
        taken: true,
        overridable: true,
      },
    ]);
    const text = formatRouteContext(context).join("\n");
    expect(text).toContain('Took: otherwise "ship" → done');
    expect(text).toContain(
      'did not match: result.verdict equal "rejected" (was "approved")',
    );
  });

  test("under match: all, a route without when is never overridable", async () => {
    const context = await load(client(allNext, []));

    expect(context.options.map((option) => option.overridable)).toEqual([
      true,
      true,
      false,
      true,
    ]);
  });
});

describe("planOverrule", () => {
  test("match: first sends the one route picked by --to, --label or --otherwise", async () => {
    const context = await load(
      client(firstNext, [{ kind: "otherwise", index: 0 }]),
    );

    expect(planOverrule(context, { kind: "to", node: "fix" }).routes).toEqual([
      { kind: "route", index: 0 },
    ]);
    expect(
      planOverrule(context, { kind: "label", label: "ship" }).routes,
    ).toEqual([{ kind: "otherwise" }]);
    expect(planOverrule(context, { kind: "otherwise" }).routes).toEqual([
      { kind: "otherwise" },
    ]);
    expect(() => planOverrule(context, { kind: "to", node: "lint" })).toThrow(
      'Step "check" has no route to "lint"',
    );
  });

  test("match: all builds the full set and works out otherwise", async () => {
    const taken = [
      { kind: "route" as const, index: 0 },
      { kind: "route" as const, index: 2 },
    ];
    const context: RouteContext = await load(client(allNext, taken));

    expect(
      planOverrule(context, { kind: "change", add: ["lint"], remove: [] })
        .routes,
    ).toEqual([
      { kind: "route", index: 0 },
      { kind: "route", index: 1 },
      { kind: "route", index: 2 },
    ]);
    expect(
      planOverrule(context, { kind: "change", add: [], remove: ["docs"] })
        .routes,
    ).toEqual([{ kind: "route", index: 2 }, { kind: "otherwise" }]);
    expect(() =>
      planOverrule(context, { kind: "change", add: [], remove: ["fix"] }),
    ).toThrow("has no when, so it always runs");
  });
});

describe("previewOverrule and overruleRoute", () => {
  test("send the routes with preview on, then off", async () => {
    const bodies: unknown[] = [];
    const preview = {
      superseded: [],
      cancelledTasks: 0,
      lanesAdded: [],
      lanesRemoved: [],
      mergesRerun: [],
      started: ["fix"],
      reopensRun: true,
      missing: [],
    };
    const actionClient = client(
      firstNext,
      [{ kind: "otherwise", index: 0 }],
      ({ body }) => {
        bodies.push(body);
        return body.preview ? ok({ preview }) : ok(makeRun([]));
      },
    );
    const context = await load(actionClient);
    const options = {
      client: actionClient,
      runId: "run-1",
      visitId: "v-check",
      stepKey: "check",
      routes: [{ kind: "route" as const, index: 0 }],
      reason: "The verdict is wrong",
      acceptMissing: false,
    };

    expect(await previewOverrule(options)).toEqual(preview);
    expect((await overruleRoute(options)).id).toBe("run-1");
    expect(bodies).toEqual([
      {
        routes: options.routes,
        reason: options.reason,
        acceptMissing: false,
        preview: true,
      },
      {
        routes: options.routes,
        reason: options.reason,
        acceptMissing: false,
        preview: false,
      },
    ]);
    expect(formatOverrulePreview(context, preview)).toContain(
      "  Reopens the run: yes",
    );
  });

  test("a 422 becomes a RouteRefusal carrying its code and meta", async () => {
    const actionClient = client(firstNext, [], () =>
      Promise.resolve({
        data: undefined,
        error: {
          status: 422,
          detail: "Args are missing.",
          code: "PIPELINE_RUN_ROUTE_ARGS_MISSING",
          meta: { missing: [{ arg: "note", reference: "result.note" }] },
        },
      }),
    );

    const error = await rejection(
      previewOverrule({
        client: actionClient,
        runId: "run-1",
        visitId: "v-check",
        stepKey: "check",
        routes: [{ kind: "route", index: 0 }],
        reason: "r",
        acceptMissing: false,
      }),
    );

    expect(error).toBeInstanceOf(RouteRefusal);
    expect(error).toBeInstanceOf(ActionError);
    expect((error as RouteRefusal).code).toBe(
      "PIPELINE_RUN_ROUTE_ARGS_MISSING",
    );
    expect((error as RouteRefusal).missing).toEqual([
      { arg: "note", reference: "result.note" },
    ]);
  });
});
