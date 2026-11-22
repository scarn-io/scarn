/**
 * Self-loop: `attempt` reruns with the previous result until it passes on
 * run `fields.passOnAttempt`. `maxRuns: 5` caps it, so `99` gives up.
 */
import {
  definePipeline,
  equal,
  fail,
  succeed,
  workItemField,
} from "@scarn/sdk/pipelines";
import { attempt } from "./steps";

const done = succeed("done");
const gaveUp = fail("gave-up", { error: "TestsStillFailing" });

export default definePipeline({
  key: "ld-loop",
  title: "Local dev: retry until it passes",
  start: attempt({
    passOnAttempt: workItemField("passOnAttempt", "passOnAttempt"),
  }),
  flow: [
    attempt
      .settings({ title: "Attempt", maxRuns: 5 })
      .catch(["Scarn.MaxRunsExceeded"], gaveUp)
      .next({
        routes: [{ when: (r) => equal(r.result.passed, true), to: done }],
        otherwise: (r) => attempt({ ...r.input, previous: r.result }),
      }),
  ],
});
