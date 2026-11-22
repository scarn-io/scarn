/**
 * Reply wait: the agent judges whether the report has enough detail, steered
 * by `fields.detail`. `thin` posts its questions on the work item and the
 * reply loops back into `evaluate` as `answer`; `full` skips the question.
 * Asking more than twice fails the run.
 */
import {
  definePipeline,
  equal,
  fail,
  reply,
  succeed,
  workItem,
  workItemField,
} from "@scarn/sdk/pipelines";
import { evaluate, triage } from "./steps";

const askForDetails = reply("ask-for-details");
const done = succeed("done");
const noDetail = fail("no-detail", { error: "InsufficientDetail" });

export default definePipeline({
  key: "ld-reply",
  title: "Local dev: ask for details",
  start: evaluate({
    title: workItem.title,
    description: workItem.description,
    detail: workItemField("detail", "detail"),
  }),
  flow: [
    evaluate.settings({ title: "Evaluate detail", maxRuns: 3 }).next({
      routes: [
        {
          when: (r) => equal(r.result.complete, true),
          to: (r) => triage({ ...r.input }),
        },
      ],
      otherwise: (r) => askForDetails({ questions: r.result.questions }),
    }),
    askForDetails
      .settings({ title: "Ask for details", maxRuns: 2 })
      .catch(["Scarn.MaxRunsExceeded"], noDetail)
      .next((r) =>
        evaluate({
          ...r.node(evaluate).input,
          answer: r.result.body,
        }),
      ),
    triage.settings({ title: "Triage" }).next(done),
  ],
});
