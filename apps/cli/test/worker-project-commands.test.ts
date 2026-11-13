/**
 * `scarn worker add|remove|cancel` and the `scarn work` shortcut against a
 * real control server backed by a fake supervisor: what each command sends
 * the worker, the base-URL and version checks, `cancel` asking the server
 * before the worker, and `work` starting the worker before adding to it.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import type { TaskDetail, TaskRunDetail } from "@scarn/shared-core";
import { runWorkerAdd } from "../src/commands/worker/add";
import {
  PIPELINE_CANCEL_QUESTION,
  runWorkerCancel,
  type CancelClient,
} from "../src/commands/worker/cancel";
import { runWorkerRemove } from "../src/commands/worker/remove";
import {
  WorkerNotRunningError,
  WorkerVersionMismatchError,
} from "../src/commands/worker/worker-errors";
import { runWorkShortcut } from "../src/commands/work";
import type { CliError } from "../src/lib/cli-error";
import { fakeIo, ok, rejection } from "./action-harness";
import { FAKE_PROJECT_ID } from "./worker-host-fakes";
import {
  BASE_URL,
  INSTANCE,
  addArguments,
  captureOutput,
  projectDeps,
  projectStatus,
  settingsFor,
  useWorkerProjectHarness,
} from "./worker-project-harness";

setDefaultTimeout(20_000);

const TASK_ID = "0196a000-0000-7000-8000-0000000000c1";

const h = useWorkerProjectHarness();

describe("worker add", () => {
  test("sends the checkout's settings over PUT /projects/:projectId", async () => {
    h.startWorker();
    const output = await captureOutput(() =>
      runWorkerAdd(addArguments, projectDeps()),
    );
    expect(h.supervisor.added).toEqual([settingsFor(BASE_URL)]);
    expect(output).toContain(
      `Added acme/app (/repos/app @ main) to worker instance ${INSTANCE}.`,
    );
    expect(output).toContain(`${INSTANCE} worker status`);
    expect(output).toContain(`${INSTANCE} worker logs acme/app -f`);
  });

  test("warns when the project could not start yet", async () => {
    h.startWorker();
    h.supervisor.addResult = {
      outcome: "added",
      project: {
        ...projectStatus(),
        state: "error",
        errorReason: "repo_missing",
        errorMessage: "The repo directory /repos/app no longer exists.",
      },
    };
    const output = await captureOutput(() =>
      runWorkerAdd(addArguments, projectDeps()),
    );
    expect(output).toContain(
      "acme/app could not start yet: The repo directory /repos/app no longer exists.",
    );
  });

  test("refuses a project on another server than the instance's", async () => {
    h.startWorker();
    const error = await rejection(
      runWorkerAdd(addArguments, projectDeps("https://other.test")),
    );
    expect((error as CliError).code).toBe("worker_base_url_mismatch");
    expect(h.supervisor.added).toEqual([]);
  });

  test("fails with exit code 3 when no worker runs", async () => {
    const error = await rejection(runWorkerAdd(addArguments, projectDeps()));
    expect(error).toBeInstanceOf(WorkerNotRunningError);
  });

  test("checks the worker's version", async () => {
    h.startWorker("0.0.1-old");
    const error = await rejection(runWorkerAdd(addArguments, projectDeps()));
    expect(error).toBeInstanceOf(WorkerVersionMismatchError);
  });

  test("refuses a run outside a git repository and a missing login", async () => {
    h.startWorker();
    const notARepo = await rejection(
      runWorkerAdd(addArguments, {
        ...projectDeps(),
        findGitRoot: () => Promise.resolve(null),
      }),
    );
    expect((notARepo as CliError).code).toBe("not_in_git_repo");
    const signedOut = await rejection(
      runWorkerAdd(addArguments, {
        ...projectDeps(),
        resolveUserId: () => Promise.resolve(null),
      }),
    );
    expect((signedOut as CliError).code).toBe("not_signed_in_noninteractive");
  });
});

describe("worker remove", () => {
  test("removes a project by ref and names the runs still draining", async () => {
    h.startWorker();
    h.supervisor.removeResult = {
      removed: true,
      drainingRuns: [
        {
          taskRunId: "run-1",
          projectId: FAKE_PROJECT_ID,
          taskName: "Fix the bug",
          phase: "running",
          startedAt: "2026-11-12T00:00:00.000Z",
        },
      ],
    };
    const output = await captureOutput(() =>
      runWorkerRemove({ project: "acme/app" }),
    );
    expect(h.events).toEqual([`remove ${FAKE_PROJECT_ID}`]);
    expect(output).toContain(
      `Removed acme/app from worker instance ${INSTANCE}.`,
    );
    expect(output).toContain("Draining 1 run: Fix the bug (run-1)");
  });

  test("refuses a project the worker does not have", async () => {
    h.startWorker();
    const error = await rejection(runWorkerRemove({ project: "acme/missing" }));
    expect((error as CliError).code).toBe("project_not_found");
    expect(h.events).toEqual([]);
  });

  test("checks the worker's version", async () => {
    h.startWorker("0.0.1-old");
    const error = await rejection(runWorkerRemove({ project: "acme/app" }));
    expect(error).toBeInstanceOf(WorkerVersionMismatchError);
  });
});

describe("worker cancel", () => {
  function cancelClient(task: Partial<TaskDetail>): CancelClient {
    return {
      taskRuns: {
        getTaskRun: () =>
          ok({ id: "run-1", taskId: TASK_ID } as unknown as TaskRunDetail),
        listTaskArtifacts: () => ok([]),
      },
      tasks: {
        getTask: () =>
          ok({
            id: TASK_ID,
            kind: "prompt",
            pipelineRunId: null,
            ...task,
          } as unknown as TaskDetail),
        getTaskRuns: () => ok([]),
        retryTask: () => ok({ taskId: TASK_ID, taskRunId: null }),
        cancelTask: ({ path: { taskId } }) => {
          h.events.push(`server cancel ${taskId}`);
          return ok({ taskId });
        },
      },
    };
  }

  function cancel(
    task: Partial<TaskDetail> = {},
    options: { yes?: boolean; answer?: boolean } = {},
  ) {
    const io = fakeIo({ answer: options.answer ?? false });
    const done = captureOutput(() =>
      runWorkerCancel(
        { taskRunId: "run-1", yes: options.yes ?? false, baseUrl: BASE_URL },
        {
          connect: () =>
            Promise.resolve({
              client: cancelClient(task),
              headers: { Authorization: "Bearer t" },
            }),
          io,
        },
      ),
    );
    return { io, done };
  }

  test("cancels on the server before stopping the run on the local worker", async () => {
    h.startWorker();
    const { io, done } = cancel();
    const output = await done;
    expect(io.asked).toEqual([]);
    expect(h.events).toEqual([`server cancel ${TASK_ID}`, "abort run-1"]);
    expect(output).toContain(
      `Cancelled Task ${TASK_ID} and stopped run run-1 on worker instance ${INSTANCE}.`,
    );
  });

  test("still cancels on the server when no local worker runs", async () => {
    const output = await cancel().done;
    expect(h.events).toEqual([`server cancel ${TASK_ID}`]);
    expect(output).toContain(
      "whichever worker owns it stops it on its next heartbeat",
    );
  });

  test("a run on another worker is left to its heartbeat", async () => {
    h.startWorker();
    h.supervisor.runFound = false;
    const output = await cancel().done;
    expect(h.events).toEqual([`server cancel ${TASK_ID}`, "abort run-1"]);
    expect(output).toContain("Run run-1 is not on worker instance");
  });

  test("a local worker of another version only gets a warning", async () => {
    h.startWorker("0.0.1-old");
    const output = await cancel().done;
    expect(h.events).toEqual([`server cancel ${TASK_ID}`]);
    expect(output).toContain("The running worker is version 0.0.1-old");
  });

  test("refuses a code Task before asking anything", async () => {
    h.startWorker();
    const { io, done } = cancel({ kind: "code", pipelineRunId: "pr-1" });
    const error = await rejection(done);
    expect((error as CliError).code).toBe("action_rejected");
    expect(error.message).toBe(
      `Task ${TASK_ID} is a code Task, which can't be stopped`,
    );
    expect(io.asked).toEqual([]);
    expect(h.events).toEqual([]);
  });

  test("asks before cancelling a pipeline-owned Task", async () => {
    h.startWorker();
    const declined = cancel({ pipelineRunId: "pr-1" });
    expect(await declined.done).toContain("Nothing was cancelled.");
    expect(declined.io.asked).toEqual([PIPELINE_CANCEL_QUESTION]);
    expect(h.events).toEqual([]);

    await cancel({ pipelineRunId: "pr-1" }, { yes: true }).done;
    expect(h.events).toEqual([`server cancel ${TASK_ID}`, "abort run-1"]);
  });
});

describe("scarn work", () => {
  test("starts the worker when none runs, then adds the project", async () => {
    const spawned: string[][] = [];
    const output = await captureOutput(() =>
      runWorkShortcut(addArguments, {
        ...projectDeps(),
        spawnWorker: (args) => {
          spawned.push(args);
          h.startWorker();
        },
        pollMs: 5,
      }),
    );
    expect(spawned).toEqual([
      ["worker", "start", "--foreground", "--base-url", BASE_URL],
    ]);
    expect(h.supervisor.added).toEqual([settingsFor(BASE_URL)]);
    expect(output).toContain(`Started worker instance ${INSTANCE}`);
    expect(output).toContain(
      `Added acme/app (/repos/app @ main) to worker instance ${INSTANCE}.`,
    );
    expect(output).toContain(`${INSTANCE} worker logs acme/app -f`);
  });

  test("adds to a worker already running", async () => {
    h.startWorker();
    const output = await captureOutput(() =>
      runWorkShortcut(addArguments, {
        ...projectDeps(),
        spawnWorker: () => {
          throw new Error("should not spawn");
        },
      }),
    );
    expect(output).toContain(`Worker instance ${INSTANCE} is already running`);
    expect(h.supervisor.added).toHaveLength(1);
  });

  test("resolves the checkout before starting anything", async () => {
    let spawned = false;
    const error = await rejection(
      runWorkShortcut(addArguments, {
        ...projectDeps(),
        findGitRoot: () => Promise.resolve(null),
        spawnWorker: () => {
          spawned = true;
        },
      }),
    );
    expect((error as CliError).code).toBe("not_in_git_repo");
    expect(spawned).toBe(false);
  });

  test("checks the version of a worker already running", async () => {
    h.startWorker("0.0.1-old");
    const error = await rejection(runWorkShortcut(addArguments, projectDeps()));
    expect(error).toBeInstanceOf(WorkerVersionMismatchError);
    expect(h.supervisor.added).toEqual([]);
  });
});
