import { z } from "zod";
import { defineStep, Features, Runtime } from "@scarn/sdk/definitions/steps";
import {
  all,
  decision,
  definePipeline,
  equal,
  fail,
  greaterThanInclusive,
  succeed,
} from "@scarn/sdk/pipelines";

// Generic bug-repro pipeline: any work item labeled "bug" lands here.
//
//   reproduce-in-browser ──(reproduced && confidence >= 0.8)──▶ write-failing-integration-test ──▶ done (human takes over)
//                │                                          ▲                     │
//                └──(else)──▶ review-reproduction (human) ──┘                     └──▶ always advances to `done` — no fix step
//                                  └──(rejected)──▶ not-reproduced
//
// Step 1 drives the app running inside this devcontainer with a browser and
// captures a trace of the reported failure, plus a comparison trace of the
// working path when the report makes one discoverable. Step 2 turns that into
// a failing INTEGRATION test (bun test + testcontainers, per docs/testing.md)
// — not another end-to-end test — through the typed Eden API client. There is
// no fix step by design: a human takes it from here once the gap is proven at
// both layers.

const APP_URL = "http://localhost:3000";

export const reproduceInBrowser = defineStep({
  key: "reproduce-in-browser",
  name: "Reproduce In Browser",
  description:
    "Drive the app running in this devcontainer until the reported bug is observed.",
  status: "active",
  environment: { runtime: Runtime.devcontainer() },

  // Ordering matters here — see comments inline. Starting the trace before the
  // viewport is set, or stopping it before the post-action wait, loses the
  // evidence.
  agentPrompt: ({ input }) => `
Reproduce this reported bug against a real running copy of the app, then
capture the evidence as a Playwright trace.

## Get the app running

1. This devcontainer's Postgres and RustFS should already be up (started on
   container create) and migrated. Confirm with \`docker compose ps\`; if
   \`db\` or \`rustfs\` are not running, start them with
   \`docker compose up -d db rustfs\` and run \`bun run db:migrate\` before
   continuing.
2. Start the app: \`bun run dev\` (root script — this runs the Next.js app,
   which serves the API too; you do not need a separate API process). Wait
   until ${input.appUrl} responds before opening a browser.
3. Sign in via dev login: the login page has a "Continue as (dev)" option
   backed by \`ENABLE_DEV_LOGIN\`. Use it with the default email unless the
   report implies a specific user matters. If \`ENABLE_DEV_LOGIN\` is not set
   in \`.env\`, or dev login is not available, stop and emit a
   \`feedback_request\` notification naming exactly what you could not obtain.
   Never invent a credential or auth flow.
4. If reproducing this report requires state that does not exist yet — a
   project, a project integration, a pipeline definition, a default pipeline
   assignment, specific work items — there is currently no seed script, so
   create the minimum through the UI or the API yourself. Record exactly what
   you created in \`setupNotes\`; the next step and the human reviewing this
   need to know it did not pre-exist.

## Capture the failure

Follow this order exactly:

1. Navigate to the app.
2. Set the viewport immediately — mobile only if the report is specifically
   about mobile, otherwise desktop.
3. Snapshot the initial state.
4. Start a Playwright trace now: after the browser is open and resized,
   before any meaningful interaction. Use raw code execution ONLY to start and
   stop the trace; drive everything else with the ordinary browser tools.
5. Work through the reported steps, snapshotting before every major
   transition (a modal, a redirect, any click whose target you are unsure of).
6. Perform the final triggering action.
7. WAIT. Delayed redirects, toasts, validation errors, and states that only
   render a beat later are the actual bug more often than not, and stopping
   here is the single most common way to lose the evidence.
8. Collect console messages and network requests.
9. Only now, stop the trace.

## Capture the comparison, if there is one

If the report describes — or implies — a second path that is supposed to
produce the correct outcome (a different endpoint, a different entry point,
an existing working flow), repeat the same choreography against that path in
a second trace, so the two can be compared side by side. Only do this if that
second path is concretely identifiable from the report or the code; do not
invent one. If there is no such comparison to make, say so plainly in
\`comparisonNotes\` and rely on \`observedBehavior\` vs. \`expectedBehavior\`
instead — that is an adequate deliverable on its own.

## Report

- \`reproduced\`: true only if you personally observed the reported failure.
- \`confidence\`: 0 = guessing, 1 = you watched the exact reported failure and
  can point at the trace. Score low when unsure — that parks this for a human,
  which is the correct outcome.
- \`observedBehavior\` / \`expectedBehavior\`: what happened, and what the
  report says should have happened instead.
- \`reproductionSteps\`: the minimal ordered steps, concrete enough for someone
  else to replay with no other context.
- \`tracePath\`: the trace of the failing path, or null.
- \`comparisonTracePath\`: the trace of the working/comparison path, or null.
- \`comparisonNotes\`: what the comparison shows, or why none could be made.
- \`consoleErrors\`: verbatim error text, not a summary.
- \`setupNotes\`: any state you had to create to get here (see above), or "".

The next step turns this into a failing integration test, so be specific
about endpoints, payloads, and the exact fields you observed on each side.
`,

  input: z.object({
    appUrl: z.string().nullable().optional(),
  }),

  result: z.object({
    reproduced: z.boolean(),
    confidence: z.number().min(0).max(1),
    observedBehavior: z.string(),
    expectedBehavior: z.string(),
    reproductionSteps: z.array(z.string()),
    tracePath: z.string().nullable(),
    comparisonTracePath: z.string().nullable(),
    comparisonNotes: z.string(),
    consoleErrors: z.array(z.string()),
    setupNotes: z.string(),
  }),

  features: [Features.notifications()],
});

