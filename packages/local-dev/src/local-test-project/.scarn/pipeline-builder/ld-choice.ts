/**
 * Conditional `next`, first match wins: the agent classifies the report,
 * steered by `fields.severity`, and its answer picks paged, ticketed
 * (`otherwise`) or the `invalid` fail terminal.
 */
import {
  definePipeline,
  equal,
  fail,
  succeed,
  workItem,
  workItemField,
} from "@scarn/sdk/pipelines";
import { classify, fileTicket, pageOncall } from "./steps";

const paged = succeed("paged");
const ticketed = succeed("ticketed");
const invalid = fail("invalid", { error: "InvalidSeverity" });

export default definePipeline({
  key: "ld-choice",
  title: "Local dev: route by severity",
  start: classify({
    title: workItem.title,
    description: workItem.description,
    severity: workItemField("severity", "severity"),
  }),
  flow: [
    classify.settings({ title: "Classify severity" }).next({
      routes: [
        {
          when: (r) => equal(r.result.severity, "critical"),
          to: (r) =>
            pageOncall({
              title: r.input.title,
              severity: r.result.severity,
              rationale: r.result.rationale,
            }),
        },
        { when: (r) => equal(r.result.severity, "invalid"), to: invalid },
      ],
      otherwise: (r) =>
        fileTicket({
          title: r.input.title,
          severity: r.result.severity,
          rationale: r.result.rationale,
        }),
    }),
    pageOncall.settings({ title: "Page on-call" }).next(paged),
    fileTicket.settings({ title: "File a ticket" }).next(ticketed),
  ],
});
