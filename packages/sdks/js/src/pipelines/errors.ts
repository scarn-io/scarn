/**
 * Build errors: problems `definePipeline` finds while compiling. Each one
 * carries the TS source site and the JSON pointer it applies to, and prints as
 * `file.ts:42 (/nodes/x/next/routes/0/args/plan): message`.
 */
import { captureSite, formatSite, type SourceSite } from "./source";

export interface BuildIssue {
  site: SourceSite | null;
  /** JSON pointer into the compiled document; "" for the whole document. */
  pointer: string;
  message: string;
}

export function formatIssue(issue: BuildIssue): string {
  return `${formatSite(issue.site)} (${issue.pointer === "" ? "/" : issue.pointer}): ${issue.message}`;
}

/** Thrown by `definePipeline` when the pipeline can't be compiled. */
export class PipelineBuildError extends Error {
  readonly issues: readonly BuildIssue[];

  constructor(key: string, issues: readonly BuildIssue[]) {
    super(
      `Pipeline "${key}" has ${String(issues.length)} build error${issues.length === 1 ? "" : "s"}:\n${issues.map((issue) => `  ${formatIssue(issue)}`).join("\n")}`,
    );
    this.name = "PipelineBuildError";
    this.issues = issues;
  }
}

/**
 * Thrown while authoring code runs (a coerced placeholder, a bad spread);
 * the compiler turns it into a `BuildIssue` at the pointer being compiled.
 */
export class AuthoringError extends Error {
  readonly site: SourceSite | null;

  constructor(message: string, site: SourceSite | null = captureSite()) {
    super(message);
    this.name = "AuthoringError";
    this.site = site;
  }
}
