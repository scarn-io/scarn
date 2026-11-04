import { describe, expect, test } from "bun:test";
import {
  validateAutomation,
  type AutomationCatalog,
} from "../../src/automations";
import { expectError } from "../pipelines/helpers";

const catalog: AutomationCatalog = {
  steps: {
    plan: {
      inputSchema: { type: "object", properties: {} },
      resultSchema: { type: "object" },
      errors: [],
    },
    research: {
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["question"],
        additionalProperties: false,
      },
      resultSchema: { type: "object" },
      errors: [],
    },
  },
  pipelines: new Set(["bugfix"]),
  automations: new Map([
    ["wayfinder", "workItem"],
    ["triage", "project"],
  ]),
};

const wayfinder = (rules: object[]) => ({
  kind: "automation",
  schemaVersion: 1,
  key: "wayfinder",
  scope: "workItem",
  rules,
});

const project = (rules: object[]) => ({
  kind: "automation",
  schemaVersion: 1,
  key: "triage",
  scope: "project",
  rules,
});

const research = (args: object, event = "child.ready") => ({
  event,
  next: { routes: [{ kind: "step", to: "research", args, on: "workItem" }] },
});

describe("validateAutomation", () => {
  test.concurrent("accepts a valid work-item automation", () => {
    const result = validateAutomation(
      wayfinder([
        {
          event: "self.attached",
          next: { routes: [{ kind: "step", to: "plan", on: "workItem" }] },
        },
        {
          event: "child.ready",
          next: {
            routes: [
              {
                when: {
                  path: "event.child.labels",
                  op: "contains",
                  value: "wayfinder:research",
                },
                kind: "step",
                to: "research",
                args: {
                  question: "event.child.title",
                  tags: "event.child.labels",
                },
                on: "child",
              },
            ],
            otherwise: { kind: "pipeline", to: "bugfix", on: "child" },
          },
        },
      ]),
      catalog,
    );
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test.concurrent("reports schema errors", () => {
    const result = validateAutomation(
      wayfinder([
        { event: "workItem.created", next: { routes: [{ kind: "skip" }] } },
      ]),
      catalog,
    );
    expectError(result.errors, { path: "/rules/0/event", code: "schema" });
  });

  test.concurrent("reports unknown steps, pipelines and automations", () => {
    const result = validateAutomation(
      project([
        {
          event: "workItem.created",
          next: {
            routes: [
              { kind: "step", to: "resarch", on: "workItem" },
              { kind: "pipeline", to: "missing", on: "workItem" },
              { kind: "attach", automation: "wayfindr" },
            ],
            otherwise: { kind: "attach", automation: "triage" },
          },
        },
      ]),
      catalog,
    );
    const at = "/rules/0/next/routes";
    expectError(result.errors, {
      path: `${at}/0/to`,
      code: "unknown_step",
      hint: 'Did you mean "research"?',
    });
    expectError(result.errors, {
      path: `${at}/1/to`,
      code: "unknown_pipeline",
    });
    expectError(result.errors, {
      path: `${at}/2/automation`,
      code: "unknown_automation",
      hint: 'Did you mean "wayfinder"?',
    });
    expectError(result.errors, {
      path: "/rules/0/next/otherwise/automation",
      messageIncludes: "project automation",
    });
  });

  test.concurrent("checks args against the step input", () => {
    const at = "/rules/0/next/routes/0/args";
    const missing = validateAutomation(wayfinder([research({})]), catalog);
    expectError(missing.errors, {
      path: `${at}/question`,
      code: "missing_arg",
    });

    const extra = validateAutomation(
      wayfinder([research({ question: "event.child.title", questoin: "x" })]),
      catalog,
    );
    expectError(extra.errors, { path: `${at}/questoin`, code: "extra_arg" });

    const mismatched = validateAutomation(
      wayfinder([research({ question: "event.child.labels" })]),
      catalog,
    );
    expectError(mismatched.errors, {
      path: `${at}/question`,
      code: "type_mismatch",
    });

    const literal = validateAutomation(
      wayfinder([research({ question: { value: 3 } })]),
      catalog,
    );
    expectError(literal.errors, {
      path: `${at}/question/value`,
      code: "type_mismatch",
    });

    const field = validateAutomation(
      wayfinder([research({ question: "event.workItem.fields.anything" })]),
      catalog,
    );
    expect(field.errors).toEqual([]);
  });

  test.concurrent("refs must exist on the rule's event", () => {
    const at = "/rules/0/next/routes/0/args/question";
    const child = validateAutomation(
      wayfinder([research({ question: "event.child.title" }, "self.attached")]),
      catalog,
    );
    expectError(child.errors, { path: at, code: "reference_not_allowed" });

    const label = validateAutomation(
      project([
        {
          event: "workItem.created",
          next: {
            routes: [
              {
                kind: "step",
                to: "research",
                args: { question: "event.label" },
                on: "workItem",
              },
            ],
          },
        },
      ]),
      catalog,
    );
    expectError(label.errors, { path: at, code: "reference_not_allowed" });

    const unknown = validateAutomation(
      wayfinder([research({ question: "event.child.titel" })]),
      catalog,
    );
    expectError(unknown.errors, {
      path: at,
      code: "unknown_path",
      hint: 'Did you mean "event.child.title"?',
    });

    const pipelineRef = validateAutomation(
      wayfinder([research({ question: "result.title" })]),
      catalog,
    );
    expectError(pipelineRef.errors, { path: at, code: "invalid_reference" });
  });

  test.concurrent("types conditions against the event", () => {
    const withWhen = (when: object, event = "child.ready") =>
      validateAutomation(
        wayfinder([{ event, next: { routes: [{ when, kind: "skip" }] } }]),
        catalog,
      );
    const at = "/rules/0/next/routes/0/when";
    expect(
      withWhen({ path: "event.workItem.state", op: "equal", value: "open" })
        .errors,
    ).toEqual([]);
    expectError(
      withWhen({ path: "event.workItem.state", op: "equal", value: "done" })
        .errors,
      { path: `${at}/value`, code: "type_mismatch" },
    );
    expectError(
      withWhen({ path: "event.child.title", op: "isEmpty" }, "self.attached")
        .errors,
      { path: `${at}/path`, code: "reference_not_allowed" },
    );
    expectError(
      withWhen({ path: "event.workItem.title", op: "greaterThan", value: 1 })
        .errors,
      { path: `${at}/value`, code: "type_mismatch" },
    );
  });
});
