import { describe, expect, setDefaultTimeout, test } from "bun:test";
import type {
  OverrulePreview,
  OverruleRequest,
  RunActionClient,
  RunWithVisits,
} from "@scarn/shared-core";
import { createRunsCommand } from "../src/commands/runs";
import { CliError } from "../src/lib/cli-error";
import {
  fakeIo,
  ok,
  rejection,
  runAction,
  unusedReads,
  type FakeIo,
} from "./action-harness";

setDefaultTimeout(15_000);

const RUN_ID = "0196a000-0000-7000-8000-0000000000bb";

const when = (path: string) => ({ path, op: "equal", value: true });

const FIRST_NEXT = {
  routes: [{ when: when("result.rejected"), to: "fix", label: "fix" }],
  otherwise: { to: "done", label: "ship" },
  overridable: true,
};

const ALL_NEXT = {
  match: "all",
  overridable: true,
  routes: [
    { when: when("result.docs"), to: "docs", label: "docs" },
    { when: when("result.lint"), to: "lint" },
    { to: "fix" },
  ],
  otherwise: { to: "done" },
};

const PREVIEW: OverrulePreview = {
  superseded: [{ visitId: "v-done", nodeId: "done", status: "succeeded" }],
  cancelledTasks: 2,
  lanesAdded: [{ route: { kind: "route", index: 1 } }],
  lanesRemoved: [{ route: { kind: "route", index: 0 }, label: "docs" }],
  mergesRerun: ["join"],
  started: ["fix"],
  reopensRun: true,
  missing: [],
};

type Taken = { kind: "route" | "otherwise"; index: number }[];

function makeRun(taken: Taken): RunWithVisits {
  return {
    id: RUN_ID,
    workItemId: "0196a000-0000-7000-8000-0000000000aa",
    workItemTitle: "Fix login",
    pipelineDefinitionId: "pd-1",
    pipelineDefinitionVersionId: "pdv-1",
    status: "succeeded",
    visits: [
      {
        id: "v-check",
        nodeId: "check",
        nodeKind: "step",
        status: "succeeded",
        routing: { checked: [], taken },
        tasks: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        completedAt: null,
      },
    ],
  };
}

type Refusal = { code: string; detail: string; meta: Record<string, unknown> };

