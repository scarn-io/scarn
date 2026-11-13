import { describe, expect, setDefaultTimeout, test } from "bun:test";
import type { RunActionClient, RunWithVisits } from "@scarn/shared-core";
import { createRunsCommand } from "../src/commands/runs";
import { CliError } from "../src/lib/cli-error";
import {
  fail,
  fakeIo,
  ok,
  rejection,
  runAction,
  unusedReads,
  type FakeIo,
} from "./action-harness";

setDefaultTimeout(15_000);

const RUN_ID = "0196a000-0000-7000-8000-0000000000bb";

const visit = (
  id: string,
  nodeId: string,
  status: string,
  createdAt: string,
) => ({
  id,
  nodeId,
  nodeKind: "step" as const,
  status,
  tasks: [],
  createdAt,
  completedAt: null,
});

const baseRun: RunWithVisits = {
  id: RUN_ID,
  workItemId: "0196a000-0000-7000-8000-0000000000aa",
  workItemTitle: "Fix login",
  pipelineDefinitionId: "0196a000-0000-7000-8000-0000000000d1",
  status: "failed",
  visits: [
    visit("v-build-1", "build", "failed", "2026-01-01T00:00:00.000Z"),
    visit("v-build-2", "build", "failed", "2026-01-02T00:00:00.000Z"),
    visit("v-lint-1", "lint", "failed", "2026-01-03T00:00:00.000Z"),
    visit("v-test-1", "test", "succeeded", "2026-01-04T00:00:00.000Z"),
  ],
};

type Calls = {
  reruns: string[];
  messages: { visitId: string; body: string }[];
  cancels: string[];
};

type Overrides = Partial<RunActionClient["pipelineExecutions"]>;

function setup(io: FakeIo, overrides: Overrides = {}) {
  const calls: Calls = { reruns: [], messages: [], cancels: [] };
  const client: RunActionClient = {
    pipelineExecutions: {
      getPipelineExecution: () => ok(baseRun),
      rerunPipelineExecutionVisit: ({ path }) => {
        calls.reruns.push(path.visitId);
        return ok({
          ...baseRun,
          visits: [
            ...baseRun.visits,
            visit(`new-${path.visitId}`, "build", "active", "2026-02-01"),
          ],
        });
      },
      sendVisitMessage: ({ path, body }) => {
        calls.messages.push({ visitId: path.visitId, body: body.body });
        return ok({
          message: {
            id: "msg-1",
            taskId: "task-9",
            body: body.body,
            createdAt: "2026-02-01T00:00:00.000Z",
          },
          pipelineExecution: baseRun,
        });
      },
      cancelPipelineExecution: ({ path }) => {
        calls.cancels.push(path.pipelineExecutionId);
        return ok({ ...baseRun, status: "cancelled" });
      },
      ...overrides,
    },
  };
  const command = createRunsCommand(unusedReads, {
    connect: () =>
      Promise.resolve({ client, headers: { Authorization: "Bearer t" } }),
    io,
  });
  return {
    calls,
    run: (args: readonly string[]) => runAction(command, ["runs", ...args]),
  };
}

