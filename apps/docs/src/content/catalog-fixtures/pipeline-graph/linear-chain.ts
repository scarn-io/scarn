import { definePipeline, succeed } from "@scarn/sdk/pipelines";
import * as steps from "./steps";

const intake = steps.intake.as("intake");
const analyze = steps.analyze.as("analyze");
const summarize = steps.summarize.as("summarize");

export default definePipeline({
  key: "catalog-linear-chain",
  title: "Triage a bug report",
  start: intake,
  flow: [
    intake.settings({ title: "Read report" }).next(analyze),
    analyze.settings({ title: "Analyze severity" }).next(summarize),
    summarize.settings({ title: "Write summary" }).next(succeed("done")),
  ],
});
