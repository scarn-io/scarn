/**
 * Decision wait: the agent plans a fix, and `fields.requiresApproval` steers
 * whether a person must review it. Approving applies the plan reached back from
 * `proposeFix`; requesting changes sends the notes back to `proposeFix` as
 * `feedback` and asks again, as many times as you like; rejecting fails the
 * run.
 */
import {
  decision,
  definePipeline,
  equal,
  fail,
  succeed,
  workItem,
  workItemField,
} from "@scarn/sdk/pipelines";
import { z } from "zod";
import { applyFix, proposeFix } from "./steps";

const requiresApproval = workItemField("requiresApproval", "requiresApproval");

const reviewFix = decision("review-fix", {
  input: z.object({
    plan: z.object({
      requiresHumanApproval: z.boolean(),
      summary: z.string(),
      steps: z.array(z.string()),
    }),
  }),
  actions: {
    approve: { label: "Approve" },
    revise: { label: "Request changes", body: "required" },
    reject: { label: "Reject" },
  },
});
const done = succeed("done");
const rejected = fail("rejected", { error: "FixRejected" });

export default definePipeline({
  key: "ld-decision",
  title: "Local dev: review a fix",
  start: proposeFix({
    title: workItem.title,
    description: workItem.description,
    requiresApproval,
  }),
  flow: [
    proposeFix.settings({ title: "Propose a fix" }).next({
      routes: [
        {
          when: (r) => equal(r.result.requiresHumanApproval, true),
          to: (r) => reviewFix({ plan: r.result }),
        },
      ],
      otherwise: (r) => applyFix({ plan: r.result }),
    }),
    reviewFix.settings({ title: "Review the fix" }).next({
      routes: [
        {
          when: (r) => equal(r.result.action, "approve"),
          to: (r) => applyFix({ plan: r.node(proposeFix).result }),
        },
        {
          when: (r) => equal(r.result.action, "revise"),
          to: (r) =>
            proposeFix({
              title: workItem.title,
              description: workItem.description,
              requiresApproval,
              feedback: r.result.body,
            }),
        },
      ],
      otherwise: rejected,
    }),
    applyFix.settings({ title: "Apply the fix" }).next(done),
  ],
});
