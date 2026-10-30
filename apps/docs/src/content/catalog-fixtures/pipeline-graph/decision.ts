import {
  decision,
  definePipeline,
  equal,
  fail,
  succeed,
  workItem,
} from "@scarn/sdk/pipelines";
import * as steps from "./steps";

const proposeFix = steps.proposeFix.as("proposeFix");
const applyFix = steps.applyFix.as("applyFix");
const reviewFix = decision("reviewFix", {
  actions: {
    approve: { label: "Approve" },
    revise: { label: "Request changes", body: "required" },
    reject: { label: "Reject" },
  },
});
const done = succeed("done");
const rejected = fail("rejected", { error: "FixRejected" });

export default definePipeline({
  key: "catalog-decision",
  title: "Review a fix before applying it",
  start: proposeFix({ title: workItem.title }),
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
              title: r.node(proposeFix).input.title,
              feedback: r.result.body,
            }),
        },
      ],
      otherwise: rejected,
    }),
    applyFix.settings({ title: "Apply the fix" }).next(done),
  ],
});
