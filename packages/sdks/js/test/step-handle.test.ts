import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  codeStep,
  defineStep,
  toStepSpec,
  type StepDefinitionSpec,
  type StepRef,
} from "../src/definitions/steps";
import { findCodeStepInModule } from "../src/push/code-step-lookup";
import { collectDefinitionsFromDirectory } from "../src/push/collect-definitions";
import { pushFromDirectory } from "../src/push/push-from-directory";

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

const STEPS_MODULE_PATH = join(
  import.meta.dir,
  "../src/definitions/steps/index.ts",
);

const plan = defineStep({
  key: "plan",
  name: "Plan",
  agentPrompt: "Plan it.",
  additionalInput: z.object({ issue: z.string() }),
  result: z.object({ files: z.array(z.string()) }),
  errors: ["NoPlan", "TooBig"],
});

const shout = codeStep({
  key: "shout",
  name: "Shout",
  inputSchema: z.object({ text: z.string() }),
  resultSchema: z.object({ loud: z.string() }),
  fn: (input) => ({ loud: input.text.toUpperCase() }),
  errors: ["Hoarse"],
});

describe("step handles", () => {
  test("defineStep and codeStep return callable handles carrying the spec fields", () => {
    expect(typeof plan).toBe("function");
    expect(typeof shout).toBe("function");
    expect(plan.key).toBe("plan");
    expect(plan.name).toBe("Plan");
    expect(plan.kind).toBe("user_defined");
    expect(plan.prompt).toBe("Plan it.");
    expect(plan.errors).toEqual(["NoPlan", "TooBig"]);
    expect(shout.kind).toBe("code");
    expect(shout.errors).toEqual(["Hoarse"]);
    expect(Object.keys(plan)).toContain("name");
  });

  test("calling a handle records a pipeline target and runs nothing", () => {
    expect<object>(plan({ issue: "#1" })).toEqual({
      _tag: "pipeline_target",
      to: "plan",
    });
    expect<object>(shout({ text: "hi" })).toEqual({
      _tag: "pipeline_target",
      to: "shout",
    });
  });

  test("chain methods are not spec fields", () => {
    expect(Object.keys(plan)).not.toContain("next");
    expect(typeof plan.next).toBe("function");
    expect(Object.keys(toStepSpec(plan))).not.toContain("retry");
  });

  test("errors default to an empty list", () => {
    const step = defineStep({ key: "s", name: "S", agentPrompt: "p" });
    expect(step.errors).toEqual([]);
  });

  test("rejects empty and duplicate error names", () => {
    expect(() =>
      defineStep({ key: "s", name: "S", agentPrompt: "p", errors: ["A", "A"] }),
    ).toThrow('Step "s": error "A" is declared more than once.');
    expect(() =>
      codeStep({ key: "c", name: "C", fn: () => ({}), errors: [" "] }),
    ).toThrow('Step "c": error names must not be empty.');
  });

  test("retry compiles to retryJson, leaving the retry chain method alone", () => {
    const step = defineStep({
      key: "s",
      name: "S",
      agentPrompt: "p",
      errors: ["MergeConflict"],
      retry: [{ on: ["MergeConflict", "Scarn.Timeout"], maxAttempts: 2 }],
    });
    expect(step.retryJson).toEqual([
      { on: ["MergeConflict", "Scarn.Timeout"], maxAttempts: 2 },
    ]);
    expect(typeof step.retry).toBe("function");
    expect(
      defineStep({ key: "t", name: "T", agentPrompt: "p" }).retryJson,
    ).toEqual([]);
  });

  test("rejects a retry on an undeclared error or with a bad maxAttempts", () => {
    expect(() =>
      defineStep({
        key: "s",
        name: "S",
        agentPrompt: "p",
        retry: [{ on: ["MergeConflict" as never], maxAttempts: 1 }],
      }),
    ).toThrow(
      'Step "s": retry names "MergeConflict", which is neither a built-in error nor one the step declares.',
    );
    expect(() =>
      codeStep({
        key: "c",
        name: "C",
        fn: () => ({}),
        retry: [{ on: ["Scarn.All"], maxAttempts: 0 }],
      }),
    ).toThrow('Step "c": retry maxAttempts must be a positive integer.');
  });

  test("toStepSpec returns a plain object with every spec field", () => {
    const spec = toStepSpec(plan);

    expect(typeof spec).toBe("object");
    expect(Object.keys(spec).sort()).toEqual(Object.keys(plan).sort());
    expect(spec.name).toBe("Plan");
    expect(spec.errors).toEqual(["NoPlan", "TooBig"]);
    expect(JSON.parse(JSON.stringify(spec))).toEqual(spec);
    expect(structuredClone(spec)).toEqual(spec);
  });

  test("handles satisfy StepRef with their input, result and error types", () => {
    const planRef: StepRef<
      { issue: string },
      { files: string[] },
      "NoPlan" | "TooBig"
    > = plan;
    const shoutRef: StepRef<{ text: string }, { loud: string }, "Hoarse"> =
      shout;
    const asSpec: StepDefinitionSpec = plan;

    const typeChecks: [
      Assert<Equal<(typeof plan)["errors"], readonly ("NoPlan" | "TooBig")[]>>,
      Assert<Equal<(typeof shout)["__input"], { text: string }>>,
      Assert<Equal<(typeof shout)["__result"], { loud: string }>>,
      Assert<
        Equal<
          ReturnType<typeof defineStep<z.ZodObject, z.ZodObject>>["errors"],
          readonly never[]
        >
      >,
    ] = [true, true, true, true];
    // @ts-expect-error -- a step's args are typed against its input
    plan({ issue: 1 });
    // @ts-expect-error -- an undeclared error name is not part of the type
    const wrongErrors: StepRef<unknown, unknown, "Other"> = plan;

    expect(typeChecks).toEqual([true, true, true, true]);
    expect([planRef.key, shoutRef.key, asSpec.key, wrongErrors.key]).toEqual([
      "plan",
      "shout",
      "plan",
      "plan",
    ]);
  });
});

