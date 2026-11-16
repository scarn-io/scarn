import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  Env,
  Runtime,
  defineEnvironment,
  environmentContentSchema,
  isEnvironmentHandle,
} from "../src/definitions/environments";
import {
  codeStep,
  defineMcp,
  defineStep,
  stepEnvironmentHandle,
  toStepSpec,
} from "../src/definitions/steps";

const datadogKeys = {
  DD_API_KEY: Env.secret("DD_API_KEY"),
  DD_APPLICATION_KEY: Env.inherit({ secret: true }),
};

describe("defineEnvironment", () => {
  test("compiles every var form to environment content", () => {
    const env = defineEnvironment({
      name: "frontend",
      description: "Frontend work",
      runtime: Runtime.devcontainer({
        config: ".devcontainer/frontend/devcontainer.json",
      }),
      connectors: ["playwright"],
      vars: {
        NODE_ENV: "development",
        MODE: Env.value({ value: "fast" }),
        SETUP_FLAG: Env.value({ value: "1", applies: "setup" }),
        NPM_TOKEN: Env.secret("NPM_TOKEN"),
        AWS_PROFILE: Env.inherit({ default: "dev" }),
        RENAMED: Env.inherit({ from: "WORKER_NAME", optional: true }),
        DB_PASSWORD: Env.inherit({ secret: true, applies: "both" }),
      },
    });

    expect(env.kind).toBe("environment");
    expect(env.name).toBe("frontend");
    expect(Object.isFrozen(env)).toBe(true);
    expect(env.content).toEqual({
      description: "Frontend work",
      runtime: {
        kind: "devcontainer",
        config: ".devcontainer/frontend/devcontainer.json",
      },
      connectors: ["playwright"],
      vars: [
        {
          name: "NODE_ENV",
          source: "value",
          value: "development",
          secret: false,
          applies: "agent",
        },
        {
          name: "MODE",
          source: "value",
          value: "fast",
          secret: false,
          applies: "agent",
        },
        {
          name: "SETUP_FLAG",
          source: "value",
          value: "1",
          secret: false,
          applies: "setup",
        },
        {
          name: "NPM_TOKEN",
          source: "secret",
          secretName: "NPM_TOKEN",
          applies: "agent",
        },
        {
          name: "AWS_PROFILE",
          source: "inherit",
          from: "AWS_PROFILE",
          secret: false,
          optional: false,
          default: "dev",
          applies: "agent",
        },
        {
          name: "RENAMED",
          source: "inherit",
          from: "WORKER_NAME",
          secret: false,
          optional: true,
          applies: "agent",
        },
        {
          name: "DB_PASSWORD",
          source: "inherit",
          from: "DB_PASSWORD",
          secret: true,
          optional: false,
          applies: "both",
        },
      ],
    });
    expect(environmentContentSchema.parse(env.content)).toEqual(env.content);
    expect(Object.keys(env)).toEqual(["kind", "name", "content"]);
  });

  test.each([
    ["devcontainer without config", Runtime.devcontainer()],
    ["managed", Runtime.managed.bun1()],
    ["host", Runtime.host()],
  ])("accepts a %s runtime", (_label, runtime) => {
    expect(defineEnvironment({ name: "env", runtime }).content).toEqual({
      runtime,
    });
  });

  test("an environment with only a name compiles to empty content", () => {
    expect(defineEnvironment({ name: "bare" }).content).toEqual({});
  });

  test("a branch is rejected", () => {
    expect(() =>
      // @ts-expect-error environments have no branch
      defineEnvironment({ name: "bare", branch: "develop" }),
    ).toThrow(
      'Environment "bare": environments have no branch; use the step\'s repo baseBranch.',
    );
  });

  test("a connector with its required vars is accepted", () => {
    expect(
      defineEnvironment({
        name: "obs",
        connectors: ["datadog"],
        vars: datadogKeys,
      }).content.connectors,
    ).toEqual(["datadog"]);
  });

  describe("definition-time errors start with the environment's name", () => {
    test.each<[string, () => unknown, string]>([
      [
        "an invalid name",
        () => defineEnvironment({ name: "Bad_Name" }),
        'Environment "Bad_Name": name must match',
      ],
      [
        "an input token",
        () =>
          defineEnvironment({
            name: "tok",
            vars: { TICKET: "{{input.ticket}}" },
          }),
        'Environment "tok" env "TICKET": an environment is shared across steps with different inputs, so it cannot use {{input.…}} tokens',
      ],
      [
        "an input token in an inherit default",
        () =>
          defineEnvironment({
            name: "tok",
            vars: { LEVEL: Env.inherit({ default: "{{input.level}}" }) },
          }),
        'Environment "tok" env "LEVEL": an environment is shared',
      ],
      [
        "a static secret",
        () =>
          defineEnvironment({
            name: "sec",
            vars: { KEY: Env.value({ value: "abc", secret: true }) },
          }),
        'Environment "sec": Env "KEY": a secret must interpolate an input token',
      ],
      [
        "a static value on a secret-looking name",
        () => defineEnvironment({ name: "sec", vars: { API_TOKEN: "plain" } }),
        'Environment "sec": Env "API_TOKEN": a static value on a secret-looking name',
      ],
      [
        "setup vars on host",
        () =>
          defineEnvironment({
            name: "host",
            runtime: Runtime.host(),
            vars: { FLAG: Env.value({ value: "1", applies: "setup" }) },
          }),
        'Environment "host" env "FLAG": applies "setup" needs a container',
      ],
      [
        "an unknown connector",
        () => defineEnvironment({ name: "con", connectors: ["nope"] }),
        'Environment "con" environment connectors: unknown connector "nope"',
      ],
      [
        "a missing connector var",
        () =>
          defineEnvironment({
            name: "obs",
            connectors: ["datadog"],
            vars: { DD_API_KEY: Env.secret("DD_API_KEY") },
          }),
        'Environment "obs" is missing variables its connectors need: datadog needs DD_APPLICATION_KEY',
      ],
      [
        "a connector var that only applies to setup",
        () =>
          defineEnvironment({
            name: "obs",
            connectors: ["datadog"],
            vars: {
              ...datadogKeys,
              DD_APPLICATION_KEY: Env.inherit({
                secret: true,
                applies: "setup",
              }),
            },
          }),
        "datadog needs DD_APPLICATION_KEY",
      ],
      [
        "a var name the env-var schema rejects",
        () => defineEnvironment({ name: "bad", vars: { SCARN_X: "1" } }),
        'Environment "bad": vars.0.name',
      ],
    ])("%s", (_label, define, message) => {
      expect(define).toThrow(message);
    });

    test("allows a static value on a secret-looking name with unsafeAllowStatic", () => {
      expect(() =>
        defineEnvironment({
          name: "ok",
          vars: {
            PUBLIC_TOKEN: Env.value({
              value: "not-secret",
              unsafeAllowStatic: true,
            }),
          },
        }),
      ).not.toThrow();
    });
  });
});

