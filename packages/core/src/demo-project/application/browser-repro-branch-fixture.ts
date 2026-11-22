import type { DemoFlagshipStepNodeFixture } from "./demo-flagship-pipeline-types";

/**
 * The flagship pipeline's browser-repro branch — the two steps
 * `classify-and-label-impact` dispatches to when intake classified
 * the ticket as a user-visible failure in the running application.
 *
 * Every prompt and gate here is copied from the real pipeline definition
 * this branch was captured against, with each advancement rule rewritten as
 * a `next` route and each `block` default as a `fail` node. The captured content these steps replay
 * lives in `fixtures/flagship/coupon-double-apply/` — see
 * `seed-demo-coupon-double-apply-flagship.ts`.
 */

export const BROWSER_REPRO_ENTRY_NODE_KEY = "reproduce-in-browser";

export const BROWSER_REPRO_BRANCH_STEPS: readonly DemoFlagshipStepNodeFixture[] =
  [
    {
      key: BROWSER_REPRO_ENTRY_NODE_KEY,
      stepName: "Reproduce In Browser",
      stepPrompt: `Reproduce the bug described in this work item by driving the app through a
real browser — not by calling any API directly. However the report describes
the trigger (raw requests, a stack trace, a support message), that is
evidence of what causes the failure, not the reproduction itself: an agent
that just replays the underlying request(s) and reports the resulting status
code has not done this step. You need to see what actually shows up on the
page a real user would be looking at.

Start a Playwright trace before navigating anywhere, drive the browser
through the exact sequence of actions the work item describes, wait after the
final triggering action in case the failure arrives after a delay, collect
console messages and network requests for the implicated request(s), take a
full-page screenshot of the failure state while the trace is still running,
then stop the trace.

Report \`reproduced\` (true only if you personally observed the reported
failure), \`confidence\` (0 = guessing, 1 = you watched the exact reported
failure and can point at the trace and the network response that caused it),
\`observedBehavior\`, \`expectedBehavior\`, \`reproductionSteps\`,
\`tracePath\`, \`screenshotPath\`, \`consoleErrors\`, and \`networkEvidence\`.
The next step reads code to explain this failure, so be specific about what
you actually saw, not what you assume caused it.`,
      next: {
        routes: [
          {
            when: {
              all: [
                { path: "result.reproduced", op: "equal", value: true },
                {
                  path: "result.confidence",
                  op: "greaterThanInclusive",
                  value: 0.8,
                },
              ],
            },
            to: "investigate-root-cause",
          },
        ],
        otherwise: { to: "not-reproduced" },
      },
    },
    {
      key: "investigate-root-cause",
      stepName: "Investigate Root Cause",
      stepPrompt: `A previous step confirmed this bug in a browser. Your job is to explain it,
down to the specific code — NOT to fix it.

Do not modify any file. Do not open a fix. If you find yourself wanting to
patch something to confirm your theory, that is a sign you have not finished
reading the code yet — read further instead. The decision to fix, and how,
belongs to a human who has not seen your work yet.

Start from the failing request in the network evidence and read the server
code that handles it. Trace the exact execution path from that handler to the
line that throws or misbehaves. Explain the mechanism precisely: what state
exists after the first successful call, and what about the second call's
handling of that state is wrong.

Report \`identifiedRootCause\` (true ONLY if you can point at the specific
line(s) responsible and explain why they fail on the second call
specifically), \`rootCauseExplanation\` (the mechanism, precisely, in prose a
reviewer can verify against the code without re-deriving it themselves),
\`implicatedCode\` (each entry as \`"path:lines — why this line is
responsible"\`, every claim in \`rootCauseExplanation\` backed by an entry
here), \`evidence\` (the specific facts that prove this theory), \`confidence\`
(0 = plausible guess, 1 = you traced the exact state transition), and
\`openQuestions\`.`,
      next: {
        routes: [
          {
            when: {
              all: [
                {
                  path: "result.identifiedRootCause",
                  op: "equal",
                  value: true,
                },
                {
                  path: "result.confidence",
                  op: "greaterThanInclusive",
                  value: 0.8,
                },
              ],
            },
            to: "done",
          },
        ],
        otherwise: { to: "root-cause-unidentified" },
      },
    },
  ];
