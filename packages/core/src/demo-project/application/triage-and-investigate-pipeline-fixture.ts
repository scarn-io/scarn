import type {
  DemoFlagshipPipelineFixture,
  DemoFlagshipStepNodeFixture,
} from "./demo-flagship-pipeline-types";
import {
  BROWSER_REPRO_BRANCH_STEPS,
  BROWSER_REPRO_ENTRY_NODE_KEY,
} from "./browser-repro-branch-fixture";
import {
  PERF_BISECT_BRANCH_STEPS,
  PERF_BISECT_ENTRY_NODE_KEY,
} from "./perf-bisect-branch-fixture";

/**
 * The demo project's single flagship pipeline — one graph-shaped definition
 * that gates on ticket quality, labels impact, then *branches inside itself*
 * to whichever investigation the ticket needs.
 *
 * This used to be three chain-shaped pipelines chained by cross-pipeline
 * `route` events, so no single run ever showed the whole decision. The fork
 * is now a pair of `next` routes on `classify-and-label-impact`, and
 * every flagship work item has exactly one run spanning intake and
 * investigation.
 *
 * The branch steps live in `browser-repro-branch-fixture.ts` /
 * `perf-bisect-branch-fixture.ts`, split out to stay under the repo's
 * per-file line limit. A thin ticket gets up to two questions through the
 * `ask-for-details` reply wait before the run ends at `insufficient-detail`;
 * every other gate that used to `block` for a human ends the run on a named
 * `fail` node instead.
 */

export const TRIAGE_AND_INVESTIGATE_PIPELINE_KEY = "triage_and_investigate";

const INTAKE_ENTRY_NODE_KEY = "assess-intake-quality";

/**
 * The pipeline keys the three retired chain-shaped definitions were published
 * under. Kept only so `pruneRetiredDemoPipelines` can find and archive them
 * in an environment seeded before the merge.
 */
export const RETIRED_DEMO_PIPELINE_KEYS = [
  "intake_router",
  "browser_repro_investigate",
  "perf_bisect",
] as const;

const INTAKE_STEPS: readonly DemoFlagshipStepNodeFixture[] = [
  {
    key: INTAKE_ENTRY_NODE_KEY,
    stepName: "Assess Intake Quality",
    stepPrompt: `Judge whether this ticket is clear enough to act on. Judge the title, the
description and the comment thread, including any answers to earlier
questions.

Score each independently from 0 to 1. Do not average them yourself; the
pipeline does that.

- \`observedBehaviorScore\`: is it clear what actually happens right now? 0 =
  "it's broken" with no detail. 1 = a specific, concrete behavior (what a
  user did, what showed up).
- \`expectedBehaviorScore\`: is it clear what should happen instead? 0 = never
  stated and not inferable. 1 = explicit, or so obvious from context that no
  reasonable reader would disagree (e.g. "an error page" is clearly not the
  desired outcome, even if no one wrote "should not crash").

Be strict rather than generous — a vague ticket sent downstream wastes an
agent's entire run guessing at scope, which is worse than parking it here for
a human to add detail.

Also report:

- \`missingInformation\`: an array of strings, one question each, that would
  raise a low score, phrased so they could be pasted back to the reporter
  verbatim. Empty if both scores are high.
- \`restatedProblem\`: one or two sentences restating the problem as you
  understood it, so a human (or the next step) can see whether you read it
  the way they meant it.`,
    next: {
      routes: [
        {
          when: {
            avg: [
              "result.observedBehaviorScore",
              "result.expectedBehaviorScore",
            ],
            op: "greaterThanInclusive",
            value: 0.6,
          },
          to: "classify-and-label-impact",
          args: { restatedProblem: "result.restatedProblem" },
        },
      ],
      otherwise: {
        to: "ask-for-details",
        args: { questions: "result.missingInformation" },
      },
    },
  },
  {
    key: "classify-and-label-impact",
    stepName: "Classify & Label Impact",
    stepPrompt: `A previous step confirmed this ticket is clear enough to act on. Its restated
understanding of the problem: {{input.restatedProblem}}

You are dispatching, not solving — do not investigate further.

## Label impact

\`impactLevel\`: how badly this affects users right now.

- \`none\`: cosmetic, no user-facing effect.
- \`low\`: a minor inconvenience with an easy workaround.
- \`medium\`: a real inconvenience, no easy workaround, but not blocking.
- \`high\`: blocks a core flow for some users (e.g. checkout, signup) with no
  workaround.
- \`critical\`: blocks a core flow for most/all users, or risks data loss or
  money.

## Choose a branch

Pick \`routeKey\` from these values and only these:

- \`perf-bisect\` — the complaint is that something got SLOWER over time.
  There is a "before" that was fine and a "now" that isn't.
- \`browser-repro-investigate\` — a user-visible failure in the running
  application: a page, a form, a flow, a button, an error banner — anything
  a person would see by using the site, including a crash triggered by a
  specific sequence of actions.
- \`unclear\` — it fits neither cleanly, or you cannot tell without more
  investigation than dispatching allows.

\`confidence\`: 0 = you cannot tell what kind of problem this is, 1 = the
report names the surface unambiguously.

\`reasoning\`: one or two sentences a human can check without rereading the
ticket. Name the words in the report that decided both the impact label and
the branch.`,
    // A confident `unclear`, or any low-confidence classification, ends the
    // run for a human — the real router had no route for either.
    next: {
      routes: [
        {
          when: {
            all: [
              {
                path: "result.confidence",
                op: "greaterThanInclusive",
                value: 0.7,
              },
              { path: "result.routeKey", op: "equal", value: "perf-bisect" },
            ],
          },
          to: PERF_BISECT_ENTRY_NODE_KEY,
          args: { regressionThresholdPct: { value: 10 } },
        },
        {
          when: {
            all: [
              {
                path: "result.confidence",
                op: "greaterThanInclusive",
                value: 0.7,
              },
              {
                path: "result.routeKey",
                op: "equal",
                value: "browser-repro-investigate",
              },
            ],
          },
          to: BROWSER_REPRO_ENTRY_NODE_KEY,
        },
      ],
      otherwise: { to: "unroutable" },
    },
  },
];

export const TRIAGE_AND_INVESTIGATE_PIPELINE: DemoFlagshipPipelineFixture = {
  key: TRIAGE_AND_INVESTIGATE_PIPELINE_KEY,
  name: "Triage & Investigate",
  description:
    "Gate on ticket quality, label impact, then branch to the investigation built for this class of problem — a browser repro, or a performance bisect.",
  entryNodeKey: INTAKE_ENTRY_NODE_KEY,
  steps: [
    ...INTAKE_STEPS,
    ...PERF_BISECT_BRANCH_STEPS,
    ...BROWSER_REPRO_BRANCH_STEPS,
  ],
  waitNodes: {
    "ask-for-details": {
      kind: "wait",
      for: "reply",
      maxRuns: 2,
      catch: [{ on: ["Scarn.MaxRunsExceeded"], to: "insufficient-detail" }],
      next: {
        routes: [{ to: INTAKE_ENTRY_NODE_KEY }],
      },
    },
  },
  endNodes: {
    done: { kind: "succeed" },
    "insufficient-detail": { kind: "fail", error: "InsufficientDetail" },
    unroutable: { kind: "fail", error: "Unroutable" },
    "regression-unconfirmed": {
      kind: "fail",
      error: "RegressionUnconfirmed",
    },
    "not-reproduced": { kind: "fail", error: "NotReproduced" },
    "root-cause-unidentified": {
      kind: "fail",
      error: "RootCauseUnidentified",
    },
  },
};
