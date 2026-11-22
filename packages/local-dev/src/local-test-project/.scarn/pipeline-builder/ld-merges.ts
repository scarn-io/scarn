/**
 * Merges with `.partial()`: `prepareRelease` fans out with `match: "all"`.
 * The unit and e2e lanes always run and meet at `combineTests`, a partial
 * merge that carries on as one lane. `fields.scan` adds a dependency-scan
 * lane, and every service in `fields.services` gets a health-check lane;
 * only unhealthy ones arrive at the merge, healthy lanes end quietly.
 * Everything closes at `decideRelease`, which blocks on a failing suite
 * (`fields.failingSuite`), advisories (`fields.advisories`) or an unhealthy
 * service (`fields.unhealthy`).
 */
import {
  definePipeline,
  each,
  equal,
  fail,
  succeed,
  workItem,
  workItemField,
} from "@scarn/sdk/pipelines";
import {
  checkService,
  combineTests,
  decideRelease,
  prepareRelease,
  runE2eTests,
  runUnitTests,
  scanDependencies,
} from "./merges-steps";

const released = succeed("released");
const releaseBlocked = fail("release-blocked", { error: "ReleaseBlocked" });

export default definePipeline({
  key: "ld-merges",
  title: "Local dev: merge lanes with .partial()",
  start: prepareRelease({
    title: workItem.title,
    services: workItemField("services", "services"),
    unhealthy: workItemField("unhealthy", "unhealthy"),
    failingSuite: workItemField("failingSuite", "failingSuite"),
    scan: workItemField("scan", "scan"),
    advisories: workItemField("advisories", "advisories"),
  }),
  flow: [
    prepareRelease.settings({ title: "Prepare release" }).next({
      match: "all",
      routes: [
        {
          to: (r) =>
            runUnitTests({
              version: r.result.version,
              failingSuite: r.result.failingSuite,
            }),
        },
        {
          to: (r) =>
            runE2eTests({
              version: r.result.version,
              failingSuite: r.result.failingSuite,
            }),
        },
        {
          when: (r) => equal(r.result.scan, true),
          to: (r) =>
            scanDependencies({
              version: r.result.version,
              advisories: r.result.advisories,
            }),
        },
        {
          to: (r) =>
            each(r.result.services, (service) =>
              checkService({ name: service.name, healthy: service.healthy }),
            ),
        },
      ],
    }),
    runUnitTests
      .settings({ title: "Run unit tests" })
      .next((r) => combineTests.partial({ unit: r.result })),
    runE2eTests
      .settings({ title: "Run e2e tests" })
      .next((r) => combineTests.partial({ e2e: r.result })),
    combineTests
      .settings({ title: "Combine test results" })
      .next((r) => decideRelease.partial({ tests: r.result })),
    scanDependencies
      .settings({ title: "Scan dependencies" })
      .next((r) => decideRelease.partial({ advisories: r.result.advisories })),
    checkService.settings({ title: "Check service health" }).next({
      routes: [
        {
          when: (r) => equal(r.result.healthy, false),
          to: (r) => decideRelease.partial({ unhealthyServices: [r.result] }),
        },
      ],
    }),
    decideRelease.settings({ title: "Decide release" }).next({
      routes: [
        { when: (r) => equal(r.result.blocked, true), to: releaseBlocked },
      ],
      otherwise: released,
    }),
  ],
});
