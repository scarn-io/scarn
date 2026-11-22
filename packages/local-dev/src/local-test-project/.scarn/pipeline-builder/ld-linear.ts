/**
 * Linear chain: intake → analyze → summarize → done. Also the default
 * automation's `otherwise`, so a work item with no `demo` field lands here.
 */
import { definePipeline, succeed, workItem } from "@scarn/sdk/pipelines";
import { analyze, intake, summarize } from "./steps";

const done = succeed("done");

export default definePipeline({
  key: "ld-linear",
  title: "Local dev: linear chain",
  start: intake({
    title: workItem.title,
    description: workItem.description,
  }),
  flow: [
    intake
      .settings({ title: "Read the report" })
      .next((r) => analyze({ report: r.result })),
    analyze
      .settings({ title: "Analyze severity" })
      .next((r) => summarize({ analysis: r.result })),
    summarize.settings({ title: "Write a summary" }).next(done),
  ],
});
