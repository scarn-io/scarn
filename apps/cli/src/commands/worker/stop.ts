/**
 * `scarn worker stop [--force]`: asks the instance's worker to stop over
 * `POST /stop`, then waits for its process to exit, showing which runs are
 * still draining. Without `--force` the worker lets its runs finish; with it
 * the runs are aborted.
 *
 * `stop` skips the version check, so a worker of another version can always
 * be stopped (the remedy the version-mismatch error suggests). Ctrl-C while
 * waiting only stops the waiting: the worker keeps draining, and the command
 * exits 0.
 */
import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import {
  createControlClient,
  isProcessAlive,
  resolveWorkerInstance,
  type RunningWorker,
  type WorkerStatus,
} from "@scarn/worker";
import { withReporter } from "../../lib/command-output";
import type { BaseReporter } from "../../lib/reporter-types";
import {
  connectToWorker,
  controlData,
  type ConnectToWorkerDeps,
} from "./connect";
import { subscribeProcessStopSignals } from "./stop-signals";

export const WORKER_STOP_POLL_MS = 1_000;
const STATUS_REQUEST_TIMEOUT_MS = 2_000;

export type WorkerStopArguments = { force: boolean };

export type WorkerStopDeps = ConnectToWorkerDeps & {
  pollMs?: number | undefined;
  isProcessAlive?: ((pid: number) => boolean) | undefined;
  /** Calls `onInterrupt` on Ctrl-C; returns the unsubscribe. */
  subscribeInterrupt?: ((onInterrupt: () => void) => () => void) | undefined;
};

type ActiveRun = WorkerStatus["activeRuns"][number];

export async function runWorkerStop(
  arguments_: WorkerStopArguments,
  deps: WorkerStopDeps = {},
): Promise<void> {
  await withReporter("worker-stop-command", async ({ reporter }) => {
    const instance = resolveWorkerInstance();
    const worker = await connectToWorker(
      instance,
      { checkVersion: false },
      deps,
    );
    if (!worker) {
      reporter.info(`Worker instance ${instance} is not running.`);
      return;
    }
    await controlData(
      "stop the worker",
      worker.client.stop.post({ force: arguments_.force }),
    );
    const exited = await waitForExit(worker, reporter, arguments_.force, deps);
    if (exited) {
      reporter.success(`Worker instance ${instance} stopped.`);
    } else {
      reporter.info(
        `Stopped waiting; the worker is still draining. Check with \`${instance} worker status\`.`,
      );
    }
  });
}

/** Waits until the worker's process is gone; false when interrupted first. */
async function waitForExit(
  worker: RunningWorker,
  reporter: BaseReporter,
  force: boolean,
  deps: WorkerStopDeps,
): Promise<boolean> {
  const { pid, port, token } = worker.discovery;
  const alive = deps.isProcessAlive ?? isProcessAlive;
  const pollMs = deps.pollMs ?? WORKER_STOP_POLL_MS;
  const interrupt = new AbortController();
  const unsubscribe = (
    deps.subscribeInterrupt ??
    ((onInterrupt) => subscribeProcessStopSignals(onInterrupt))
  )(() => {
    interrupt.abort();
  });
  const client = createControlClient({
    port,
    token,
    fetcher: abortable(interrupt.signal),
  });
  const activity = reporter.startActivity(
    force ? "Stopping the worker…" : "Waiting for the worker to drain…",
  );
  const interrupted = () => interrupt.signal.aborted;
  let shown = "";
  try {
    while (!interrupted()) {
      const { data } = await client.status.get({ query: {} });
      if (interrupted()) break;
      if (data) {
        const message = drainingMessage(data.activeRuns);
        if (message !== shown) {
          shown = message;
          activity.update(message);
        }
      } else if (!alive(pid)) {
        activity.succeed("Worker exited");
        return true;
      }
      await sleep(pollMs, interrupt.signal);
    }
    activity.fail("Stopped waiting");
    return false;
  } finally {
    unsubscribe();
  }
}

export function drainingMessage(runs: readonly ActiveRun[]): string {
  if (runs.length === 0) return "Waiting for the worker to exit…";
  const names = runs
    .map((run) =>
      run.taskName ? `${run.taskName} (${run.taskRunId})` : run.taskRunId,
    )
    .join(", ");
  return `Draining ${String(runs.length)} run${runs.length === 1 ? "" : "s"}: ${names}`;
}

function abortable(signal: AbortSignal): typeof fetch {
  const timed = (input: RequestInfo | URL, init?: RequestInit) =>
    fetch(input, {
      ...init,
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(STATUS_REQUEST_TIMEOUT_MS),
      ]),
    });
  return Object.assign(timed, { preconnect: fetch.preconnect });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timeout = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

export function createWorkerStopCommand(
  deps: WorkerStopDeps = {},
): CommandModule<object, WorkerStopArguments> {
  return {
    command: "stop",
    describe:
      "Stop this machine's background worker, letting its runs finish first",
    builder: (argv: Argv<object>) =>
      argv.option("force", {
        describe: "Abort the running runs instead of letting them finish",
        type: "boolean",
        default: false,
      }),
    handler: (arguments_: ArgumentsCamelCase<WorkerStopArguments>) =>
      runWorkerStop(arguments_, deps),
  };
}

export const workerStopCommand = createWorkerStopCommand();
