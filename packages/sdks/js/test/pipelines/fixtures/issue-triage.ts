import { z } from "zod";
import { codeStep } from "@scarn/sdk/definitions/steps";
import {
  decision,
  definePipeline,
  each,
  equal,
  fail,
  greaterThan,
  isEmpty,
  not,
  workItem,
} from "@scarn/sdk/pipelines";

const notRun = (): never => {
  throw new Error("fixture steps never run");
};

export const classifyIssue = codeStep({
  key: "classify-issue",
  name: "Classify issue",
  inputSchema: z.object({ title: z.string() }),
  resultSchema: z.object({
    appUrl: z.string(),
    category: z.string(),
    summary: z.string(),
    affectedPages: z.array(z.string()),
    duplicateCount: z.int(),
    duplicateIds: z.array(z.string()),
  }),
  fn: notRun,
});

export const reproduceInBrowser = codeStep({
  key: "reproduce-in-browser",
  name: "Reproduce in browser",
  inputSchema: z.object({ appUrl: z.string() }),
  resultSchema: z.object({
    reproduced: z.boolean(),
    observedBehavior: z.string(),
  }),
  fn: notRun,
});

export const writeFailingTest = codeStep({
  key: "write-failing-test",
  name: "Write failing test",
  inputSchema: z.object({
    observedBehavior: z.string(),
    securityNotes: z.string().nullable().optional(),
  }),
  resultSchema: z.object({ testPath: z.string() }),
  fn: notRun,
});

export const notifySecurity = codeStep({
  key: "notify-security",
  name: "Notify security",
  inputSchema: z.object({ summary: z.string() }),
  resultSchema: z.object({ notified: z.boolean() }),
  fn: notRun,
});

export const captureScreenshot = codeStep({
  key: "capture-screenshot",
  name: "Capture screenshot",
  inputSchema: z.object({ url: z.string() }),
  resultSchema: z.object({ url: z.string() }),
  fn: notRun,
});

export const linkDuplicates = codeStep({
  key: "link-duplicates",
  name: "Link duplicates",
  inputSchema: z.object({ ids: z.array(z.string()) }),
  resultSchema: z.object({ linked: z.int() }),
  fn: notRun,
});

export const addToBacklog = codeStep({
  key: "add-to-backlog",
  name: "Add to backlog",
  inputSchema: z.object({ summary: z.string() }),
  resultSchema: z.object({ id: z.string() }),
  fn: notRun,
});

export const summarise = codeStep({
  key: "summarise",
  name: "Summarise",
  inputSchema: z.object({
    failingTest: z.string().optional(),
    screenshots: z.array(z.string()),
  }),
  resultSchema: z.object({ urgent: z.boolean(), text: z.string() }),
  fn: notRun,
});

const noInput = z.object({});
const done = z.object({ ok: z.boolean() });

export const openPr = codeStep({
  key: "open-pr",
  name: "Open PR",
  inputSchema: noInput,
  resultSchema: done,
  fn: notRun,
});

export const postToSlack = codeStep({
  key: "post-to-slack",
  name: "Post to Slack",
  inputSchema: noInput,
  resultSchema: done,
  fn: notRun,
});

export const updateTracker = codeStep({
  key: "update-tracker",
  name: "Update tracker",
  inputSchema: noInput,
  resultSchema: done,
  fn: notRun,
});

const securitySignOff = decision("security-sign-off", {
  actions: {
    approve: { label: "Approve" },
    reject: { label: "Reject" },
  },
});
const notReproduced = fail("not-reproduced", { error: "NotReproduced" });

/** The plan's `match: "all"` example: routes that run side by side, a partial merge and a closing merge. */
export default definePipeline({
  key: "issue-triage",
  start: classifyIssue({ title: workItem.title }),
  flow: [
    classifyIssue.next({
      match: "all",
      routes: [
        { to: (r) => reproduceInBrowser({ appUrl: r.result.appUrl }) },
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
        {
          when: (r) => greaterThan(r.result.duplicateCount, 0),
          to: (r) => linkDuplicates({ ids: r.result.duplicateIds }),
        },
      ],
      otherwise: (r) => addToBacklog({ summary: r.result.summary }),
    }),

    reproduceInBrowser.next({
      routes: [
        {
          when: (r) => equal(r.result.reproduced, true),
          to: (r) =>
            writeFailingTest.partial({
              observedBehavior: r.result.observedBehavior,
            }),
        },
      ],
      otherwise: notReproduced,
    }),

    notifySecurity.next(securitySignOff),
    securitySignOff.next((r) =>
      writeFailingTest.partial({ securityNotes: r.result.body }),
    ),

    writeFailingTest.next((r) =>
      summarise.partial({ failingTest: r.result.testPath }),
    ),

    captureScreenshot.next((r) =>
      summarise.partial({ screenshots: [r.result.url] }),
    ),

    summarise.next({
      match: "all",
      routes: [
        { to: openPr },
        { when: (r) => equal(r.result.urgent, true), to: postToSlack },
        { to: updateTracker },
      ],
    }),
  ],
});
