import { inlineEnvironment } from "./inline-environment";
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Env, Repo, Runtime, defineStep } from "../src";
import { compileRepo, type RepoSpec } from "../src/definitions/steps/repo";
import { compileEnvironment } from "../src/definitions/steps/runtime";
import { validateDefinitionSpecs } from "../src/definitions/validation";

describe("Repo constructors", () => {
  test("only read policies are exposed and readOnly() takes no message", () => {
    expect("none" in Repo).toBe(false);
    expect(Repo.readOnly()).toEqual({ mode: "readOnly" });
    // @ts-expect-error readOnly takes no message
    Repo.readOnly({ message: "x" });
  });

  test("readWrite() without options is just the mode", () => {
    expect(Repo.readWrite()).toEqual({ mode: "readWrite" });
    expect(Repo.readWrite({})).toEqual({ mode: "readWrite" });
  });

  test("readWrite(opts) keeps message and onPushFailure", () => {
    expect(Repo.readWrite({ message: "m", onPushFailure: "warn" })).toEqual({
      mode: "readWrite",
      message: "m",
      onPushFailure: "warn",
    });
  });

  test("readWrite rejects an unknown onPushFailure at the type level", () => {
    // @ts-expect-error only "fail" and "warn"
    Repo.readWrite({ onPushFailure: "ignore" });
  });
});

describe("compileRepo — modes", () => {
  const specs: Record<string, RepoSpec> = {
    readWrite: Repo.readWrite(),
    readOnly: Repo.readOnly(),
  };

  test.each(["readWrite", "readOnly"] as const)(
    "compiles %s without runtime coupling",
    (mode) => {
      const spec = specs[mode];
      if (!spec) throw new Error("missing spec");
      expect(compileRepo(spec)).toEqual({ mode });
    },
  );

  test("the removed none mode is rejected for untyped callers", () => {
    expect(() =>
      compileRepo({ mode: "none" } as unknown as RepoSpec, {
        stepKey: "build",
      }),
    ).toThrow(/repo mode must be readOnly or readWrite/);
  });
});

describe("compileRepo — forms", () => {
  test("no repo compiles to undefined", () => {
    expect(compileRepo(undefined, undefined)).toBeUndefined();
    expect(compileRepo(undefined, { stepKey: "host" })).toBeUndefined();
  });

  test("static form carries only what the author wrote", () => {
    expect(compileRepo(Repo.readWrite(), undefined)).toEqual({
      mode: "readWrite",
    });
    expect(
      compileRepo(Repo.readWrite({ onPushFailure: "warn" }), undefined),
    ).toEqual({ mode: "readWrite", onPushFailure: "warn" });
    expect(compileRepo(Repo.readWrite({ message: "fix" }), undefined)).toEqual({
      mode: "readWrite",
      message: "fix",
    });
  });

  test("an explicitly undefined option is dropped from the wire shape", () => {
    const config = compileRepo(
      { mode: "readWrite", message: undefined, onPushFailure: undefined },
      undefined,
    );
    expect(config).toEqual({ mode: "readWrite" });
    expect(Object.keys(config ?? {})).toEqual(["mode"]);
  });

  test("static form with a template string keeps the tokens", () => {
    expect(
      compileRepo(
        Repo.readWrite({ message: "fix: {{result.summary}}" }),
        undefined,
      ),
    ).toEqual({ mode: "readWrite", message: "fix: {{result.summary}}" });
  });

  test("function form renders input and result proxies into tokens", () => {
    const config = compileRepo<{ title: string }, { summary: string }>(
      ({ input, result }) =>
        Repo.readWrite({ message: `fix ${input.title}: ${result.summary}` }),
      undefined,
    );
    expect(config).toEqual({
      mode: "readWrite",
      message: "fix {{input.title}}: {{result.summary}}",
    });
  });

  test("function form coerces a bare proxy reference to its token", () => {
    const config = compileRepo<unknown, { summary: string }>(
      ({ result }) => Repo.readWrite({ message: result.summary }),
      undefined,
    );
    expect(config).toEqual({
      mode: "readWrite",
      message: "{{result.summary}}",
    });
  });

  test("function form renders nested paths", () => {
    const config = compileRepo<{ a: { b: string } }, { c: { d: string } }>(
      ({ input, result }) =>
        Repo.readWrite({ message: `${input.a.b}/${result.c.d}` }),
      undefined,
    );
    expect(config).toEqual({
      mode: "readWrite",
      message: "{{input.a.b}}/{{result.c.d}}",
    });
  });

  test("function form runs once", () => {
    let calls = 0;
    compileRepo(() => {
      calls += 1;
      return Repo.readOnly();
    }, undefined);
    expect(calls).toBe(1);
  });

  test("function form returning readOnly compiles to the bare mode", () => {
    expect(compileRepo(() => Repo.readOnly(), undefined)).toEqual({
      mode: "readOnly",
    });
  });

  test("function form validates the repository shape too", () => {
    expect(() =>
      compileRepo(() => ({ mode: "none" }) as unknown as RepoSpec),
    ).toThrow(/repo/);
  });
});

