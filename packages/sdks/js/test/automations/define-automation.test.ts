/**
 * `defineAutomation` compiles rules to the automation document format, and
 * every document it writes passes `automationDocumentSchema`.
 */
import { describe, expect, test } from "bun:test";
import { PipelineBuildError } from "@scarn/sdk/pipelines";
import {
  attach,
  defineAutomation,
  onEvent,
  skip,
  type AutomationDefinition,
} from "@scarn/sdk/automations";
import { automationDocumentSchema } from "@scarn/sdk/contracts/automation-document";
import {
  plan,
  projectDefault,
  research,
  wayfinder,
} from "./fixtures/wayfinder";

function buildError(run: () => unknown): string[] {
  try {
    run();
  } catch (error) {
    if (error instanceof PipelineBuildError) {
      return error.issues.map((issue) => `${issue.pointer}: ${issue.message}`);
    }
    throw error;
  }
  throw new Error("expected a build error");
}

/** Bypasses the types, to check what JS callers get. */
function untyped(config: object): AutomationDefinition {
  return defineAutomation(config as Parameters<typeof defineAutomation>[0]);
}

describe("defineAutomation", () => {
  test("compiles a work-item automation", () => {
    expect(wayfinder._tag).toBe("automation_document");
    expect(wayfinder.key).toBe("wayfinder");
    expect(wayfinder.document).toEqual({
      kind: "automation",
      schemaVersion: 1,
      key: "wayfinder",
      title: "Wayfinder",
      scope: "workItem",
      rules: [
        {
          event: "self.attached",
          next: {
            routes: [{ kind: "step", to: "plan", on: "workItem" }],
          },
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
                args: { question: "event.child.title" },
                on: "child",
              },
            ],
            otherwise: { kind: "skip" },
          },
        },
        {
          event: "child.closed",
          next: {
            routes: [{ kind: "step", to: "plan", on: "workItem" }],
          },
        },
      ],
    });
    expect(automationDocumentSchema.safeParse(wayfinder.document).success).toBe(
      true,
    );
  });

  test("compiles a project automation with attach, pipelines and bare steps", () => {
    expect(projectDefault.document.rules).toEqual([
      {
        event: "workItem.label.added",
        next: {
          match: "all",
          routes: [
            {
              when: { path: "event.label", op: "contains", value: "wayfinder" },
              kind: "attach",
              automation: "wayfinder",
            },
            {
              when: {
                path: "event.workItem.labels",
                op: "contains",
                value: "bug",
              },
              kind: "pipeline",
              to: "triage",
              on: "workItem",
            },
          ],
        },
      },
      {
        event: "workItem.created",
        next: { routes: [{ kind: "pipeline", to: "triage", on: "workItem" }] },
      },
      {
        event: "workItem.ready",
        next: { routes: [{ kind: "step", to: "plan", on: "workItem" }] },
      },
    ]);
    expect(
      automationDocumentSchema.safeParse(projectDefault.document).success,
    ).toBe(true);
  });

  test("an event of the other scope is a build error", () => {
    expect(
      buildError(() =>
        untyped({
          key: "x",
          scope: "workItem",
          rules: [onEvent({ event: "workItem.created", to: plan })],
        }),
      ),
    ).toEqual([
      '/rules/0/event: "workItem.created" isn\'t an event of a work-item automation',
    ]);
  });

  test(".on(r.child) without a child is a build error", () => {
    expect(
      buildError(() =>
        untyped({
          key: "x",
          scope: "workItem",
          rules: [
            onEvent({
              event: "self.attached",
              to: (r: { child: object }) => plan().on(r.child as never),
            } as never),
          ],
        }),
      ),
    ).toEqual([
      "/rules/0/next/routes/0: .on(...) takes the work item to start for: r.workItem, or r.child on child.* events",
    ]);
  });

  test("attach in a work-item automation is a build error", () => {
    expect(
      buildError(() =>
        untyped({
          key: "x",
          scope: "workItem",
          rules: [
            onEvent({ event: "child.ready", to: attach(wayfinder) as never }),
          ],
        }),
      ),
    ).toEqual([
      "/rules/0/next/routes/0: only a project automation can attach automations; a work-item automation is attached to one work item",
    ]);
  });

  test("a ref from another rule's r is a build error", () => {
    let leaked: object | undefined;
    const errors = buildError(() =>
      defineAutomation({
        key: "x",
        scope: "workItem",
        rules: [
          onEvent({
            event: "child.ready",
            to: (r) => {
              leaked = r.child.title;
              return skip;
            },
          }),
          onEvent({
            event: "child.closed",
            to: () => research({ question: leaked as never }),
          }),
        ],
      }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("/rules/1/next/routes/0/args/question");
  });

  test("several routes in first mode each need a when", () => {
    expect(
      buildError(() =>
        defineAutomation({
          key: "x",
          scope: "workItem",
          rules: [
            onEvent({
              event: "child.ready",
              routes: [{ to: plan }, { to: skip }],
            }),
          ],
        }),
      ),
    ).toHaveLength(2);
  });

  test("a value that isn't a rule or target is a build error", () => {
    expect(
      buildError(() => untyped({ key: "x", scope: "workItem", rules: [{}] })),
    ).toEqual(["/rules/0: rules only take onEvent(...) rules"]);
    expect(
      buildError(() =>
        untyped({
          key: "x",
          scope: "workItem",
          rules: [onEvent({ event: "child.ready", to: {} as never })],
        }),
      )[0],
    ).toContain("isn't an automation target");
  });
});

describe("automationDocumentSchema", () => {
  const base = { kind: "automation", schemaVersion: 1, key: "k" } as const;

  test("rejects events, attach and child targets that don't fit", () => {
    const result = automationDocumentSchema.safeParse({
      ...base,
      scope: "workItem",
      rules: [
        {
          event: "workItem.created",
          next: { routes: [{ kind: "attach", automation: "a" }] },
        },
        {
          event: "self.attached",
          next: { routes: [{ kind: "step", to: "s", on: "child" }] },
        },
      ],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("/"))).toEqual([
      "rules/0/event",
      "rules/0/next",
      "rules/1/next",
    ]);
  });

  test("rejects an otherwise with a when", () => {
    expect(
      automationDocumentSchema.safeParse({
        ...base,
        scope: "workItem",
        rules: [
          {
            event: "child.ready",
            next: {
              routes: [{ kind: "skip" }],
              otherwise: {
                kind: "skip",
                when: { path: "event.label", op: "exists" },
              },
            },
          },
        ],
      }).success,
    ).toBe(false);
  });
});
