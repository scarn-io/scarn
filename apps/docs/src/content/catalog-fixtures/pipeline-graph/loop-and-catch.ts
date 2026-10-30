import {
  definePipeline,
  equal,
  fail,
  succeed,
  workItem,
} from "@scarn/sdk/pipelines";
import * as steps from "./steps";

const fix = steps.fix.as("fix");
const done = succeed("done");
const gaveUp = fail("gaveUp", { error: "TestsStillFailing" });

export default definePipeline({
  key: "catalog-loop-and-catch",
  title: "Fix until the tests pass",
  start: fix({ title: workItem.title }),
  flow: [
    fix
      .settings({
        title: "Fix and run tests",
        maxRuns: 5,
        heartbeatSeconds: 300,
      })
      .retry({ on: ["Scarn.HeartbeatTimeout"], maxAttempts: 2 })
      .catch(["Scarn.MaxRunsExceeded"], gaveUp)
      .next({
        routes: [{ when: (r) => equal(r.result.testsPass, true), to: done }],
        otherwise: (r) =>
          fix({ title: r.input.title, previousAttempt: r.result }),
      }),
  ],
});
