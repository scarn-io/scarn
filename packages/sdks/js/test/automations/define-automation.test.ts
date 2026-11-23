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
          key: "plan",
          event: "self.attached",
          next: {
            routes: [{ kind: "step", to: "plan", on: "workItem" }],
          },
        },
        {
          key: "research",
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
          key: "replan",
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
        key: "route-labels",
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
        key: "triage",
        event: "workItem.created",
        next: { routes: [{ kind: "pipeline", to: "triage", on: "workItem" }] },
      },
      {
        key: "plan",
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
          rules: [
            onEvent({
              key: "work-item-created",
              event: "workItem.created",
              to: plan,
            }),
          ],
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
              key: "self-attached",
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
            onEvent({
              key: "child-ready",
              event: "child.ready",
              to: attach(wayfinder) as never,
            }),
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
            key: "child-ready",
            event: "child.ready",
            to: (r) => {
              leaked = r.child.title;
              return skip;
            },
          }),
          onEvent({
            key: "child-closed",
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
              key: "child-ready",
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
          rules: [
            onEvent({
              key: "child-ready",
              event: "child.ready",
              to: {} as never,
            }),
          ],
        }),
      )[0],
    ).toContain("isn't an automation target");
  });

  test("a rule without a key is a build error", () => {
    expect(
      buildError(() =>
        untyped({
          key: "x",
          scope: "workItem",
          rules: [onEvent({ event: "child.ready", to: skip } as never)],
        }),
      ),
    ).toEqual([
      "/rules/0/key: every rule needs a key of letters, digits, '_' and '-' (got undefined)",
    ]);
  });

  test("a rule key with other characters is a build error", () => {
    expect(
      buildError(() =>
        defineAutomation({
          key: "x",
          scope: "workItem",
          rules: [
            onEvent({ key: "poll acme", event: "child.ready", to: skip }),
          ],
        }),
      ),
    ).toEqual([
      "/rules/0/key: every rule needs a key of letters, digits, '_' and '-' (got \"poll acme\")",
    ]);
  });

  test("two rules with the same key is a build error", () => {
    expect(
      buildError(() =>
        defineAutomation({
          key: "x",
          scope: "workItem",
          rules: [
            onEvent({ key: "same", event: "child.ready", to: skip }),
            onEvent({ key: "same", event: "child.closed", to: skip }),
          ],
        }),
      ),
    ).toEqual([
      '/rules/1/key: another rule already has the key "same"; rule keys must be unique within an automation',
    ]);
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
          key: "work-item-created",
          event: "workItem.created",
          next: { routes: [{ kind: "attach", automation: "a" }] },
        },
        {
          key: "self-attached",
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

  const skipRule = (key?: string) => ({
    ...(key === undefined ? {} : { key }),
    event: "child.ready",
    next: { routes: [{ kind: "skip" }] },
  });

  test("rejects a rule without a key", () => {
    const result = automationDocumentSchema.safeParse({
      ...base,
      scope: "workItem",
      rules: [skipRule()],
    });
    expect(result.error?.issues.map((issue) => issue.path.join("/"))).toEqual([
      "rules/0/key",
    ]);
  });

  test("rejects a rule key with other characters", () => {
    expect(
      automationDocumentSchema.safeParse({
        ...base,
        scope: "workItem",
        rules: [skipRule("poll acme")],
      }).success,
    ).toBe(false);
  });

  test("rejects two rules with the same key", () => {
    const result = automationDocumentSchema.safeParse({
      ...base,
      scope: "workItem",
      rules: [skipRule("a"), skipRule("b"), skipRule("a")],
    });
    expect(result.error?.issues).toMatchObject([
      {
        path: ["rules", 2, "key"],
        message:
          'Another rule already has the key "a"; rule keys must be unique within an automation',
      },
    ]);
  });

  test("rejects an otherwise with a when", () => {
    expect(
      automationDocumentSchema.safeParse({
        ...base,
        scope: "workItem",
        rules: [
          {
            key: "child-ready",
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