describe("isEnvironmentHandle", () => {
  test("checks the shape, not the instance", () => {
    expect(isEnvironmentHandle(defineEnvironment({ name: "a" }))).toBe(true);
    expect(
      isEnvironmentHandle({ kind: "environment", name: "a", content: {} }),
    ).toBe(true);
    expect(isEnvironmentHandle("a")).toBe(false);
    expect(isEnvironmentHandle(null)).toBe(false);
    expect(isEnvironmentHandle({ kind: "environment", name: "a" })).toBe(false);
    expect(isEnvironmentHandle({ runtime: Runtime.host() })).toBe(false);
  });
});

describe("steps given an environment handle", () => {
  const build = defineEnvironment({
    name: "build",
    runtime: Runtime.managed.bun1(),
    connectors: ["datadog"],
    vars: { ...datadogKeys, NODE_ENV: "test" },
  });

  test("a handle and a name compile to the same step spec", () => {
    const step = (environment: typeof build | "build") =>
      defineStep({
        key: "s",
        name: "S",
        input: z.object({ title: z.string() }),
        environment,
        agentPrompt: ({ input }) => `fix ${input.title}`,
      });
    const byHandle = toStepSpec(step(build));
    const byName = toStepSpec(step("build"));
    expect(byHandle.environment).toEqual({ kind: "named", name: "build" });
    expect(byHandle).toEqual(byName);
  });

  test("a code step with a handle compiles to the same spec as with a name", () => {
    const fn = () => ({});
    const byHandle = codeStep({ key: "c", name: "C", fn, environment: build });
    const byName = codeStep({ key: "c", name: "C", fn, environment: "build" });
    expect(toStepSpec(byHandle)).toEqual(toStepSpec(byName));
  });

  test("the step handle keeps the environment handle off its spec", () => {
    const step = defineStep({
      key: "s",
      name: "S",
      environment: build,
      agentPrompt: "go",
    });
    expect(stepEnvironmentHandle(step)).toBe(build);
    expect(Object.keys(step)).not.toContain("environmentHandle");
    expect("environmentHandle" in toStepSpec(step)).toBe(false);
    expect(JSON.stringify(toStepSpec(step))).not.toContain("datadog");

    const named = defineStep({
      key: "n",
      name: "N",
      environment: "build",
      agentPrompt: "go",
    });
    expect(stepEnvironmentHandle(named)).toBeUndefined();

    const code = codeStep({
      key: "c",
      name: "C",
      fn: () => ({}),
      environment: build,
    });
    expect(stepEnvironmentHandle(code)).toBe(build);
  });

  test("codeStep rejects a handle whose runtime is host", () => {
    const host = defineEnvironment({ name: "host", runtime: Runtime.host() });
    expect(() =>
      codeStep({ key: "c", name: "C", fn: () => ({}), environment: host }),
    ).toThrow(
      'Step "c" environment "host": a code step needs a container, but the environment\'s runtime is Runtime.host()',
    );
  });

  test("defineStep accepts a host handle", () => {
    const host = defineEnvironment({ name: "host", runtime: Runtime.host() });
    expect(
      defineStep({ key: "s", name: "S", environment: host, agentPrompt: "go" })
        .environment,
    ).toEqual({ kind: "named", name: "host" });
  });

  test("a step mcps key that collides with a handle's connector throws", () => {
    const datadog = defineMcp({ type: "ref", name: "datadog" });
    expect(() =>
      defineStep({
        key: "s",
        name: "S",
        environment: build,
        mcps: { datadog },
        agentPrompt: "go",
      }),
    ).toThrow(
      'Step "s" environment "build": step mcps "datadog" collide with the environment\'s connectors',
    );
    expect(() =>
      defineStep({
        key: "s",
        name: "S",
        environment: build,
        mcps: { "my-datadog": datadog },
        agentPrompt: "go",
      }),
    ).not.toThrow();
    expect(() =>
      defineStep({
        key: "s",
        name: "S",
        environment: "build",
        mcps: { datadog },
        agentPrompt: "go",
      }),
    ).not.toThrow();
  });
});