describe("step handles through collect and push", () => {
  const previousFetch = globalThis.fetch;
  let dir: string | undefined;

  afterEach(() => {
    globalThis.fetch = previousFetch;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function writeStepsModule(): string {
    dir = mkdtempSync(join(tmpdir(), "scarn-step-handle-test-"));
    writeFileSync(
      join(dir, "steps.ts"),
      `import { codeStep, defineStep } from "${pathToFileURL(STEPS_MODULE_PATH).href}";

export const plan = defineStep({
  key: "plan",
  name: "Plan",
  agentPrompt: "Plan it.",
  errors: ["NoPlan", "TooBig"],
});

export const shout = codeStep({
  key: "shout",
  name: "Shout",
  fn: (input) => ({ loud: String(input).toUpperCase() }),
  errors: ["Hoarse"],
});
`,
    );
    return dir;
  }

  test("collect returns the handle's spec unchanged, as plain JSON-safe objects", async () => {
    const builderDir = writeStepsModule();
    const mod = (await import(
      pathToFileURL(join(builderDir, "steps.ts")).href
    )) as { plan: StepDefinitionSpec; shout: StepDefinitionSpec };

    const collected = await collectDefinitionsFromDirectory(builderDir);
    const byKey = new Map(collected.steps.map((step) => [step.key, step]));
    const collectedPlan = byKey.get("plan");
    const collectedShout = byKey.get("shout");

    for (const step of collected.steps) {
      expect(typeof step).toBe("object");
      expect(JSON.parse(JSON.stringify(step))).toEqual(step);
    }
    expect(collectedPlan).toEqual(toStepSpec(mod.plan));

    const shoutWithoutFn = toStepSpec(mod.shout);
    delete shoutWithoutFn.entrypoint;
    expect(collectedShout).toEqual({
      ...shoutWithoutFn,
      entrypointJson: { sourceFile: ".scarn/pipeline-builder/steps.ts" },
    });
    expect(typeof findCodeStepInModule(mod, "shout")).toBe("function");
  });

  test("push sends each handle's declared errors to the server", async () => {
    const builderDir = writeStepsModule();
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (input: Request) => {
      if (input.method === "PUT") {
        bodies.push((await input.clone().json()) as Record<string, unknown>);
      }
      return new Response(JSON.stringify({ id: "x" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;

    await pushFromDirectory(builderDir, {
      baseUrl: "https://scarn.example.com",
      projectId: "proj-1",
      accessToken: "tok",
      log: () => undefined,
    });

    expect(
      bodies
        .map((body) => ({ key: body["key"], errors: body["errors"] }))
        .sort((a, b) => String(a.key).localeCompare(String(b.key))),
    ).toEqual([
      { key: "plan", errors: ["NoPlan", "TooBig"] },
      { key: "shout", errors: ["Hoarse"] },
    ]);
  });
});
