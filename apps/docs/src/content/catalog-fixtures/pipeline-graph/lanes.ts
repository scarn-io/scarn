import {
  decision,
  definePipeline,
  each,
  equal,
  fail,
  succeed,
  workItem,
} from "@scarn/sdk/pipelines";
import { z } from "zod";
import * as steps from "./steps";

const planChanges = steps.planChanges.as("planChanges");
const editFile = steps.editFile.as("editFile");
const reviewEdit = steps.reviewEdit.as("reviewEdit");
const openPr = steps.openPr.as("openPr");
const approveReviews = decision("approveReviews", {
  input: z.object({ reviews: z.array(z.object({ approved: z.boolean() })) }),
  actions: {
    approve: { label: "Approve" },
    reject: { label: "Reject" },
  },
});
const done = succeed("done");
const changesRejected = fail("changesRejected", { error: "ChangesRejected" });

export default definePipeline({
  key: "catalog-lanes",
  title: "Edit and review each file",
  start: planChanges({ request: workItem.title }),
  flow: [
    planChanges
      .settings({ title: "Plan changes" })
      .next((r) =>
        each(r.result.files, { maxConcurrency: 5 }, (file) =>
          editFile({ file, planSummary: r.result.summary }),
        ),
      ),
    editFile
      .settings({ title: "Edit one file" })
      .next((r) => reviewEdit({ path: r.result.path, diff: r.result.diff })),
    reviewEdit
      .settings({ title: "Review the edit" })
      .next((r) => approveReviews.partial({ reviews: [r.result] })),
    approveReviews.settings({ title: "Approve the reviews" }).next({
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
    openPr.settings({ title: "Open a pull request" }).next(done),
  ],
});
