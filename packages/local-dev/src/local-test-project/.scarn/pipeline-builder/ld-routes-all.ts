/**
 * `match: "all"`: reproduce always runs; a `security` category (steered by
 * `fields.category`) adds a security lane that merges with it into
 * `writeFailingTest`; non-empty affected pages (steered by
 * `fields.affectedPages`) add an inspection lane per page. With neither, the
 * `otherwise` lane adds the item to the backlog. Every lane closes at
 * `summariseFindings`.
 */
import {
  definePipeline,
  each,
  equal,
  isEmpty,
  not,
  succeed,
  workItem,
  workItemField,
} from "@scarn/sdk/pipelines";
import {
  addToBacklog,
  classifyIssue,
  inspectPage,
  notifySecurity,
  reproduceBug,
  summariseFindings,
  writeFailingTest,
} from "./routes-all-steps";

const triaged = succeed("triaged");

export default definePipeline({
  key: "ld-routes-all",
  title: "Local dev: triage on every matching route",
  start: classifyIssue({
    title: workItem.title,
    description: workItem.description,
    category: workItemField("category", "category"),
    affectedPages: workItemField("affectedPages", "affectedPages"),
  }),
  flow: [
    classifyIssue.settings({ title: "Classify issue" }).next({
      match: "all",
      routes: [
        {
          to: (r) =>
            reproduceBug({
              appUrl: r.result.appUrl,
              summary: r.result.summary,
            }),
        },
        {
          when: (r) => equal(r.result.category, "security"),
          to: (r) => notifySecurity({ summary: r.result.summary }),
        },
        {
          when: (r) => not(isEmpty(r.result.affectedPages)),
          to: (r) =>
            each(r.result.affectedPages, { maxConcurrency: 3 }, (page) =>
              inspectPage({ path: page }),
            ),
        },
      ],
      otherwise: (r) => addToBacklog({ summary: r.result.summary }),
    }),
    reproduceBug.settings({ title: "Reproduce bug" }).next((r) =>
      writeFailingTest.partial({
        observedBehavior: r.result.observedBehavior,
      }),
    ),
    notifySecurity
      .settings({ title: "Notify security" })
      .next((r) => writeFailingTest.partial({ securityNotes: r.result.notes })),
    writeFailingTest
      .settings({ title: "Write failing test" })
      .next((r) =>
        summariseFindings.partial({ failingTest: r.result.testPath }),
      ),
    inspectPage
      .settings({ title: "Inspect page" })
      .next((r) => summariseFindings.partial({ pages: [r.result] })),
    addToBacklog
      .settings({ title: "Add to backlog" })
      .next((r) => summariseFindings.partial({ backlogTitle: r.result.title })),
    summariseFindings.settings({ title: "Summarise findings" }).next(triaged),
  ],
});
