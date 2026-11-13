/**
 * Runs `runForegroundWorker` with real process signals and fake project
 * workers, for the signal test. Reads `HOME`, `SCARN_LOCAL_DB_PATH` and
 * `SCARN_WORKER_INSTANCE` from the environment, saves one fake project,
 * and prints progress lines on stdout.
 */
import { resolveWorkerInstance } from "@scarn/worker";
import { runForegroundWorker } from "../../src/commands/worker/foreground-host";
import {
  createHoldingProjectWorkers,
  fakeHostDeps,
  saveFakeProject,
} from "../worker-host-fakes";

const print = (line: string) => {
  process.stdout.write(`${line}\n`);
};

const databasePath = process.env["SCARN_LOCAL_DB_PATH"];
if (!databasePath) throw new Error("SCARN_LOCAL_DB_PATH must be set");
const instance = resolveWorkerInstance();
saveFakeProject(databasePath, instance);

await runForegroundWorker(
  { instance, baseUrl: "http://scarn.test" },
  {
    createHostDeps: () => fakeHostDeps,
    createProjectWorker: createHoldingProjectWorkers(print),
    print,
  },
);
print("exited cleanly");
process.exit(0);
