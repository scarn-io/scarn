/**
 * Deterministic code steps for the `ld-merges` pipeline. Like `steps.ts`,
 * inputs arrive as raw JSON, so every optional field is defaulted inside `fn`.
 */
import { codeStep } from "@scarn/sdk/definitions/steps";
import { z } from "zod";

const service = z.object({ name: z.string(), healthy: z.boolean() });
const suiteResult = z.object({ suite: z.string(), passed: z.boolean() });

export const prepareRelease = codeStep({
  key: "prepare-release",
  name: "Prepare release",
  inputSchema: z.object({
    title: z.string(),
    services: z.array(z.string()).optional(),
    unhealthy: z.array(z.string()).optional(),
    failingSuite: z.string().optional(),
    scan: z.boolean().optional(),
    advisories: z.number().optional(),
  }),
  resultSchema: z.object({
    version: z.string(),
    services: z.array(service),
    failingSuite: z.string(),
    scan: z.boolean(),
    advisories: z.number(),
  }),
  fn: ({ services, unhealthy, failingSuite, scan, advisories }) => ({
    version: "1.4.0",
    services: (services ?? ["api", "web"]).map((name) => ({
      name,
      healthy: !(unhealthy ?? []).includes(name),
    })),
    failingSuite: failingSuite ?? "none",
    scan: scan ?? false,
    advisories: advisories ?? 0,
  }),
});

export const runUnitTests = codeStep({
  key: "run-unit-tests",
  name: "Run unit tests",
  inputSchema: z.object({ version: z.string(), failingSuite: z.string() }),
  resultSchema: suiteResult,
  fn: ({ failingSuite }) => ({
    suite: "unit",
    passed: failingSuite !== "unit",
  }),
});

export const runE2eTests = codeStep({
  key: "run-e2e-tests",
  name: "Run e2e tests",
  inputSchema: z.object({ version: z.string(), failingSuite: z.string() }),
  resultSchema: suiteResult,
  fn: ({ failingSuite }) => ({
    suite: "e2e",
    passed: failingSuite !== "e2e",
  }),
});

export const combineTests = codeStep({
  key: "combine-tests",
  name: "Combine test results",
  inputSchema: z.object({ unit: suiteResult, e2e: suiteResult }),
  resultSchema: z.object({
    passed: z.boolean(),
    failedSuites: z.array(z.string()),
  }),
  fn: ({ unit, e2e }) => {
    const failedSuites = [unit, e2e]
      .filter((result) => !result.passed)
      .map((result) => result.suite);
    return { passed: failedSuites.length === 0, failedSuites };
  },
});

export const scanDependencies = codeStep({
  key: "scan-dependencies",
  name: "Scan dependencies",
  inputSchema: z.object({ version: z.string(), advisories: z.number() }),
  resultSchema: z.object({ advisories: z.number() }),
  fn: ({ advisories }) => ({ advisories }),
});

export const checkService = codeStep({
  key: "check-service",
  name: "Check service health",
  inputSchema: service,
  resultSchema: service,
  fn: ({ name, healthy }) => ({ name, healthy }),
});

export const decideRelease = codeStep({
  key: "decide-release",
  name: "Decide release",
  inputSchema: z.object({
    tests: z.object({
      passed: z.boolean(),
      failedSuites: z.array(z.string()),
    }),
    advisories: z.number().optional(),
    unhealthyServices: z.array(service),
  }),
  resultSchema: z.object({
    blocked: z.boolean(),
    reasons: z.array(z.string()),
  }),
  fn: ({ tests, advisories, unhealthyServices }) => {
    const reasons = [
      ...tests.failedSuites.map((suite) => `${suite} tests failed`),
      ...((advisories ?? 0) > 0
        ? [`${String(advisories)} dependency advisories`]
        : []),
      ...unhealthyServices.map((entry) => `${entry.name} is unhealthy`),
    ];
    return { blocked: reasons.length > 0, reasons };
  },
});
