/**
 * Automation targets at run time: `skip`, `attach(...)` and `.on(...)` on a
 * step call or pipeline. Each is an opaque frozen value whose data lives in
 * a WeakMap, like pipeline targets. This module imports nothing that builds
 * handles, so step handles and `definePipeline` can attach `.on` without an
 * import cycle.
 */
import type { AutomationSubject } from "../contracts/automation-document";
import { AuthoringError } from "../pipelines/errors";
import type { TargetData } from "../pipelines/model";
import { captureSite, type SourceSite } from "../pipelines/source";

const SUBJECT = Symbol("scarn.automation.subject");

export type AutomationTargetData =
  | {
      kind: "step";
      target: TargetData;
      on: AutomationSubject;
      site: SourceSite | null;
    }
  | {
      kind: "pipeline";
      pipeline: string;
      on: AutomationSubject;
      site: SourceSite | null;
    }
  | { kind: "attach"; automation: string; site: SourceSite | null }
  | { kind: "skip"; site: SourceSite | null };

const targets = new WeakMap<object, AutomationTargetData>();

export function registerAutomationTarget(data: AutomationTargetData): object {
  const value = Object.freeze({ _tag: "automation_target", kind: data.kind });
  targets.set(value, data);
  return value;
}

export function automationTargetOf(
  // eslint-disable-next-line local/no-unknown-parameter-type -- inspects author values
  value: unknown,
): AutomationTargetData | undefined {
  return (typeof value === "object" || typeof value === "function") &&
    value !== null
    ? targets.get(value)
    : undefined;
}

/** Marks `value` as `r.workItem` or `r.child`, for `.on(...)`. */
export function markSubject<T extends object>(
  value: T,
  subject: AutomationSubject,
): T {
  Object.defineProperty(value, SUBJECT, { value: subject, enumerable: false });
  return value;
}

// eslint-disable-next-line local/no-unknown-parameter-type -- inspects author values
function subjectOf(value: unknown): AutomationSubject {
  const subject =
    typeof value === "object" && value !== null && SUBJECT in value
      ? (value as { [SUBJECT]: AutomationSubject })[SUBJECT]
      : undefined;
  if (subject === undefined) {
    throw new AuthoringError(
      ".on(...) takes the work item to start for: r.workItem, or r.child on child.* events",
    );
  }
  return subject;
}

/** `.on(subject)` on a step call: the step's Task, for that work item. */
export function stepOn(target: TargetData): (subject: object) => object {
  return (subject: object) =>
    registerAutomationTarget({
      kind: "step",
      target,
      on: subjectOf(subject),
      site: captureSite(),
    });
}

/** `.on(subject)` on a pipeline: a run of it, for that work item. */
export function pipelineOn(pipeline: string): (subject: object) => object {
  return (subject: object) =>
    registerAutomationTarget({
      kind: "pipeline",
      pipeline,
      on: subjectOf(subject),
      site: captureSite(),
    });
}
