/**
 * Retry and catch: `fields.failMode` of `throw` fails every attempt, so the
 * retries run out and `Scarn.StepFailed` is caught into `recover`. `sleep`
 * outlasts `timeoutSeconds` and ends at `timed-out`. `none` succeeds.
 */
import {
  definePipeline,
  fail,
  succeed,
  workItemField,
} from "@scarn/sdk/pipelines";
import { flaky, recover } from "./steps";

const done = succeed("done");
const recovered = succeed("recovered");
const timedOut = fail("timed-out", { error: "FlakyTimedOut" });

export default definePipeline({
  key: "ld-errors",
  title: "Local dev: retry, timeout and catch",
  start: flaky({ failMode: workItemField("failMode", "failMode") }),
  flow: [
    flaky
      .settings({ title: "Flaky step", timeoutSeconds: 120 })
      .retry({ on: ["Scarn.StepFailed"], maxAttempts: 2 })
      .catch(["Scarn.StepFailed"], (r) =>
        recover({ errorName: r.error.name, message: r.error.message }),
      )
      .catch(["Scarn.Timeout"], timedOut)
      .next(done),
    recover.settings({ title: "Recover" }).next(recovered),
  ],
});
