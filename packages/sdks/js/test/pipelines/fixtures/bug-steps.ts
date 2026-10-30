import { z } from "zod";
import { codeStep } from "@scarn/sdk/definitions/steps";

const notRun = (): never => {
  throw new Error("fixture steps never run");
};

const evaluateResult = z.object({
  quality: z.number(),
  hasRumSession: z.boolean(),
  maxAttempts: z.int(),
  summary: z.string(),
  missingDetails: z.array(z.string()),
});

const reproduceResult = z.object({
  reproductionConfidence: z.number(),
  evidenceVerdict: z.enum(["reproduced", "not_reproduced", "inconclusive"]),
});

const failingTestResult = z.object({ testPath: z.string() });

const proposeFixResult = z.object({
  requiresHumanApproval: z.boolean(),
  summary: z.string(),
});

const fixResult = z.object({
  testsPass: z.boolean(),
  attempts: z.int(),
  changedFiles: z.array(z.string()),
  finishedAt: z.iso.datetime(),
});

const reproduceInput = z.object({
  companyNames: z.string(),
  employeeEmails: z.string(),
  evaluation: evaluateResult,
});

export const evaluate = codeStep({
  key: "evaluate",
  name: "Evaluate",
  inputSchema: z.object({
    companyNames: z.string(),
    employeeEmails: z.string(),
  }),
  resultSchema: evaluateResult,
  fn: notRun,
});

export const reproduceFromSession = codeStep({
  key: "reproduce-from-session",
  name: "Reproduce from session",
  inputSchema: reproduceInput,
  resultSchema: reproduceResult,
  fn: notRun,
});

export const reproduceFromLogs = codeStep({
  key: "reproduce-from-logs",
  name: "Reproduce from logs",
  inputSchema: reproduceInput,
  resultSchema: reproduceResult,
  errors: ["LogsUnavailable"],
  fn: notRun,
});

export const failingTest = codeStep({
  key: "failing-test",
  name: "Failing test",
  inputSchema: z.object({
    evaluation: evaluateResult,
    investigation: reproduceResult,
  }),
  resultSchema: failingTestResult,
  fn: notRun,
});

export const proposeFix = codeStep({
  key: "propose-fix",
  name: "Propose fix",
  inputSchema: z.object({
    evaluation: evaluateResult,
    investigation: reproduceResult,
    failingTest: failingTestResult,
  }),
  resultSchema: proposeFixResult,
  fn: notRun,
});

export const fix = codeStep({
  key: "fix",
  name: "Fix",
  inputSchema: z.object({
    evaluation: evaluateResult,
    investigation: reproduceResult,
    failingTest: failingTestResult,
    plan: proposeFixResult,
    previousAttempt: fixResult.optional(),
  }),
  resultSchema: fixResult,
  errors: ["MergeConflict"],
  fn: notRun,
});