describe("scarn runs rerun", () => {
  test("--step reruns the latest visit after confirming", async () => {
    const io = fakeIo({ answer: true });
    const { calls, run } = setup(io);

    const stdout = await run(["rerun", RUN_ID, "--step", "build"]);

    expect(calls.reruns).toEqual(["v-build-2"]);
    expect(io.asked[0]).toContain('step "build" attempt 2 (visit v-build-2');
    expect(stdout).toContain("→ new visit new-v-build-2");
    expect(stdout).toContain(`→ scarn runs thread ${RUN_ID} --step build`);
  });

  test("declining at the prompt reruns nothing", async () => {
    const { calls, run } = setup(fakeIo({ answer: false }));

    expect(await run(["rerun", RUN_ID, "--step", "build"])).toBe("");
    expect(calls.reruns).toEqual([]);
  });

  test("off a TTY without --yes it refuses with confirmation_required", async () => {
    const io = fakeIo();
    io.confirm = () =>
      Promise.reject(new CliError("confirmation_required", "pass --yes"));
    const { calls, run } = setup(io);

    const error = await rejection(run(["rerun", RUN_ID, "--step", "build"]));

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe("confirmation_required");
    expect(calls.reruns).toEqual([]);
  });

  test("--failed confirms once listing every failed step, then reruns each", async () => {
    const io = fakeIo();
    const { calls, run } = setup(io);

    await run(["rerun", RUN_ID, "--failed", "--yes"]);

    expect(io.asked).toHaveLength(1);
    expect(io.asked[0]).toContain("Rerun 3 visit(s)");
    expect(io.asked[0]).toContain("v-lint-1");
    expect(calls.reruns).toEqual(["v-build-1", "v-build-2", "v-lint-1"]);
  });

  test("--failed skips visits an earlier rerun already superseded", async () => {
    const { calls, run } = setup(fakeIo(), {
      rerunPipelineExecutionVisit: ({ path }) => {
        calls.reruns.push(path.visitId);
        return ok({
          ...baseRun,
          visits: baseRun.visits.map((v) =>
            v.id === "v-lint-1" ? { ...v, status: "superseded" } : v,
          ),
        });
      },
    });

    const stdout = await run(["rerun", RUN_ID, "--failed", "--yes"]);

    expect(calls.reruns).toEqual(["v-build-1", "v-build-2"]);
    expect(stdout).toContain('Skipped step "lint"');
  });

  test("needs exactly one of --step or --failed", async () => {
    const { run } = setup(fakeIo());

    for (const args of [
      ["rerun", RUN_ID],
      ["rerun", RUN_ID, "--step", "build", "--failed"],
    ]) {
      const error = await rejection(run(args));
      expect((error as CliError).code).toBe("invalid_usage");
    }
  });

  test("an unknown step is action_not_found", async () => {
    const { run } = setup(fakeIo());

    const error = await rejection(
      run(["rerun", RUN_ID, "--step", "deploy", "--yes"]),
    );

    expect((error as CliError).code).toBe("action_not_found");
    expect(error.message).toContain('Step "deploy" has no visits');
  });

  test("a 409 from the API is action_conflict with its detail", async () => {
    const { run } = setup(fakeIo(), {
      rerunPipelineExecutionVisit: () => fail(409, "The run is still active."),
    });

    const error = await rejection(
      run(["rerun", RUN_ID, "--step", "lint", "--yes"]),
    );

    expect((error as CliError).code).toBe("action_conflict");
    expect(error.message).toBe(
      'Could not rerun step "lint" (visit v-lint-1): The run is still active.',
    );
  });

  test("a missing run is action_not_found", async () => {
    const { run } = setup(fakeIo(), {
      getPipelineExecution: () => fail(404, "nope"),
    });

    const error = await rejection(
      run(["rerun", RUN_ID, "--step", "lint", "--yes"]),
    );

    expect((error as CliError).code).toBe("action_not_found");
    expect(error.message).toBe(`Pipeline run ${RUN_ID} not found.`);
  });
});

describe("scarn runs message", () => {
  test("sends the body without asking and hints at the thread and new Task", async () => {
    const io = fakeIo();
    const { calls, run } = setup(io);

    const stdout = await run([
      "message",
      RUN_ID,
      "--step",
      "build",
      "--attempt",
      "1",
      "--body",
      "Try again with the cache cleared.",
    ]);

    expect(io.asked).toEqual([]);
    expect(calls.messages).toEqual([
      { visitId: "v-build-1", body: "Try again with the cache cleared." },
    ]);
    expect(stdout).toContain("New Task: task-9");
    expect(stdout).toContain(`→ scarn runs thread ${RUN_ID} --step build`);
    expect(stdout).toContain("→ scarn tasks view task-9");
  });

  test("--body @file and --body - read the file and stdin", async () => {
    const io = fakeIo({
      files: { "note.md": "From a file\n" },
      stdin: "Piped",
    });
    const { calls, run } = setup(io);

    await run(["message", RUN_ID, "--step", "lint", "--body", "@note.md"]);
    await run(["message", RUN_ID, "--step", "lint", "--body", "-"]);

    expect(calls.messages.map((message) => message.body)).toEqual([
      "From a file",
      "Piped",
    ]);
  });

  test("an unreadable --body file is body_unreadable", async () => {
    const { calls, run } = setup(fakeIo());

    const error = await rejection(
      run(["message", RUN_ID, "--step", "lint", "--body", "@missing.md"]),
    );

    expect((error as CliError).code).toBe("body_unreadable");
    expect(calls.messages).toEqual([]);
  });

  test("a 422 from the API is action_rejected", async () => {
    const { run } = setup(fakeIo(), {
      sendVisitMessage: () => fail(422, "Code steps don't accept messages."),
    });

    const error = await rejection(
      run(["message", RUN_ID, "--step", "lint", "--body", "hi"]),
    );

    expect((error as CliError).code).toBe("action_rejected");
    expect(error.message).toContain("Code steps don't accept messages.");
  });
});

describe("scarn runs cancel", () => {
  test("confirms, cancels and prints the --json body", async () => {
    const io = fakeIo({ answer: true });
    const { calls, run } = setup(io);

    const stdout = await run(["cancel", RUN_ID, "--json"]);

    expect(io.asked[0]).toBe(
      `Cancel pipeline run ${RUN_ID} (failed) of "Fix login"?`,
    );
    expect(calls.cancels).toEqual([RUN_ID]);
    expect((JSON.parse(stdout) as { status: string }).status).toBe("cancelled");
  });

  test("declining cancels nothing", async () => {
    const { calls, run } = setup(fakeIo({ answer: false }));

    await run(["cancel", RUN_ID]);

    expect(calls.cancels).toEqual([]);
  });
});
