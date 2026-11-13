import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { WorkerVersionMismatchError } from "../src/commands/worker/worker-errors";
import type { DesignRunTarget } from "../src/lib/design-run-offer";
import {
  handOffToWorker,
  queuedMessage,
  workItemFilterWarning,
  type DesignWorkerHandOffDeps,
} from "../src/lib/design-worker-handoff";
import { rejection } from "./action-harness";
import { createReporterRecorder, reportedMessages } from "./utils";
import { FAKE_PROJECT_ID } from "./worker-host-fakes";
import {
  BASE_URL,
  INSTANCE,
  projectDeps,
  projectStatus,
  settingsFor,
  useWorkerProjectHarness,
} from "./worker-project-harness";

/**
 * `pipelines design` hands the run it queued to the background worker: it
 * starts the worker and adds the project only when needed, and warns when an
 * existing work-item filter would leave the run unclaimed.
 */

setDefaultTimeout(20_000);

const h = useWorkerProjectHarness();

const DESIGN_WORK_ITEM_ID = "019ed1c0-1111-7170-a08a-1ff912085f7b";
const PROJECT_ROOT = "/repos/app";

const TARGET: DesignRunTarget = {
  projectId: FAKE_PROJECT_ID,
  project: "acme/app",
  workItemId: DESIGN_WORK_ITEM_ID,
  workItemTitle: "Checkout button does nothing on mobile Safari",
};

function noSpawn(): DesignWorkerHandOffDeps {
  return {
    ...projectDeps(),
    spawnWorker: () => {
      throw new Error("should not spawn");
    },
  };
}

async function handOff(deps: DesignWorkerHandOffDeps) {
  const { reporter, calls } = createReporterRecorder();
  await handOffToWorker(
    { target: TARGET, baseUrl: BASE_URL, projectRoot: PROJECT_ROOT, reporter },
    deps,
  );
  return {
    warnings: calls.filter((c) => c.method === "warn").map((c) => c.message),
    messages: reportedMessages(calls),
  };
}

function savedFilter(workItemId: string | null): void {
  const project = projectStatus();
  h.supervisor.projects = [
    { ...project, settings: { ...project.settings, workItemId } },
  ];
}

describe("handOffToWorker", () => {
  test("starts the worker and adds the project with no filter", async () => {
    h.supervisor.projects = [];
    const spawned: string[][] = [];
    const cwds: string[] = [];
    const { messages } = await handOff({
      ...projectDeps(),
      findGitRoot: (cwd) => {
        cwds.push(cwd);
        return Promise.resolve(PROJECT_ROOT);
      },
      spawnWorker: (args) => {
        spawned.push(args);
        h.startWorker();
      },
      pollMs: 5,
    });

    expect(spawned).toEqual([
      ["worker", "start", "--foreground", "--base-url", BASE_URL],
    ]);
    expect(cwds).toEqual([PROJECT_ROOT]);
    expect(h.supervisor.added).toEqual([
      { ...settingsFor(BASE_URL), concurrency: null, workItemId: null },
    ]);
    expect(messages).toContain(
      `Started worker instance ${INSTANCE} (pid ${String(process.pid)}).`,
    );
    expect(messages).toContain(
      `Added acme/app (/repos/app @ main) to worker instance ${INSTANCE}.`,
    );
    expect(messages.at(-1)).toBe(queuedMessage(INSTANCE));
    expect(queuedMessage(INSTANCE)).toBe(
      `Queued — your worker will pick this up. Follow it with \`${INSTANCE} worker status\`.`,
    );
  });

  test("adds the project to a worker already running", async () => {
    h.startWorker();
    h.supervisor.projects = [];
    const { messages } = await handOff(noSpawn());

    expect(h.supervisor.added).toHaveLength(1);
    expect(h.supervisor.added[0]?.workItemId).toBeNull();
    expect(messages.some((m) => m.startsWith("Started worker"))).toBe(false);
  });

  test("leaves an added project alone", async () => {
    h.startWorker();
    savedFilter(null);
    const { warnings, messages } = await handOff({
      ...noSpawn(),
      findGitRoot: () => {
        throw new Error("should not resolve the checkout");
      },
    });

    expect(h.supervisor.added).toEqual([]);
    expect(warnings).toEqual([]);
    expect(messages).toEqual([queuedMessage(INSTANCE)]);
  });

  test("stays quiet when the saved filter is the design work item", async () => {
    h.startWorker();
    savedFilter(DESIGN_WORK_ITEM_ID);
    const { warnings } = await handOff(noSpawn());

    expect(h.supervisor.added).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("warns when the saved filter is another work item", async () => {
    h.startWorker();
    savedFilter("other-work-item");
    const { warnings, messages } = await handOff(noSpawn());

    expect(h.supervisor.added).toEqual([]);
    expect(warnings).toEqual([
      workItemFilterWarning({
        instance: INSTANCE,
        projectRef: "acme/app",
        savedWorkItemId: "other-work-item",
        designWorkItemId: DESIGN_WORK_ITEM_ID,
      }),
    ]);
    expect(warnings[0]).toContain("will not pick up this run");
    expect(messages.at(-1)).toBe(queuedMessage(INSTANCE));
  });

  test("checks the version of a worker already running", async () => {
    h.startWorker("0.0.1-old");
    const error = await rejection(handOff(noSpawn()));
    expect(error).toBeInstanceOf(WorkerVersionMismatchError);
    expect(h.supervisor.added).toEqual([]);
  });
});