describe("compileRepo — message rejections", () => {
  const compile = (message: string) =>
    compileRepo(Repo.readWrite({ message }), { stepKey: "s" });

  test("rejects a message over 500 characters", () => {
    expect(() => compile("a".repeat(501))).toThrow(/^Step "s" repo: message/);
  });

  test("accepts a 500 character message", () => {
    expect(compile("a".repeat(500))).toEqual({
      mode: "readWrite",
      message: "a".repeat(500),
    });
  });

  test("rejects a newline", () => {
    expect(() => compile("one\ntwo")).toThrow(/single line/);
  });

  test("rejects an env token", () => {
    expect(() => compile("deploy {{env.API_TOKEN}}")).toThrow(/tokens/);
  });

  test("rejects an unknown root", () => {
    expect(() => compile("{{scarn.artifactsDir}}")).toThrow(/tokens/);
  });

  test("rejects an unknown onPushFailure from untyped callers", () => {
    expect(() =>
      compileRepo(
        { mode: "readWrite", onPushFailure: "ignore" } as unknown as RepoSpec,
        undefined,
      ),
    ).toThrow(/onPushFailure/);
  });
});

describe("compileEnvironment — repo", () => {
  test("repo is not part of the environment wire shape", () => {
    expect(compileEnvironment({})).not.toHaveProperty("repo");
    expect(compileEnvironment(undefined)).toBeNull();
    const host = compileEnvironment({ runtime: Runtime.host() });
    expect(host).not.toHaveProperty("repo");
    expect(host?.runtime).toEqual({ kind: "host" });
  });

  test("compiles repo alongside runtime and vars", () => {
    const compiled = defineStep({
      key: "repo-vars",
      name: "Repo vars",
      agentPrompt: "go",
      environment: {
        runtime: Runtime.devcontainer(),
        vars: () => ({ A: "x" }),
      },
      repo: Repo.readOnly(),
    });
    expect(inlineEnvironment(compiled.environment)?.runtime).toEqual({
      kind: "devcontainer",
    });
    expect(inlineEnvironment(compiled.environment)?.envJson).toHaveLength(1);
    expect(compiled.repo).toEqual({ mode: "readOnly" });
  });

  test("a host step accepts every repo policy without changing runtime", () => {
    for (const repo of [
      Repo.readOnly({ gitCredentials: "none" }),
      Repo.readWrite({
        message: "fix",
        onPushFailure: "warn",
        gitCredentials: "none",
      }),
    ]) {
      const compiled = defineStep({
        key: "host-repo",
        name: "Host repo",
        agentPrompt: "go",
        environment: { runtime: Runtime.host() },
        repo,
      });
      expect(compiled.repo).toEqual(repo);
      expect(inlineEnvironment(compiled.environment)?.runtime).toEqual({
        kind: "host",
      });
    }
  });
});

