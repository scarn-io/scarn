import { z } from "zod";
import { defineStep, Runtime } from "@scarn/sdk/definitions/steps";
import { definePipeline, succeed, workItem } from "@scarn/sdk/pipelines";

// A grilling session over a work item: the agent works the /grilling skill's
// design tree in rounds, handing the conversation to a person at the end of
// each round, and submits the settled decisions once they confirm.
//
//   work item ──▶ Grill (up to 20 hand-offs) ──▶ done
//
// Each round is one turn: the agent ends its turn, its final message lands in
// the step's conversation, and the reply restores its session (needs-input
// slice 2b). `Runtime.host()` keeps it runnable without a devcontainer.

export const grillStep = defineStep({
  key: "grill",
  name: "Grill",
  description:
    "Stress-test the plan or decision in a work item with a person, round by round.",
  environment: { runtime: Runtime.host() },
  agentPrompt: ({ input }) => `
Grill the person about this plan or decision until you reach a shared
understanding: ${input.topic}

The work item's comments in your input may hold more context.

Use the /grilling skill. Work the design tree in rounds: each round, ask the
whole frontier as numbered questions, each with your recommended answer, then
end your turn. Your final message is sent to the person, and you continue in
this conversation when they reply. If they ask you something instead of
answering, explain, then end your turn again.

When the frontier is empty, end one more turn with a short summary of every
decision and ask them to confirm it. After they confirm, submit your findings.
If you are told you can't hand back again, submit what's settled and list what's
still open.
`,
  input: z.object({
    topic: z.string(),
  }),
  result: z.object({
    summary: z.string(),
    decisions: z.array(
      z.object({
        question: z.string(),
        answer: z.string(),
      }),
    ),
    openQuestions: z.array(z.string()),
  }),
  status: "active",
});

const done = succeed("done");

export default definePipeline({
  key: "grill",
  title: "Grill",
  start: grillStep({ topic: workItem.title }),
  flow: [grillStep.settings({ maxTurns: 20 }).next(done)],
});
