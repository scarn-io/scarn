import { z } from "zod";
import { codeStep } from "@scarn/sdk/definitions/steps";

const notRun = (): never => {
  throw new Error("fixture steps never run");
};

const plan = z.object({
  requiresHumanApproval: z.boolean(),
  summary: z.string(),
});

export const proposeFix = codeStep({
  key: "propose-fix",
  name: "Propose fix",
  inputSchema: z.object({
    title: z.string(),
    feedback: z.string().nullable().optional(),
  }),
  resultSchema: plan,
  fn: notRun,
});

export const applyFix = codeStep({
  key: "apply-fix",
  name: "Apply fix",
  inputSchema: z.object({ plan }),
  resultSchema: z.object({ applied: z.boolean() }),
  fn: notRun,
});

export const classify = codeStep({
  key: "classify-step",
  name: "Classify",
  resultSchema: z.object({ severity: z.enum(["critical", "minor"]) }),
  fn: notRun,
});

export const pageOncall = codeStep({
  key: "page-oncall-step",
  name: "Page",
  fn: notRun,
});
export const fileTicket = codeStep({
  key: "file-ticket-step",
  name: "Ticket",
  fn: notRun,
});
export const intake = codeStep({
  key: "intake-step",
  name: "Intake",
  fn: notRun,
});
export const analyze = codeStep({
  key: "analyze-step",
  name: "Analyze",
  fn: notRun,
});
export const summarize = codeStep({
  key: "summarize-step",
  name: "Summarize",
  fn: notRun,
});

const fixResult = z.object({ testsPass: z.boolean() });

export const fix = codeStep({
  key: "fix",
  name: "Fix",
  inputSchema: z.object({
    title: z.string(),
    previousAttempt: fixResult.optional(),
  }),
  resultSchema: fixResult,
  fn: notRun,
});

const review = z.object({ approved: z.boolean() });

export const planChanges = codeStep({
  key: "plan-changes",
  name: "Plan changes",
  inputSchema: z.object({ request: z.string() }),
  resultSchema: z.object({ files: z.array(z.string()), summary: z.string() }),
  fn: notRun,
});

export const editFile = codeStep({
  key: "edit-file",
  name: "Edit file",
  inputSchema: z.object({ file: z.string(), planSummary: z.string() }),
  resultSchema: z.object({ path: z.string(), diff: z.string() }),
  fn: notRun,
});

export const reviewEdit = codeStep({
  key: "review-edit",
  name: "Review edit",
  inputSchema: z.object({ path: z.string(), diff: z.string() }),
  resultSchema: review,
  fn: notRun,
});

export const openPr = codeStep({
  key: "open-pr",
  name: "Open PR",
  inputSchema: z.object({ request: z.string(), reviews: z.array(review) }),
  resultSchema: z.object({ url: z.string() }),
  fn: notRun,
});

export const classifyIssue = codeStep({
  key: "classify-issue",
  name: "Classify issue",
  inputSchema: z.object({ title: z.string() }),
  resultSchema: z.object({
    appUrl: z.string(),
    category: z.string(),
    summary: z.string(),
    affectedPages: z.array(z.string()),
  }),
  fn: notRun,
});

export const reproduceBug = codeStep({
  key: "reproduce-bug",
  name: "Reproduce bug",
  inputSchema: z.object({ appUrl: z.string() }),
  resultSchema: z.object({ observedBehavior: z.string() }),
  fn: notRun,
});

export const notifySecurity = codeStep({
  key: "notify-security",
  name: "Notify security",
  inputSchema: z.object({ summary: z.string() }),
  resultSchema: z.object({ notes: z.string() }),
  fn: notRun,
});

export const writeFailingTest = codeStep({
  key: "write-failing-test",
  name: "Write failing test",
  inputSchema: z.object({
    observedBehavior: z.string(),
    securityNotes: z.string().optional(),
  }),
  resultSchema: z.object({ testPath: z.string() }),
  fn: notRun,
});

export const captureScreenshot = codeStep({
  key: "capture-screenshot",
  name: "Capture screenshot",
  inputSchema: z.object({ url: z.string() }),
  resultSchema: z.object({ url: z.string() }),
  fn: notRun,
});

export const addToBacklog = codeStep({
  key: "add-to-backlog",
  name: "Add to backlog",
  inputSchema: z.object({ summary: z.string() }),
  resultSchema: z.object({ id: z.string() }),
  fn: notRun,
});

export const summariseFindings = codeStep({
  key: "summarise-findings",
  name: "Summarise findings",
  inputSchema: z.object({
    failingTest: z.string().optional(),
    screenshots: z.array(z.string()),
  }),
  resultSchema: z.object({ text: z.string() }),
  fn: notRun,
});
