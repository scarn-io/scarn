import { z } from "zod";
import { codeStep } from "@scarn/sdk/definitions/steps";
import {
  decision,
  definePipeline,
  equal,
  each,
  fail,
  succeed,
  workItem,
} from "@scarn/sdk/pipelines";

const notRun = (): never => {
  throw new Error("fixture steps never run");
};

const reviewResult = z.object({
  approved: z.boolean(),
  confidence: z.number(),
  notes: z.string(),
});

export const planChanges = codeStep({
  key: "plan-changes",
  name: "Plan changes",
  inputSchema: z.object({ request: z.string() }),
  resultSchema: z.object({
    files: z.array(z.string()),
    summary: z.string(),
    count: z.int(),
  }),
  fn: notRun,
});

export const editFile = codeStep({
  key: "edit-file",
  name: "Edit file",
  inputSchema: z.object({ file: z.string(), planSummary: z.string() }),
  resultSchema: z.object({ path: z.string(), diff: z.string() }),
  fn: notRun,
});

export const reviewEdit = codeStep({
  key: "review-edit",
  name: "Review edit",
  inputSchema: z.object({ path: z.string(), diff: z.string() }),
  resultSchema: reviewResult,
  fn: notRun,
});

export const openPr = codeStep({
  key: "open-pr",
  name: "Open PR",
  inputSchema: z.object({
    request: z.string(),
    reviews: z.array(reviewResult),
  }),
  resultSchema: z.object({ url: z.string() }),
  fn: notRun,
});

const approveReviews = decision("approve-reviews", {
  input: z.object({ reviews: z.array(reviewResult) }),
  actions: {
    approve: { label: "Approve" },
    reject: { label: "Reject" },
  },
});
const done = succeed("done");
const changesRejected = fail("changes-rejected", { error: "ChangesRejected" });

export default definePipeline({
  key: "items-pipeline",
  start: planChanges({ request: workItem.title }),
  flow: [
    planChanges.next((r) =>
      each(
        r.result.files,
        { maxConcurrency: 5, toleratedFailures: { count: 1 } },
        (file) => editFile({ file, planSummary: r.result.summary }),
      ),
    ),

    editFile.next((r) =>
      reviewEdit({ path: r.result.path, diff: r.result.diff }),
    ),

    reviewEdit.next((r) => approveReviews.partial({ reviews: [r.result] })),

    approveReviews.next({
      routes: [
        {
          when: (r) => equal(r.result.action, "approve"),
          to: (r) =>
            openPr({
              request: r.node(planChanges).input.request,
              reviews: r.input.reviews,
            }),
        },
      ],
      otherwise: changesRejected,
    }),

    openPr.next(done),
  ],
});
