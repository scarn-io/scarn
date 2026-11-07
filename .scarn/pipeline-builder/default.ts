import { contains } from "@scarn/sdk/pipelines";
import { defineAutomation, onEvent } from "@scarn/sdk/automations";
import triageAndPlan from "./triage-and-plan";
import bugRepro from "./bug-repro";

// The project automation: which pipeline starts when a work item is ready
// (open, top level, nothing open blocking it). Routes run top to bottom; the
// first match wins, otherwise `otherwise` applies. Push publishes it
// disabled; turn it on with `scarn automations enable default`.
export default defineAutomation({
  key: "default",
  title: "Default",
  scope: "project",
  rules: [
    onEvent({
      event: "workItem.ready",
      routes: [
        // GitHub issues labeled "bug" (e.g. #106, this pipeline's seed item)
        // get reproduced in the browser and encoded as a failing
        // integration test.
        { when: (r) => contains(r.workItem.labels, "bug"), to: bugRepro },
      ],
      otherwise: triageAndPlan,
    }),
  ],
});
