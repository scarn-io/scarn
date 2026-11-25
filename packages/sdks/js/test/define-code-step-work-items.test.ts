import { describe, expect, expectTypeOf, test } from "bun:test";
import { z } from "zod";
import {
  codeStep,
  createFakeWorkItems,
  defineStep,
  Features,
  failStep,
  type CodeStepContext,
  type FeatureGrants,
  type WorkItemsClient,
  type WorkItemsCreate,
  type WorkItemsLatestSourceUpdate,
  type WorkItemsUpsert,
} from "../src/definitions/steps";

const source = { platform: "custom", keyPrefix: "acme:" } as const;

const importFeatures = [
  Features.workItems.read({ scope: "project" }),
  Features.workItems.create({
    scope: "project",
    labels: ["acme"],
    keyPrefix: "acme:",
  }),
  Features.workItems.update({ scope: "project", keyPrefix: "acme:" }),
] as const;

describe("Features.workItems on project", () => {
  test("update on project carries keyPrefix and labels", () => {
    expect(
      Features.workItems.update({
        scope: "project",
        keyPrefix: "acme:",
        labels: ["acme"],
      })._grant,
    ).toEqual({
      resource: "workItem",
      action: "update",
      scope: "project",
      keyPrefix: "acme:",
      labels: ["acme"],
    });
    expect(Features.workItems.update({ scope: "project" })._grant).toEqual({
      resource: "workItem",
      action: "update",
      scope: "project",
    });
  });

  test("create on project carries keyPrefix", () => {
    expect(
      Features.workItems.create({
        scope: "project",
        labels: ["acme"],
        keyPrefix: "acme:",
      })._grant,
    ).toEqual({
      resource: "workItem",
      action: "create",
      scope: "project",
      labels: ["acme"],
      keyPrefix: "acme:",
    });
  });

  test("keyPrefix is a type error outside project", () => {
    Features.workItems.create({
      scope: "children",
      labels: ["a"],
      // @ts-expect-error keyPrefix is for project grants only
      keyPrefix: "x",
    });
    // @ts-expect-error keyPrefix is for project grants only
    Features.workItems.update({ scope: "self", keyPrefix: "x" });
  });
});

describe("codeStep with work item features", () => {
  test("accepts read, create and update on project and pushes their grants", () => {
    const step = codeStep({
      key: "import-acme",
      name: "Import Acme tickets",
      features: [...importFeatures],
      resultSchema: z.object({ upserted: z.number() }),
      fn: () => ({ upserted: 0 }),
    });
    expect(step.grants).toEqual([
      { resource: "workItem", action: "read", scope: "project" },
      {
        resource: "workItem",
        action: "create",
        scope: "project",
        labels: ["acme"],
        keyPrefix: "acme:",
      },
      {
        resource: "workItem",
        action: "update",
        scope: "project",
        keyPrefix: "acme:",
      },
    ]);
  });

  test("allows one grant per keyPrefix, and rejects a repeat", () => {
    expect(() =>
      codeStep({
        key: "two-sources",
        name: "Two sources",
        features: [
          Features.workItems.update({ scope: "project", keyPrefix: "a:" }),
          Features.workItems.update({ scope: "project", keyPrefix: "b:" }),
        ],
        fn: () => ({}),
      }),
    ).not.toThrow();
    expect(() =>
      codeStep({
        key: "repeat",
        name: "Repeat",
        features: [
          Features.workItems.update({ scope: "project", keyPrefix: "a:" }),
          Features.workItems.update({ scope: "project", keyPrefix: "a:" }),
        ],
        fn: () => ({}),
      }),
    ).toThrow("more than one Features.workItems.update");
  });

  test.each([
    ["comment on self", Features.workItems.comment({ scope: "self" })],
    ["update on children", Features.workItems.update({ scope: "children" })],
    [
      "create on children",
      Features.workItems.create({ scope: "children", labels: ["a"] }),
    ],
    [
      "label on self",
      Features.workItems.label({ scope: "self", labels: ["a"] }),
    ],
  ] as const)("rejects %s at define time", (_name, feature) => {
    expect(() =>
      codeStep({
        key: "bad",
        name: "Bad",
        // @ts-expect-error only project read, create and update fit a code step
        features: [feature],
        fn: () => ({}),
      }),
    ).toThrow("a code step may only use Features.workItems.read");
  });

  test("defineStep rejects update on project", () => {
    expect(() =>
      defineStep({
        key: "agent",
        name: "Agent",
        agentPrompt: "Do it.",
        features: [Features.workItems.update({ scope: "project" })],
      }),
    ).toThrow("is for code steps only");
  });

  test("the entrypoint adds workItems to the runner's context", async () => {
    let seen: unknown;
    const step = codeStep({
      key: "peek",
      name: "Peek",
      features: [Features.workItems.read({ scope: "project" })],
      fn: (_input, context) => {
        seen = context;
        return {};
      },
    });
    await step.entrypoint?.fn(undefined, {
      artifactsDir: "/tmp",
      fail: failStep,
    });
    expect(Object.keys((seen as { workItems: object }).workItems)).toEqual([
      "latestSourceUpdate",
    ]);
  });

  test("the entrypoint is fn itself without project grants or mcps", () => {
    const fn = () => ({});
    const step = codeStep({ key: "plain", name: "Plain", fn });
    expect(step.entrypoint?.fn === fn).toBe(true);
  });
});