function setup(
  io: FakeIo,
  options: { next: Record<string, unknown>; taken: Taken; refuse?: Refusal },
) {
  const bodies: OverruleRequest[] = [];
  const run = makeRun(options.taken);
  const client: RunActionClient = {
    pipelineExecutions: {
      getPipelineExecution: () => ok(run),
      rerunPipelineExecutionVisit: () => ok(run),
      sendVisitMessage: () => Promise.reject(new Error("unused")),
      cancelPipelineExecution: () => ok(run),
      overrulePipelineExecutionRoute: ({ body }) => {
        bodies.push(body);
        if (options.refuse !== undefined && !body.acceptMissing) {
          return Promise.resolve({
            data: undefined,
            error: { status: 422, title: "Unprocessable", ...options.refuse },
          });
        }
        return body.preview ? ok({ preview: PREVIEW }) : ok(run);
      },
    },
    pipelineDefinitions: {
      listPipelineDefinitionVersions: () =>
        ok([
          {
            id: "pdv-1",
            pipelineDefinitionId: "pd-1",
            version: 3,
            schemaVersion: 1,
            contentHash: "h",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ]),
      getPipelineDefinitionVersion: () =>
        ok({
          id: "pdv-1",
          pipelineDefinitionId: "pd-1",
          version: 3,
          schemaVersion: 1,
          contentHash: "h",
          definition: {
            nodes: {
              check: { kind: "step", step: "check", next: options.next },
            },
          },
          steps: [],
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
    },
  };
  const command = createRunsCommand(unusedReads, {
    connect: () =>
      Promise.resolve({ client, headers: { Authorization: "Bearer t" } }),
    io,
  });
  return {
    bodies,
    run: (args: readonly string[]) =>
      runAction(command, ["runs", "route", RUN_ID, "--step", "check", ...args]),
  };
}

const first = {
  next: FIRST_NEXT,
  taken: [{ kind: "otherwise" as const, index: 0 }],
};
const all = {
  next: ALL_NEXT,
  taken: [
    { kind: "route" as const, index: 0 },
    { kind: "route" as const, index: 2 },
  ],
};

describe("scarn runs route", () => {
  test("without a choice it lists the routes taken and the ones it could take", async () => {
    const { bodies, run } = setup(fakeIo(), first);

    const stdout = await run([]);

    expect(stdout).toContain('Took: otherwise "ship" → done');
    expect(stdout).toContain('○ routes[0] "fix" → fix  [overridable]');
    expect(stdout).toContain('● otherwise "ship" → done  [taken, overridable]');
    expect(stdout).toContain(
      `→ scarn runs route ${RUN_ID} --step check (--to <node> | --label <label> | --otherwise) --reason <text>`,
    );
    expect(bodies).toEqual([]);
  });

  test("match: first previews, asks with the summary, then applies --to", async () => {
    const io = fakeIo({ answer: true });
    const { bodies, run } = setup(io, first);

    const stdout = await run([
      "--to",
      "fix",
      "--reason",
      "The check was wrong",
    ]);

    expect(bodies.map((body) => body.preview)).toEqual([true, false]);
    expect(bodies[1]).toMatchObject({
      routes: [{ kind: "route", index: 0 }],
      reason: "The check was wrong",
      acceptMissing: false,
    });
    expect(io.asked[0]).toContain('to take routes[0] "fix" → fix?');
    expect(io.asked[0]).toContain("Starts: fix");
    expect(io.asked[0]).toContain("Tasks cancelled: 2");
    expect(io.asked[0]).toContain("Reopens the run: yes");
    expect(stdout).toContain(`→ scarn runs thread ${RUN_ID} --step fix`);
  });

  test("match: all builds the full set from --add/--remove and works out otherwise", async () => {
    const io = fakeIo({ files: { "why.md": "Lint matters more\n" } });
    const { bodies, run } = setup(io, all);

    await run([
      "--add",
      "lint",
      "--remove",
      "docs",
      "--reason",
      "@why.md",
      "--yes",
    ]);

    expect(bodies[1]?.reason).toBe("Lint matters more");
    expect(bodies[1]?.routes).toEqual([
      { kind: "route", index: 1 },
      { kind: "route", index: 2 },
    ]);
    expect(io.asked[0]).toContain("Lanes started: routes[1] → lint");
    expect(io.asked[0]).toContain("Lanes cancelled: docs");
    expect(io.asked[0]).toContain("Merges that run again: join");

    const removeAll = setup(fakeIo(), all);
    await removeAll.run(["--remove", "docs", "--reason", "No docs", "--yes"]);
    expect(removeAll.bodies[1]?.routes).toEqual([
      { kind: "route", index: 2 },
      { kind: "otherwise" },
    ]);
  });

  test("the wrong flags for the node's match mode are invalid_usage with a hint", async () => {
    const onAll = await rejection(
      setup(fakeIo(), all).run(["--to", "lint", "--reason", "r", "--yes"]),
    );
    expect((onAll as CliError).code).toBe("invalid_usage");
    expect(onAll.message).toContain("--add <label|node>... --remove");

    const onFirst = await rejection(
      setup(fakeIo(), first).run(["--add", "fix", "--reason", "r", "--yes"]),
    );
    expect((onFirst as CliError).code).toBe("invalid_usage");
    expect(onFirst.message).toContain(
      "(--to <node> | --label <label> | --otherwise)",
    );
  });

  test("a route that isn't overridable is named, pointing at runs rerun", async () => {
    const { bodies, run } = setup(fakeIo(), {
      ...first,
      refuse: {
        code: "PIPELINE_RUN_ROUTE_NOT_OVERRIDABLE",
        detail: "These routes can't be overruled.",
        meta: { routes: [{ kind: "otherwise", index: 0 }] },
      },
    });

    const error = await rejection(
      run(["--to", "fix", "--reason", "r", "--yes"]),
    );

    expect((error as CliError).code).toBe("action_rejected");
    expect(error.message).toContain('Not overridable: otherwise "ship" → done');
    expect(error.message).toContain(`scarn runs rerun ${RUN_ID} --step check`);
    expect(bodies).toHaveLength(1);
  });

  test("missing args print the command to rerun with --accept-missing, which goes through", async () => {
    const refuse = {
      code: "PIPELINE_RUN_ROUTE_ARGS_MISSING",
      detail: "Some args resolve to nothing.",
      meta: { missing: [{ arg: "note", reference: "result.note" }] },
    };
    const refused = setup(fakeIo(), { ...first, refuse });

    const error = await rejection(
      refused.run(["--label", "fix", "--reason", "Fix it anyway", "--yes"]),
    );

    expect((error as CliError).code).toBe("action_rejected");
    expect(error.message).toContain("  note (result.note)");
    expect(error.message).toContain(
      `scarn runs route ${RUN_ID} --step check --label fix --reason 'Fix it anyway' --accept-missing`,
    );

    const accepted = setup(fakeIo(), { ...first, refuse });
    await accepted.run([
      "--label",
      "fix",
      "--reason",
      "Fix it anyway",
      "--accept-missing",
      "--yes",
    ]);
    expect(
      accepted.bodies.map((body) => [body.preview, body.acceptMissing]),
    ).toEqual([
      [true, true],
      [false, true],
    ]);
  });

  test("off a TTY without --yes it refuses with confirmation_required", async () => {
    const io = fakeIo();
    io.confirm = () =>
      Promise.reject(new CliError("confirmation_required", "pass --yes"));
    const { bodies, run } = setup(io, first);

    const error = await rejection(run(["--otherwise", "--reason", "r"]));

    expect((error as CliError).code).toBe("confirmation_required");
    expect(bodies.map((body) => body.preview)).toEqual([true]);
  });

  test("declining applies nothing, and a choice needs --reason", async () => {
    const declined = setup(fakeIo({ answer: false }), first);
    await declined.run(["--to", "fix", "--reason", "r"]);
    expect(declined.bodies.map((body) => body.preview)).toEqual([true]);

    const error = await rejection(setup(fakeIo(), first).run(["--to", "fix"]));
    expect((error as CliError).code).toBe("invalid_usage");
  });
});
