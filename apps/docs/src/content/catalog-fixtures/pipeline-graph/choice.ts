import { definePipeline, equal, succeed } from "@scarn/sdk/pipelines";
import * as steps from "./steps";

const classify = steps.classify.as("classify");
const pageOncall = steps.pageOncall.as("pageOncall");
const fileTicket = steps.fileTicket.as("fileTicket");

export default definePipeline({
  key: "catalog-choice",
  title: "Route an incident by severity",
  start: classify,
  flow: [
    classify.settings({ title: "Classify severity" }).next({
      routes: [
        { when: (r) => equal(r.result.severity, "critical"), to: pageOncall },
      ],
      otherwise: fileTicket,
    }),
    pageOncall.settings({ title: "Page on-call" }).next(succeed("paged")),
    fileTicket.settings({ title: "File a ticket" }).next(succeed("ticketed")),
  ],
});
