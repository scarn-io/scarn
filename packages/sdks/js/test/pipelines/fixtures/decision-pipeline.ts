import { z } from "zod";
import { codeStep } from "@scarn/sdk/definitions/steps";
import {
  decision,
  definePipeline,
  equal,
  fail,
  succeed,
  workItem,
} from "@scarn/sdk/pipelines";

const notRun = (): never => {
  throw new Error("fixture steps never run");
};

const plan = z.object({ summary: z.string() });

export const proposeFix = codeStep({
  key: "propose-fix",
  name: "Propose fix",
  inputSchema: z.object({
    title: z.string(),
    feedback: z.string().nullable().optional(),
  }),
  resultSchema: plan,
  fn: notRun,
});

export const applyFix = codeStep({
  key: "apply-fix",
  name: "Apply fix",
  inputSchema: z.object({ plan }),
  resultSchema: z.object({ applied: z.boolean() }),
  fn: notRun,
});

export const reviewFix = decision("review-fix", {
  input: z.object({ plan }),
  actions: {
    approve: { label: "Approve" },
    revise: { label: "Request changes", body: "required" },
    reject: { label: "Reject" },
  },
});

const done = succeed("done");
const rejected = fail("rejected", { error: "FixRejected" });

export default definePipeline({
  key: "decision-loop",
  title: "Review a fix, sending it back until it's right",
  start: proposeFix({ title: workItem.title }),
  flow: [
    proposeFix.next((r) => reviewFix({ plan: r.result })),
    reviewFix.settings({ title: "Review the fix" }).next({
      routes: [
        {
          when: (r) => equal(r.result.action, "approve"),
          to: (r) => applyFix({ plan: r.node(proposeFix).result }),
        },
        {
          when: (r) => equal(r.result.action, "revise"),
          to: (r) =>
            proposeFix({ title: workItem.title, feedback: r.result.body }),
        },
      ],
      otherwise: rejected,
    }),
    applyFix.next(done),
  ],
});
