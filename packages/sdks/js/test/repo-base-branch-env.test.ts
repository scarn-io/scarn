import { describe, expect, test } from "bun:test";
import { Env, Repo, codeStep, defineStep } from "../src";
import { defineEnvironment } from "../src/definitions/environments";
import { findBaseBranchEnvProblems } from "../src/repo-config";

const frontend = defineEnvironment({
  name: "frontend",
  vars: {
    TICKET: Env.inherit(),
    MODE: Env.value({ value: "fast" }),
    TOKEN: Env.secret("TOKEN"),
    HIDDEN: Env.inherit({ secret: true }),
  },
});

const step =
  (environment: Parameters<typeof defineStep>[0]["environment"]) =>
  (baseBranch: string) =>
    defineStep({
      key: "apply",
      name: "Apply",
      environment,
      repo: Repo.readOnly({ baseBranch }),
      agentPrompt: "go",
    });

describe("findBaseBranchEnvProblems", () => {
  const vars = [
    { name: "TICKET", source: "inherit", secret: false },
    { name: "HIDDEN", source: "inherit", secret: true },
    { name: "LOUD", source: "value", secret: true },
    { name: "TOKEN", source: "secret" },
  ] as const;

  test("reports undeclared and secret env tokens, in order", () => {
    expect(
      findBaseBranchEnvProblems(
        "{{env.NOPE}}-{{env.TICKET}}-{{env.HIDDEN}}-{{env.LOUD}}-{{env.TOKEN}}",
        vars,
      ),
    ).toEqual([
      { token: "env.NOPE", reason: "undeclared" },
      { token: "env.HIDDEN", reason: "secret" },
      { token: "env.LOUD", reason: "secret" },
      { token: "env.TOKEN", reason: "secret" },
    ]);
  });

  test("ignores input and workItem tokens", () => {
    expect(
      findBaseBranchEnvProblems("{{input.x}}/{{workItem.platformKey}}", []),
    ).toEqual([]);
  });
});

describe("defineStep — baseBranch env tokens", () => {
  test("by handle: a declared non-secret var passes", () => {
    expect(step(frontend)("b/{{env.TICKET}}-{{env.MODE}}").repo).toEqual({
      mode: "readOnly",
      baseBranch: "b/{{env.TICKET}}-{{env.MODE}}",
    });
  });

  test("by handle: an undeclared var throws naming the step and token", () => {
    expect(() => step(frontend)("b/{{env.MISSING}}")).toThrow(
      'Step "apply" repo: baseBranch {{env.MISSING}} names a var the environment does not declare',
    );
  });

  test("by handle: secret and secret inherit vars throw", () => {
    expect(() => step(frontend)("{{env.TOKEN}}")).toThrow(
      "{{env.TOKEN}} names a secret var",
    );
    expect(() => step(frontend)("{{env.HIDDEN}}")).toThrow(
      "{{env.HIDDEN}} names a secret var",
    );
  });

  test("by name: not checked at definition time", () => {
    expect(step("frontend")("{{env.ANYTHING}}").repo).toEqual({
      mode: "readOnly",
      baseBranch: "{{env.ANYTHING}}",
    });
  });

  test("inline vars: valid, undeclared and secret", () => {
    const inline = step({
      vars: { LEVEL: "info", KEY: Env.secret("KEY") },
    });
    expect(inline("{{env.LEVEL}}").repo?.baseBranch).toBe("{{env.LEVEL}}");
    expect(() => inline("{{env.OTHER}}")).toThrow(
      "{{env.OTHER}} names a var the environment does not declare",
    );
    expect(() => inline("{{env.KEY}}")).toThrow(
      "{{env.KEY}} names a secret var",
    );
  });

  test("inline vars as a function are checked after they run", () => {
    expect(() =>
      step({ vars: ({ input }) => ({ LEVEL: String(input) }) })(
        "{{env.OTHER}}",
      ),
    ).toThrow("{{env.OTHER}} names a var the environment does not declare");
  });

  test("no environment: every env token is undeclared", () => {
    expect(() => step(undefined)("{{env.X}}")).toThrow(
      "{{env.X}} names a var the environment does not declare",
    );
  });
});

describe("codeStep — baseBranch env tokens", () => {
  const code = (
    environment: Parameters<typeof codeStep>[0]["environment"],
    baseBranch: string,
  ) =>
    codeStep({
      key: "code",
      name: "Code",
      fn: () => ({}),
      environment,
      repo: Repo.readWrite({ baseBranch }),
    });

  test("by handle, inline and by name", () => {
    expect(code(frontend, "{{env.TICKET}}").repo?.baseBranch).toBe(
      "{{env.TICKET}}",
    );
    expect(() => code(frontend, "{{env.TOKEN}}")).toThrow(
      'Step "code" repo: baseBranch {{env.TOKEN}} names a secret var',
    );
    expect(() => code({ vars: { LEVEL: "info" } }, "{{env.NOPE}}")).toThrow(
      "{{env.NOPE}} names a var the environment does not declare",
    );
    expect(code("frontend", "{{env.NOPE}}").repo?.baseBranch).toBe(
      "{{env.NOPE}}",
    );
  });
});