describe("defineStep — repo", () => {
  const base = { key: "s", name: "S", agentPrompt: "go" } as const;

  test("omitted repo emits no repo field", () => {
    const spec = defineStep(base);
    expect(spec.repo).toBeUndefined();
    expect("repo" in spec).toBe(false);
    const host = defineStep({
      ...base,
      environment: { runtime: Runtime.host() },
    });
    expect("repo" in host).toBe(false);
    expect(inlineEnvironment(host.environment)?.runtime).toEqual({
      kind: "host",
    });
  });

  test("static Repo.readOnly() emits repo", () => {
    const spec = defineStep({
      ...base,
      repo: Repo.readOnly(),
    });
    expect(spec.repo).toEqual({ mode: "readOnly" });
    expect(spec.environment).toBeNull();
  });

  test("Repo.readWrite() on a devcontainer step emits an explicit readWrite", () => {
    const spec = defineStep({
      ...base,
      environment: { runtime: Runtime.devcontainer() },
      repo: Repo.readWrite(),
    });
    expect(spec.repo).toEqual({ mode: "readWrite" });
  });

  test("readOnly on a host step preserves disabled credentials", () => {
    const spec = defineStep({
      ...base,
      environment: {
        runtime: Runtime.host(),
      },
      repo: Repo.readOnly({ gitCredentials: "none" }),
    });
    expect(spec.repo).toEqual({ mode: "readOnly", gitCredentials: "none" });
    expect(inlineEnvironment(spec.environment)?.runtime).toEqual({
      kind: "host",
    });
  });

  test.each([
    Repo.readOnly({ gitCredentials: "none" }),
    Repo.readWrite({
      message: "fix",
      onPushFailure: "warn",
      gitCredentials: "none",
    }),
  ])("host static and function authoring accepts %j", (repo) => {
    for (const field of [repo, () => repo]) {
      const spec = defineStep({
        ...base,
        environment: { runtime: Runtime.host() },
        repo: field,
      });
      expect(spec.repo).toEqual(repo);
      expect(inlineEnvironment(spec.environment)?.runtime).toEqual({
        kind: "host",
      });
      expect(validateDefinitionSpecs([spec])).toEqual([]);
    }
  });

  test("function form types result from the result schema and input from the input schema", () => {
    const spec = defineStep({
      key: "implement",
      name: "Implement",
      input: z.object({ title: z.string() }),
      result: z.object({ summary: z.string() }),
      environment: {
        runtime: Runtime.host(),
      },
      repo: ({ input, result }) =>
        Repo.readWrite({
          message: `fix: ${result.summary} (${input.title})`,
          onPushFailure: "warn",
        }),
      agentPrompt: ({ input }) => `Fix: ${input.title}`,
    });
    expect(spec.repo).toEqual({
      mode: "readWrite",
      message: "fix: {{result.summary}} ({{input.title}})",
      onPushFailure: "warn",
    });
    expect(inlineEnvironment(spec.environment)?.runtime).toEqual({
      kind: "host",
    });
  });

  test("function form rejects an unknown result field at the type level", () => {
    defineStep({
      ...base,
      result: z.object({ summary: z.string() }),
      repo: ({ result }) => {
        // @ts-expect-error `nope` is not on the result schema
        void result.nope;
        return Repo.readOnly();
      },
    });
  });

  test("function form rejects an unknown input field at the type level", () => {
    defineStep({
      ...base,
      input: z.object({ title: z.string() }),
      repo: ({ input }) => {
        // @ts-expect-error `nope` is not on the input schema
        void input.nope;
        return Repo.readOnly();
      },
    });
  });

  test("repo does not break vars inference: static vars in any order, a vars function before repo", () => {
    const repoFirst = defineStep({
      key: "a",
      name: "A",
      input: z.object({ id: z.string() }),
      result: z.object({ summary: z.string() }),
      repo: ({ result }) =>
        Repo.readWrite({ message: `fix: ${result.summary}` }),
      environment: {
        vars: { ID: "{{input.id}}", LEVEL: Env.inherit() },
      },
      agentPrompt: ({ env }) => {
        const id: string = env.ID;
        // @ts-expect-error undeclared keys are rejected once vars is declared
        void env.NOT_DECLARED;
        return id;
      },
    });
    const varsFirst = defineStep({
      key: "b",
      name: "B",
      input: z.object({ id: z.string() }),
      environment: {
        vars: ({ input }) => ({ ID: input.id }),
      },
      repo: ({ env }) => Repo.readOnly({ baseBranch: env.ID }),
      agentPrompt: ({ env }) => env.ID,
    });
    expect(repoFirst.repo?.mode).toBe("readWrite");
    expect(varsFirst.repo).toEqual({
      mode: "readOnly",
      baseBranch: "{{env.ID}}",
    });
  });

  test("removed repo modes are type errors with explicit or omitted runtimes", () => {
    const pairs = [
      () =>
        defineStep({
          ...base,
          environment: {
            runtime: Runtime.devcontainer(),
          },
          // @ts-expect-error none is not a current repository mode
          repo: { mode: "none" },
        }),
      () =>
        defineStep({
          ...base,
          // @ts-expect-error none is not a current repository mode
          repo: { mode: "none" },
        }),
    ];
    for (const pair of pairs)
      expect(pair).toThrow(/repo mode must be readOnly or readWrite/);
  });

  test("a produced spec passes validateDefinitionSpecs", () => {
    const steps = [
      defineStep({
        ...base,
        key: "rw",
        repo: Repo.readWrite(),
      }),
      defineStep({
        ...base,
        key: "ro",
        repo: Repo.readOnly(),
      }),
      defineStep({
        ...base,
        key: "host",
        environment: {
          runtime: Runtime.host(),
        },
        repo: Repo.readOnly({ gitCredentials: "none" }),
      }),
    ];
    expect(validateDefinitionSpecs(steps)).toEqual([]);
  });
});