export const writeFailingIntegrationTest = defineStep({
  key: "write-failing-integration-test",
  name: "Write Failing Integration Test",
  description:
    "Encode the confirmed reproduction as a failing integration test.",
  status: "active",
  environment: { runtime: Runtime.devcontainer() },

  agentPrompt: ({ input }) => `
A previous step reproduced this bug in the browser. Encode the same
underlying gap as a failing INTEGRATION test — not another end-to-end or
browser test. Integration tests exercise the application/API layer directly
and run far faster than a browser; that speed is why this step exists
separately from the last one.

Observed: ${input.observedBehavior}
Expected: ${input.expectedBehavior}
Setup the previous step needed: ${input.setupNotes}

## Conventions (docs/testing.md — read it if anything here is unclear)

- Runner: \`bun test\`. Real Postgres via testcontainers — do not mock the
  database.
- Go through the app, not raw \`Request\` objects: use the typed Eden client
  (\`createScarnTreaty\` / \`createScarnApiClient\`). For expected failures,
  assert directly on \`{ data, error }\`; for success, use \`unwrapAsync(...)\`.
- File placement: \`packages/core/tests/**/integration/\`, mirroring the
  \`src/\` path of the aggregate this bug implicates. Find the closest existing
  file first — e.g. an \`entity.lifecycle.test.ts\` or an
  \`entity.{httpType}.test.ts\` for the aggregate involved — and extend it if
  the new case obviously belongs there. Only create a new file if none fits;
  keep lifecycle files smoke-oriented and put edge cases in an
  \`entity.{httpType}.test.ts\` file instead.
- Use \`test.concurrent(...)\` unless the case has ordered, shared-state setup
  (then match the surrounding file's use of plain \`test()\`).
- Prefer snapshot assertions for contract shapes; targeted manual assertions
  for single fields, status codes, and ordering.

## Do

1. Identify the aggregate/use case this report implicates and find its
   existing integration test file(s).
2. Write or extend a test that sets up the same preconditions the browser
   step needed (see "Setup" above) through the API, then asserts the expected
   behavior — the same outcome the report says should happen.
3. Run it with \`bun test <path>\` (not the whole suite) and confirm it fails,
   and that it fails from this bug rather than a mistake in your own setup.

## Do not

- Do not attempt a fix. This step ends the pipeline; a human takes it from
  here.
- Do not weaken the assertion to make it pass, and do not delete or skip an
  existing test to make room.
- Do not write a browser/E2E test here — that already happened in the
  previous step.

## Report

- \`testPaths\`: every file you created or changed.
- \`testCommand\`: the exact command running just these tests.
- \`testsFail\`: true only if you ran them and saw them fail.
- \`failureOutput\`: verbatim failure output, not a paraphrase.
- \`capturesReportedBug\`: true only if the failure is this bug, not an
  unrelated defect you stumbled into.
- \`confidence\`: 0 = the test guesses at the shape of the bug, 1 = the failure
  message directly restates the report. Score low rather than assuming
  context you do not have.
- \`summary\`: what you encoded, and explicitly what you could NOT capture at
  this layer (if anything) — the human picking this up reads this first.
`,

  input: z.object({
    observedBehavior: z.string(),
    expectedBehavior: z.string(),
    setupNotes: z.string(),
  }),

  result: z.object({
    testPaths: z.array(z.string()),
    testCommand: z.string(),
    testsFail: z.boolean(),
    failureOutput: z.string(),
    capturesReportedBug: z.boolean(),
    confidence: z.number().min(0).max(1),
    summary: z.string(),
  }),

  features: [Features.notifications()],
});

// A weak or failed reproduction waits for a human instead of writing a test.
const reviewReproduction = decision("review-reproduction", {
  actions: {
    approve: { label: "Approve" },
    reject: { label: "Reject" },
  },
});
const notReproduced = fail("not-reproduced", { error: "NotReproduced" });
// Always the end: there is no fix step. Once the failing integration test is
// written (or the attempt falls short), a human takes over.
const done = succeed("done");

export default definePipeline({
  key: "bug-repro",
  title: "Bug Repro",
  start: reproduceInBrowser({ appUrl: APP_URL }),
  flow: [
    reproduceInBrowser.next({
      routes: [
        {
          when: (r) =>
            all(
              equal(r.result.reproduced, true),
              greaterThanInclusive(r.result.confidence, 0.8),
            ),
          to: (r) =>
            writeFailingIntegrationTest({
              observedBehavior: r.result.observedBehavior,
              expectedBehavior: r.result.expectedBehavior,
              setupNotes: r.result.setupNotes,
            }),
        },
      ],
      otherwise: (r) => reviewReproduction({ reproduction: r.result }),
    }),

    reviewReproduction.next({
      routes: [
        {
          when: (r) => equal(r.result.action, "approve"),
          to: (r) =>
            writeFailingIntegrationTest({
              observedBehavior:
                r.node(reproduceInBrowser).result.observedBehavior,
              expectedBehavior:
                r.node(reproduceInBrowser).result.expectedBehavior,
              setupNotes: r.node(reproduceInBrowser).result.setupNotes,
            }),
        },
      ],
      otherwise: notReproduced,
    }),

    writeFailingIntegrationTest.next(done),
  ],
});
