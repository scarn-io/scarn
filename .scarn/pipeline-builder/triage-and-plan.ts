import { z } from "zod";
import { defineStep, Runtime } from "@scarn/sdk/definitions/steps";
import {
  decision,
  definePipeline,
  equal,
  fail,
  lessThan,
  succeed,
  workItem,
} from "@scarn/sdk/pipelines";

// Your first Scarn pipeline: two AI steps, with a human check between them.
//
//   work item ──▶ Triage ──(confidence >= 7)──────────────────▶ Write Fix Plan ──▶ done
//                    │                                    ▲
//                    └──(confidence < 7)──▶ Review Triage ┘ (rejected → triage-rejected)
//
// Both steps use `Runtime.host()`, so this pipeline executes without a
// devcontainer, Docker, or a cloned repository.
//
// Try it end to end:
//   1. scarn pipelines push     — upload the steps
//   2. scarn pipelines build    — compile this file into triage-and-plan.json
//   3. scarn pipelines publish .scarn/pipeline-builder/triage-and-plan.json
//   4. create a work item in the dashboard (any bug-shaped title works)
//   5. scarn work               — start a worker, then watch the dashboard

// ─── Step 1: Triage ─────────────────────────────────────────────────────────
// A step is a typed unit of AI work: a prompt, an input schema, and a result
// schema the agent's answer must satisfy.
export const triageStep = defineStep({
  key: "triage",
  name: "Triage",
  description: "Diagnose a work item and rate confidence in the diagnosis.",

  // Runtime.host() steps run without cloning your repository — ideal for
  // analysis and planning. Switch to Runtime.devcontainer() (the default) when
  // the agent needs your code; that requires a .devcontainer in your repo.
  environment: { runtime: Runtime.host() },

  // The step's full input JSON is shown to the agent automatically.
  // Interpolating a field (like ${input.title} below) is optional and only
  // inlines that value into your instructions.
  agentPrompt: ({ input }) => `
You are a senior engineer triaging incoming work.
Diagnose the most likely root cause of: ${input.title}
Summarize the problem, rate its severity, and rate your confidence (0-10) in
the diagnosis.
`,

  // Args the pipeline must pass when it calls this step (see the pipeline at
  // the bottom of this file).
  input: z.object({
    title: z.string(),
  }),

  // The agent's reply must match this schema.
  result: z.object({
    summary: z.string(),
    severity: z.enum(["low", "medium", "high"]),
    confidence: z.number().min(0).max(10),
  }),
  status: "active",
});

// ─── Step 2: Write Fix Plan ─────────────────────────────────────────────────
export const writeFixPlanStep = defineStep({
  key: "write-fix-plan",
  name: "Write Fix Plan",
  description: "Turn a triage summary into a concrete, actionable fix plan.",
  environment: { runtime: Runtime.host() },
  agentPrompt:
    "Using the triage summary in your input, write a short, concrete " +
    "step-by-step plan to fix the issue.",
  input: z.object({
    triageSummary: z.string(),
  }),
  result: z.object({
    plan: z.string(),
  }),
  status: "active",
});

// ─── The pipeline ───────────────────────────────────────────────────────────
// `start` is the first node; each chain in `flow` says where a node goes next.
// `r.result` is the node that just finished; `r.node(step)` an earlier one.
const reviewTriage = decision("review-triage", {
  actions: {
    approve: { label: "Approve" },
    reject: { label: "Reject" },
  },
});
const triageRejected = fail("triage-rejected", { error: "TriageRejected" });
const done = succeed("done");

export default definePipeline({
  key: "triage-and-plan",
  title: "Triage & Plan",
  start: triageStep({ title: workItem.title }),
  flow: [
    // A confident triage goes straight on; anything less waits for a human.
    triageStep.next({
      routes: [
        {
          when: (r) => lessThan(r.result.confidence, 7),
          to: (r) => reviewTriage({ triage: r.result }),
        },
      ],
      otherwise: (r) => writeFixPlanStep({ triageSummary: r.result.summary }),
    }),

    reviewTriage.next({
      routes: [
        {
          when: (r) => equal(r.result.action, "approve"),
          to: (r) =>
            writeFixPlanStep({
              triageSummary: r.node(triageStep).result.summary,
            }),
        },
      ],
      otherwise: triageRejected,
    }),

    writeFixPlanStep.next(done),
  ],
});
