import { inlineEnvironment } from "./inline-environment";
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Env, Repo, Runtime, codeStep, defineStep } from "../src";
import {
  DEFAULT_CODE_STEP_RUNTIME_ID,
  MANAGED_RUNTIME_IDS,
  managedRuntimeIdSchema,
} from "../src/managed-runtimes";
import { compileEnvironment } from "../src/definitions/steps/runtime";
import { validateDefinitionSpecs } from "../src/definitions/validation";

describe("Runtime constructors", () => {
  test("devcontainer() without options has no config", () => {
    expect(Runtime.devcontainer()).toEqual({ kind: "devcontainer" });
    expect(Runtime.devcontainer({})).toEqual({ kind: "devcontainer" });
  });

  test("devcontainer({ config }) keeps the path", () => {
    expect(
      Runtime.devcontainer({
        config: ".devcontainer/frontend/devcontainer.json",
      }),
    ).toEqual({
      kind: "devcontainer",
      config: ".devcontainer/frontend/devcontainer.json",
    });
  });

  test("devcontainer({ config }) normalizes a leading ./", () => {
    expect(
      Runtime.devcontainer({ config: "./.devcontainer/alt/devcontainer.json" }),
    ).toEqual({
      kind: "devcontainer",
      config: ".devcontainer/alt/devcontainer.json",
    });
  });

  test.each([
    ["/abs/devcontainer.json", "relative"],
    ["C:\\x\\devcontainer.json", "backslash"],
    ["../devcontainer.json", '".."'],
    [".devcontainer/other.json", "devcontainer.json"],
    ["", "devcontainer.json"],
  ])("devcontainer rejects %j at definition time", (config, fragment) => {
    expect(() => Runtime.devcontainer({ config })).toThrow(fragment);
  });

  test("the rejection names the offending path", () => {
    expect(() =>
      Runtime.devcontainer({ config: "../x/devcontainer.json" }),
    ).toThrow(/Runtime\.devcontainer config "\.\.\/x\/devcontainer\.json"/);
  });

  test("host() takes no options and has no config", () => {
    expect(Runtime.host()).toEqual({ kind: "host" });
    // @ts-expect-error host takes no options
    Runtime.host({ config: ".devcontainer/devcontainer.json" });
  });

  test("managed has one factory per registry identifier", () => {
    expect(Object.keys(Runtime.managed)).toEqual([...MANAGED_RUNTIME_IDS]);
    expect(Runtime.managed.bun1()).toEqual({ kind: "managed", id: "bun1" });
    expect(Runtime.managed.node24()).toEqual({ kind: "managed", id: "node24" });
  });

  test("managed rejects an unknown identifier at the type level", () => {
    // @ts-expect-error nope is not a managed runtime identifier
    expect(Runtime.managed.nope).toBeUndefined();
  });

  test("the default code step runtime is a registered identifier", () => {
    expect(MANAGED_RUNTIME_IDS).toContain(DEFAULT_CODE_STEP_RUNTIME_ID);
    expect(DEFAULT_CODE_STEP_RUNTIME_ID).toBe("bun1");
  });
});

describe("managed runtime registry", () => {
  test("lists bun1 and node24", () => {
    expect([...MANAGED_RUNTIME_IDS]).toEqual(["bun1", "node24"]);
  });

  test("schema accepts known identifiers and rejects others", () => {
    expect(managedRuntimeIdSchema.safeParse("bun1").success).toBe(true);
    expect(managedRuntimeIdSchema.safeParse("node24").success).toBe(true);
    expect(managedRuntimeIdSchema.safeParse("bun2").success).toBe(false);
    expect(managedRuntimeIdSchema.safeParse(null).success).toBe(false);
  });
});

describe("compileEnvironment", () => {
  test("no environment uses the repository runtime", () => {
    expect(compileEnvironment(undefined)).toBeNull();
  });

  test("an empty environment uses the repository runtime", () => {
    expect(compileEnvironment({})).toEqual({
      kind: "inline",
      envJson: null,
    });
  });

  test("host emits its kind and no config", () => {
    expect(compileEnvironment({ runtime: Runtime.host() })).toEqual({
      kind: "inline",
      runtime: { kind: "host" },
      envJson: null,
    });
  });

  test("devcontainer without config stays explicit", () => {
    expect(compileEnvironment({ runtime: Runtime.devcontainer() })).toEqual({
      kind: "inline",
      runtime: { kind: "devcontainer" },
      envJson: null,
    });
  });

  test("devcontainer with config emits its kind and the path", () => {
    expect(
      compileEnvironment({
        runtime: Runtime.devcontainer({ config: "tools/devcontainer.json" }),
      }),
    ).toMatchObject({
      kind: "inline",
      runtime: { kind: "devcontainer", config: "tools/devcontainer.json" },
    });
  });

  test("managed emits its kind, the identifier and no config path", () => {
    expect(
      compileEnvironment({
        runtime: Runtime.managed.node24(),
      }),
    ).toEqual({
      kind: "inline",
      runtime: { kind: "managed", id: "node24" },
      envJson: null,
    });
  });

  test("defaultRuntime applies only when no runtime is declared", () => {
    const defaultRuntime = Runtime.managed.bun1();
    expect(compileEnvironment(undefined, { defaultRuntime })?.runtime).toEqual({
      kind: "managed",
      id: "bun1",
    });
    expect(compileEnvironment({}, { defaultRuntime })?.runtime).toEqual({
      kind: "managed",
      id: "bun1",
    });
    expect(
      compileEnvironment(
        { runtime: Runtime.devcontainer() },
        { defaultRuntime },
      )?.runtime,
    ).toEqual({ kind: "devcontainer" });
    expect(
      compileEnvironment(
        { runtime: Runtime.managed.node24() },
        { defaultRuntime },
      )?.runtime,
    ).toEqual({ kind: "managed", id: "node24" });
  });

  test("vars compile through normalizeEnv", () => {
    expect(
      compileEnvironment({ vars: () => ({ A: "x", B: Env.inherit() }) })
        ?.envJson,
    ).toEqual([
      { name: "A", source: "value", value: "x", secret: false },
      {
        name: "B",
        source: "inherit",
        from: "B",
        secret: false,
        optional: false,
      },
    ]);
  });
});

