import { equal } from "@scarn/sdk/pipelines";
import { defineAutomation, onEvent, skip } from "@scarn/sdk/automations";
import ldChoice from "./ld-choice";
import ldDecision from "./ld-decision";
import ldErrors from "./ld-errors";
import ldGrill from "./ld-grill";
import ldLanesMerge from "./ld-lanes-merge";
import ldLinear from "./ld-linear";
import ldLoop from "./ld-loop";
import ldCodestepWithMcp from "./ld-codestep-with-mcp";
import ldMerges from "./ld-merges";
import ldReply from "./ld-reply";
import ldRoutesAll from "./ld-routes-all";
import ldSecrets from "./ld-secrets";

/**
 * Closed items are never ready, so they never reach this rule. Resolved items
 * are skipped; `fields.demo` (a pipeline key without `ld-`) picks the
 * pipeline; anything else runs `ld-linear`, including the items the
 * `ld-schedule` automation creates (`demo: "schedule"`).
 */
export default defineAutomation({
  key: "default",
  title: "Local dev default",
  scope: "project",
  rules: [
    onEvent({
      key: "route-ready",
      event: "workItem.ready",
      routes: [
        {
          when: (r) => equal(r.workItem.fields.status, "resolved"),
          to: skip,
        },
        {
          when: (r) => equal(r.workItem.fields.demo, "choice"),
          to: ldChoice,
        },
        {
          when: (r) => equal(r.workItem.fields.demo, "decision"),
          to: ldDecision,
        },
        {
          when: (r) => equal(r.workItem.fields.demo, "reply"),
          to: ldReply,
        },
        { when: (r) => equal(r.workItem.fields.demo, "loop"), to: ldLoop },
        {
          when: (r) => equal(r.workItem.fields.demo, "errors"),
          to: ldErrors,
        },
        {
          when: (r) => equal(r.workItem.fields.demo, "lanes-merge"),
          to: ldLanesMerge,
        },
        {
          when: (r) => equal(r.workItem.fields.demo, "routes-all"),
          to: ldRoutesAll,
        },
        {
          when: (r) => equal(r.workItem.fields.demo, "merges"),
          to: ldMerges,
        },
        {
          when: (r) => equal(r.workItem.fields.demo, "grill"),
          to: ldGrill,
        },
        {
          when: (r) => equal(r.workItem.fields.demo, "secrets"),
          to: ldSecrets,
        },
        {
          when: (r) => equal(r.workItem.fields.demo, "codestep-with-mcp"),
          to: ldCodestepWithMcp,
        },
      ],
      otherwise: ldLinear,
    }),
  ],
});
