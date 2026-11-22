import type { PipelineDocument } from "@scarn/sdk/contracts/pipeline-document";
import type { DemoStepDefinitionInput } from "./ensure-demo-pipeline-document";

/**
 * The demo project's smallest example of a run that asks a person something
 * and resumes on their reply: one assessment step and a `reply` wait that
 * loops back to it.
 *
 * ```
 * start → assess-report ─ quality < 0.5 → ask-for-details (reply) ─┐
 *            ▲          └ otherwise ────→ done                     │
 *            └─────────────────────────────────────────────────────┘
 * ask-for-details: maxRuns 2; catch Scarn.MaxRunsExceeded → insufficient-detail
 * ```
 *
 * The agent returns ordinary findings; nothing about them is special to
 * asking. The transition into the wait passes `result.missingDetails` as the
 * wait's `questions`, and the engine posts them as an agent question comment.
 * A reply to that comment resumes the run, and `assess-report` runs again
 * on the work item, whose thread now holds the reply.
 */

export const NEEDS_INPUT_PIPELINE_KEY = "ask_the_reporter";
export const NEEDS_INPUT_PIPELINE_NAME = "Ask the Reporter";
export const ASSESS_REPORT_NODE_KEY = "assess-report";
export const ASK_FOR_DETAILS_NODE_KEY = "ask-for-details";

const ASSESS_REPORT_STEP_KEY = `${NEEDS_INPUT_PIPELINE_KEY}_${ASSESS_REPORT_NODE_KEY}`;

export const NEEDS_INPUT_STEP_DEFINITIONS: readonly DemoStepDefinitionInput[] =
  [
    {
      key: ASSESS_REPORT_STEP_KEY,
      name: "Assess Report",
      description:
        "Decides whether a bug report has enough detail to investigate, and asks the reporter when it doesn't.",
      prompt: `Decide whether this bug report has enough detail for an engineer to start
investigating. Judge the title, the description and the comment thread,
including any answers to questions asked earlier.

Report:

- \`quality\`: 0 to 1. Below 0.5 means an engineer couldn't start without
  asking something first.
- \`missingDetails\`: an array of strings, one question each, that would fill
  the gaps, phrased so they can be posted to the reporter verbatim. Empty
  when \`quality\` is 0.5 or more. Don't repeat a question the thread already
  answers.
- \`restatedProblem\`: one or two sentences restating the problem as you
  understand it now.`,
    },
  ];

export const NEEDS_INPUT_PIPELINE_DOCUMENT: PipelineDocument = {
  schemaVersion: 1,
  key: NEEDS_INPUT_PIPELINE_KEY,
  title: NEEDS_INPUT_PIPELINE_NAME,
  start: { to: ASSESS_REPORT_NODE_KEY },
  nodes: {
    [ASSESS_REPORT_NODE_KEY]: {
      kind: "step",
      title: "Assess Report",
      step: ASSESS_REPORT_STEP_KEY,
      next: {
        routes: [
          {
            when: { path: "result.quality", op: "lessThan", value: 0.5 },
            to: ASK_FOR_DETAILS_NODE_KEY,
            args: { questions: "result.missingDetails" },
          },
        ],
        otherwise: { to: "done" },
      },
    },
    [ASK_FOR_DETAILS_NODE_KEY]: {
      kind: "wait",
      for: "reply",
      maxRuns: 2,
      catch: [{ on: ["Scarn.MaxRunsExceeded"], to: "insufficient-detail" }],
      next: {
        routes: [{ to: ASSESS_REPORT_NODE_KEY }],
      },
    },
    done: { kind: "succeed" },
    "insufficient-detail": { kind: "fail", error: "InsufficientDetail" },
  },
};

/** What `assess-report` reports on a thin ticket, before any answer. */
export const THIN_REPORT_RESULT = {
  quality: 0.2,
  missingDetails: [
    "Which export is broken: CSV or PDF?",
    "What happens when you click it: an error, a spinner, or a broken file?",
    "Which browser are you using?",
  ],
  restatedProblem: "Some export on the reports page doesn't work.",
};

/** What `assess-report` reports once the thread answers its questions. */
export const ANSWERED_REPORT_RESULT = {
  quality: 0.85,
  missingDetails: [],
  restatedProblem:
    "The CSV export on the reports page spins forever in Chrome and never downloads a file.",
};

export const DEMO_TEAMMATE_REPLY =
  "CSV, in Chrome. The button shows a spinner forever and no file ever downloads. PDF works fine.";