describe("defineStep — runtime", () => {
  const base = { key: "s", name: "S", agentPrompt: "go" } as const;

  test("defaults to a null environment reference", () => {
    const spec = defineStep(base);
    expect(spec.environment).toBeNull();
    expect(spec).not.toHaveProperty("runtimeKind");
    expect(spec).not.toHaveProperty("devcontainerConfigPath");
    expect(spec).not.toHaveProperty("managedRuntime");
    expect(spec).not.toHaveProperty("envJson");
  });

  test.each([
    ["readOnly", Repo.readOnly()],
    ["readWrite", Repo.readWrite()],
  ] as const)(
    "a managed runtime with Repo.%s() emits managed and passes validation",
    (mode, repo) => {
      const spec = defineStep({
        ...base,
        environment: { runtime: Runtime.managed.bun1() },
        repo,
      });
      expect(inlineEnvironment(spec.environment)?.runtime).toEqual({
        kind: "managed",
        id: "bun1",
      });
      expect(spec.repo?.mode).toBe(mode);
      expect(validateDefinitionSpecs([spec])).toEqual([]);
    },
  );

  test("a managed runtime rejects the removed none repository mode", () => {
    expect(() =>
      defineStep({
        ...base,
        environment: {
          runtime: Runtime.managed.bun1(),
        },
        // @ts-expect-error none is not a current repository mode
        repo: { mode: "none" },
      }),
    ).toThrow();
  });

  test("Runtime.host() emits host", () => {
    const spec = defineStep({
      ...base,
      environment: { runtime: Runtime.host() },
    });
    expect(inlineEnvironment(spec.environment)?.runtime).toEqual({
      kind: "host",
    });
  });

  test("Runtime.devcontainer({ config }) emits devcontainer and the path", () => {
    const spec = defineStep({
      ...base,
      environment: {
        runtime: Runtime.devcontainer({
          config: ".devcontainer/frontend/devcontainer.json",
        }),
      },
    });
    expect(inlineEnvironment(spec.environment)?.runtime).toEqual({
      kind: "devcontainer",
      config: ".devcontainer/frontend/devcontainer.json",
    });
  });
});

describe("codeStep — runtime", () => {
  const base = { key: "c", name: "C", fn: () => ({}) } as const;

  test("defaults to the default managed runtime", () => {
    const spec = codeStep(base);
    expect(inlineEnvironment(spec.environment)?.runtime).toEqual({
      kind: "managed",
      id: DEFAULT_CODE_STEP_RUNTIME_ID,
    });
  });

  test("Runtime.managed.<id>() emits managed and the identifier", () => {
    const spec = codeStep({
      ...base,
      environment: { runtime: Runtime.managed.node24() },
    });
    expect(inlineEnvironment(spec.environment)?.runtime).toEqual({
      kind: "managed",
      id: "node24",
    });
  });

  test("Runtime.devcontainer() opts out of the managed default", () => {
    const spec = codeStep({
      ...base,
      environment: { runtime: Runtime.devcontainer() },
    });
    expect(inlineEnvironment(spec.environment)?.runtime).toEqual({
      kind: "devcontainer",
    });
  });

  test("Runtime.host() is a type error and fails validation", () => {
    const spec = codeStep({
      ...base,
      // @ts-expect-error code steps need a container, so host is unsupported
      environment: { runtime: Runtime.host() },
    });
    const issues = validateDefinitionSpecs([spec]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe("runtime");
    expect(issues[0]?.message).toContain("codeStep");
  });

  test("Runtime.devcontainer({ config }) emits devcontainer and the path", () => {
    const spec = codeStep({
      ...base,
      inputSchema: z.object({}),
      environment: {
        runtime: Runtime.devcontainer({ config: "ci/devcontainer.json" }),
      },
    });
    expect(inlineEnvironment(spec.environment)?.runtime).toEqual({
      kind: "devcontainer",
      config: "ci/devcontainer.json",
    });
  });

  test("a managed code step passes validation", () => {
    const spec = codeStep({
      ...base,
      environment: { runtime: Runtime.managed.bun1() },
      repo: Repo.readOnly(),
    });
    expect(validateDefinitionSpecs([spec])).toEqual([]);
  });
});
