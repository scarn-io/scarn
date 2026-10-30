import {
  definePipeline,
  each,
  equal,
  isEmpty,
  not,
  succeed,
  workItem,
} from "@scarn/sdk/pipelines";
import * as steps from "./steps";

const classifyIssue = steps.classifyIssue.as("classifyIssue");
const reproduceBug = steps.reproduceBug.as("reproduceBug");
const notifySecurity = steps.notifySecurity.as("notifySecurity");
const writeFailingTest = steps.writeFailingTest.as("writeFailingTest");
const captureScreenshot = steps.captureScreenshot.as("captureScreenshot");
const addToBacklog = steps.addToBacklog.as("addToBacklog");
const summariseFindings = steps.summariseFindings.as("summariseFindings");

export default definePipeline({
  key: "catalog-routes-all",
  title: "Triage an issue on every matching route",
  start: classifyIssue({ title: workItem.title }),
  flow: [
    classifyIssue.settings({ title: "Classify issue" }).next({
      match: "all",
      routes: [
        { to: (r) => reproduceBug({ appUrl: r.result.appUrl }) },
        {
          when: (r) => equal(r.result.category, "security"),
          to: (r) => notifySecurity({ summary: r.result.summary }),
        },
        {
          when: (r) => not(isEmpty(r.result.affectedPages)),
          to: (r) =>
            each(r.result.affectedPages, { maxConcurrency: 3 }, (page) =>
              captureScreenshot({ url: page }),
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
    captureScreenshot
      .settings({ title: "Capture screenshot" })
      .next((r) => summariseFindings.partial({ screenshots: [r.result.url] })),
    summariseFindings
      .settings({ title: "Summarise findings" })
      .next(succeed("triaged")),
  ],
});
