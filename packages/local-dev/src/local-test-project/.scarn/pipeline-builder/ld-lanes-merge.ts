/**
 * Lanes: the agent plans the change as one `editFile` lane per file
 * (`fields.files` fixes the count), at most two at a time. The first
 * `fields.failFiles` lanes throw; one failure is tolerated. Every lane merges into `collectEdits`, then a person approves the
 * merged list before the PR opens.
 */
import {
  decision,
  definePipeline,
  each,
  equal,
  fail,
  succeed,
  workItem,
  workItemField,
} from "@scarn/sdk/pipelines";
import { z } from "zod";
import { collectEdits, editFile, openPr, planFiles } from "./steps";

const approveEdits = decision("approve-edits", {
  input: z.object({
    edits: z.array(z.object({ path: z.string(), diff: z.string() })),
  }),
  actions: {
    approve: { label: "Approve" },
    reject: { label: "Reject" },
  },
});
const done = succeed("done");
const editsRejected = fail("edits-rejected", { error: "EditsRejected" });

export default definePipeline({
  key: "ld-lanes-merge",
  title: "Local dev: edit files in lanes",
  start: planFiles({
    title: workItem.title,
    description: workItem.description,
    files: workItemField("files", "files"),
    failFiles: workItemField("failFiles", "failFiles"),
  }),
  flow: [
    planFiles
      .settings({ title: "Plan files" })
      .next((r) =>
        each(
          r.result.lanes,
          { maxConcurrency: 2, toleratedFailures: { count: 1 } },
          (lane) => editFile({ path: lane.path, shouldFail: lane.shouldFail }),
        ),
      ),
    editFile
      .settings({ title: "Edit a file" })
      .next((r) => collectEdits.partial({ edits: [r.result] })),
    collectEdits
      .settings({ title: "Collect edits" })
      .next((r) => approveEdits({ edits: r.result.edits })),
    approveEdits.settings({ title: "Approve the edits" }).next({
      routes: [
        {
          when: (r) => equal(r.result.action, "approve"),
          to: (r) =>
            openPr({
              summary: r.node(planFiles).result.summary,
              edits: r.input.edits,
            }),
        },
      ],
      otherwise: editsRejected,
    }),
    openPr.settings({ title: "Open a pull request" }).next(done),
  ],
});