describe("context.workItems types", () => {
  test("each method is present only with its grant", () => {
    codeStep({
      key: "all",
      name: "All",
      features: [...importFeatures],
      fn: (_input, { workItems }) => {
        expectTypeOf(workItems.upsert).toEqualTypeOf<WorkItemsUpsert>();
        expectTypeOf(workItems.create).toEqualTypeOf<WorkItemsCreate>();
        expectTypeOf(
          workItems.latestSourceUpdate,
        ).toEqualTypeOf<WorkItemsLatestSourceUpdate>();
        return {};
      },
    });

    codeStep({
      key: "update-only",
      name: "Update only",
      features: [Features.workItems.update({ scope: "project" })],
      fn: (_input, { workItems }) => {
        expectTypeOf(workItems.upsert).toEqualTypeOf<WorkItemsUpsert>();
        // @ts-expect-error create needs a create grant on project
        void workItems.create;
        // @ts-expect-error latestSourceUpdate needs a read grant on project
        void workItems.latestSourceUpdate;
        return {};
      },
    });

    codeStep({
      key: "read-only",
      name: "Read only",
      features: [Features.workItems.read({ scope: "project" })],
      fn: (_input, { workItems }) => {
        // @ts-expect-error upsert needs a create or update grant on project
        void workItems.upsert;
        return {};
      },
    });

    codeStep({
      key: "none",
      name: "None",
      features: [Features.notifications()],
      fn: (_input, context) => {
        // @ts-expect-error no work item grants, no workItems
        void context.workItems;
        return {};
      },
    });
  });

  test("CodeStepContext takes the grants as its third parameter", () => {
    type Grants = NonNullable<(typeof importFeatures)[number]["_grant"]>;
    expectTypeOf<
      CodeStepContext<Record<never, never>, never, Grants>["workItems"]
    >().toEqualTypeOf<WorkItemsClient<Grants>>();
  });

  test("the plan's poller runs against the fake", async () => {
    type Context = CodeStepContext<
      Record<never, never>,
      never,
      FeatureGrants<typeof importFeatures>
    >;
    const importAcme = async (
      _input: Record<string, never>,
      { workItems }: Context,
    ) => {
      const since = await workItems.latestSourceUpdate(source);
      expectTypeOf(since).toEqualTypeOf<string | null>();
      const saved = await workItems.upsert([
        {
          platform: "custom",
          platformKey: "acme:1",
          title: "One",
          description: "First",
          labels: ["acme"],
          sourceUpdatedAt: since ?? "2026-11-01T00:00:00Z",
        },
      ]);
      return { upserted: saved.length };
    };
    codeStep({
      key: "import-acme",
      name: "Import Acme tickets",
      features: [...importFeatures],
      resultSchema: z.object({ upserted: z.number() }),
      inputSchema: z.object({}).strict(),
      fn: importAcme,
    });

    const workItems = createFakeWorkItems(importFeatures);
    const context: Context = {
      artifactsDir: "/tmp",
      fail: failStep,
      workItems,
    };
    expect(await importAcme({}, context)).toEqual({ upserted: 1 });
    expect(await importAcme({}, context)).toEqual({ upserted: 0 });
  });
});
