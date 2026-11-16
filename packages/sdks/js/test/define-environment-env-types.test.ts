import { describe, expect, expectTypeOf, test } from "bun:test";
import { z } from "zod";
import {
  Env,
  Runtime,
  defineEnvironment,
  type EnvironmentHandle,
} from "../src/definitions/environments";
import { defineStep } from "../src/definitions/steps";

const frontend = defineEnvironment({
  name: "frontend",
  runtime: Runtime.devcontainer(),
  vars: {
    NODE_ENV: "development",
    MODE: Env.value({ value: "fast" }),
    NPM_TOKEN: Env.secret("NPM_TOKEN"),
    AWS_PROFILE: Env.inherit({ default: "dev" }),
    LOG_LEVEL: Env.inherit({ optional: true }),
    DB_PASSWORD: Env.inherit({ secret: true }),
  },
});

describe("prompt env typing with a named environment", () => {
  test("a handle types the prompt's env from its declared, non-secret vars", () => {
    defineStep({
      key: "handle",
      name: "Handle",
      input: z.object({ title: z.string() }),
      environment: frontend,
      agentPrompt: ({ env, input }) => {
        const nodeEnv: string = env.NODE_ENV;
        const mode: string = env.MODE;
        const profile: string = env.AWS_PROFILE;
        const logLevel: string | undefined = env.LOG_LEVEL;
        // @ts-expect-error an optional entry without a default may be undefined
        const requiredLogLevel: string = env.LOG_LEVEL;
        // @ts-expect-error project secrets are dropped from the prompt env
        void env.NPM_TOKEN;
        // @ts-expect-error secret inherit keys are dropped from the prompt env
        void env.DB_PASSWORD;
        // @ts-expect-error undeclared keys are rejected
        void env.NOT_DECLARED;
        expectTypeOf(input.title).toEqualTypeOf<string>();
        return [nodeEnv, mode, profile, logLevel, requiredLogLevel].join(" ");
      },
    });
  });

  test("a handle with no vars gives an empty prompt env", () => {
    const bare = defineEnvironment({ name: "bare" });
    defineStep({
      key: "bare",
      name: "Bare",
      environment: bare,
      agentPrompt: ({ env }) => {
        // @ts-expect-error the environment declares no vars
        void env.ANYTHING;
        return "go";
      },
    });
  });

  test("a handle typed as plain EnvironmentHandle keeps a string record", () => {
    const loose: EnvironmentHandle = frontend;
    defineStep({
      key: "loose",
      name: "Loose",
      environment: loose,
      agentPrompt: ({ env }) => {
        expectTypeOf(env).toEqualTypeOf<Record<string, string>>();
        return String(env.ANYTHING);
      },
    });
  });

  test("a name keeps a string record", () => {
    defineStep({
      key: "named",
      name: "Named",
      environment: "frontend",
      agentPrompt: ({ env }) => {
        expectTypeOf(env).toEqualTypeOf<Record<string, string>>();
        return String(env.ANYTHING);
      },
    });
  });

  test("inline vars still type the prompt's env strictly", () => {
    defineStep({
      key: "inline",
      name: "Inline",
      environment: { vars: { LEVEL: "info", KEY: Env.secret("KEY") } },
      agentPrompt: ({ env }) => {
        const level: string = env.LEVEL;
        // @ts-expect-error project secrets are dropped from the prompt env
        void env.KEY;
        return level;
      },
    });
  });

  test("defineEnvironment takes a vars record only", () => {
    expect(() =>
      defineEnvironment({
        name: "fn",
        // @ts-expect-error an environment has no function form for vars
        vars: () => ({ A: "1" }),
      }),
    ).toThrow('Environment "fn": vars must be a record');
  });

  test("the handle carries its vars type", () => {
    expectTypeOf<
      (typeof frontend)["__env"]["NODE_ENV"]
    >().toEqualTypeOf<"development">();
    expectTypeOf(frontend.kind).toEqualTypeOf<"environment">();
    expect("__env" in frontend).toBe(false);
  });
});
