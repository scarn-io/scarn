import { describe, expect, expectTypeOf, test } from "bun:test";
import { z } from "zod";
import { Env, Repo, WorkBranch, codeStep, defineStep } from "../src";
import { defineEnvironment } from "../src/definitions/environments";
import { compileRepo } from "../src/definitions/steps/repo";
import {
  MAX_REPO_BASE_BRANCH_LENGTH,
  findDisallowedBaseBranchTokens,
  isValidGitBranchName,
  repoConfigInputSchema,
  resolveRepoConfig,
} from "../src/repo-config";

const frontend = defineEnvironment({
  name: "frontend",
  vars: {
    TICKET_NUMBER: Env.inherit(),
    MODE: Env.value({ value: "fast" }),
    TOKEN: Env.secret("TOKEN"),
  },
});

describe("WorkBranch", () => {
  test("create() and base() are the wire values", () => {
    expect(WorkBranch.create()).toEqual({ kind: "create" });
    expect(WorkBranch.base()).toEqual({ kind: "base" });
  });
});

describe("Repo branch options", () => {
  test("readOnly and readWrite keep baseBranch", () => {
    expect(Repo.readOnly({ baseBranch: "main" })).toEqual({
      mode: "readOnly",
      baseBranch: "main",
    });
    expect(
      Repo.readWrite({
        baseBranch: "main",
        workBranch: WorkBranch.base(),
      }),
    ).toEqual({
      mode: "readWrite",
      baseBranch: "main",
      workBranch: { kind: "base" },
    });
  });

  test("workBranch on readOnly and startFrom are type errors", () => {
    // @ts-expect-error a readOnly step commits nothing, so it has no work branch
    Repo.readOnly({ workBranch: WorkBranch.base() });
    // @ts-expect-error a set baseBranch always wins; there is no startFrom
    Repo.readWrite({ startFrom: "base" });
  });
});

describe("compileRepo — baseBranch tokens", () => {
  test("each token kind compiles from proxies", () => {
    const config = compileRepo<
      { ticket: { id: string } },
      unknown,
      { TICKET_NUMBER: string }
    >(({ input, env, workItem }) =>
      Repo.readWrite({
        baseBranch: `feature/${input.ticket.id}-${env.TICKET_NUMBER}-${workItem.platformKey}`,
        workBranch: WorkBranch.base(),
      }),
    );
    expect(config).toEqual({
      mode: "readWrite",
      baseBranch:
        "feature/{{input.ticket.id}}-{{env.TICKET_NUMBER}}-{{workItem.platformKey}}",
      workBranch: { kind: "base" },
    });
  });

  test("a bare proxy compiles to its token", () => {
    expect(
      compileRepo(({ env }) => Repo.readOnly({ baseBranch: env.BRANCH })),
    ).toEqual({
      mode: "readOnly",
      baseBranch: "{{env.BRANCH}}",
    });
  });

  test("a result token throws", () => {
    expect(() =>
      compileRepo<unknown, { branch: string }>(
        ({ result }) => Repo.readWrite({ baseBranch: result.branch }),
        { stepKey: "s" },
      ),
    ).toThrow(/Step "s" repo: baseBranch may only use/);
  });

  test.each([
    ["{{scarn.artifactsDir}}", "unknown root"],
    ["{{workItem.title}}", "workItem key other than platformKey"],
    ["{{workItem}}", "bare workItem"],
    ["{{env}}", "bare env"],
    ["{{env.A.B}}", "nested env"],
    ["{{result.branch}}", "result"],
  ])("rejects %j (%s)", (baseBranch) => {
    expect(() => compileRepo(Repo.readOnly({ baseBranch }))).toThrow(
      /baseBranch may only use/,
    );
  });

  test("rejects a newline", () => {
    expect(() => compileRepo(Repo.readWrite({ baseBranch: "a\nb" }))).toThrow(
      /baseBranch must be a single line/,
    );
  });

  test("rejects a value over the length limit", () => {
    expect(
      repoConfigInputSchema.safeParse({
        mode: "readOnly",
        baseBranch: "a".repeat(MAX_REPO_BASE_BRANCH_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  test.each([
    "main..dev",
    "has space",
    "tilde~1",
    "caret^",
    "colon:x",
    "what?",
    "star*",
    "br[acket",
    "back\\slash",
    "tab\tname",
    "-leading-dash",
    "/leading-slash",
    "trailing/",
    "name.lock",
    "dir/name.lock",
    "trailing.",
    "double//slash",
    "at@{brace",
    "@",
    ".hidden",
    "dir/.hidden",
    "",
  ])("rejects the invalid literal %j", (baseBranch) => {
    expect(
      repoConfigInputSchema.safeParse({ mode: "readOnly", baseBranch }).success,
    ).toBe(false);
  });

  test("checks the literal parts around tokens", () => {
    expect(() =>
      compileRepo(Repo.readWrite({ baseBranch: "bad branch/{{env.X}}" })),
    ).toThrow(/valid branch name/);
    expect(() =>
      compileRepo(Repo.readWrite({ baseBranch: "{{env.X}}.lock" })),
    ).toThrow(/valid branch name/);
  });

  test.each(["main", "release/2026.11", "feature/ABC-123_fix", "a@b", "x.y"])(
    "accepts the valid literal %j",
    (baseBranch) => {
      expect(isValidGitBranchName(baseBranch)).toBe(true);
      expect(compileRepo(Repo.readOnly({ baseBranch }))).toEqual({
        mode: "readOnly",
        baseBranch,
      });
    },
  );

  test("lists disallowed tokens in order", () => {
    expect(
      findDisallowedBaseBranchTokens(
        "{{result.a}}-{{input.b}}-{{env.C.D}}-{{workItem.title}}-{{env.E}}",
      ),
    ).toEqual(["result", "env.C.D", "workItem.title"]);
  });

  test("workBranch is rejected on readOnly for untyped callers", () => {
    expect(
      repoConfigInputSchema.safeParse({
        mode: "readOnly",
        workBranch: { kind: "base" },
      }).success,
    ).toBe(false);
    expect(
      repoConfigInputSchema.safeParse({
        mode: "readWrite",
        workBranch: { kind: "other" },
      }).success,
    ).toBe(false);
  });
});

describe("resolveRepoConfig — branch defaults", () => {
  test("fills null and create", () => {
    expect(resolveRepoConfig({ mode: "readOnly" })).toEqual({
      mode: "readOnly",
      gitCredentials: "auto",
      baseBranch: null,
    });
    expect(resolveRepoConfig({ mode: "readWrite" })).toMatchObject({
      baseBranch: null,
      workBranch: { kind: "create" },
    });
  });

  test("keeps explicit values and is idempotent", () => {
    const resolved = resolveRepoConfig({
      mode: "readWrite",
      baseBranch: "ephemeral-{{env.TICKET_NUMBER}}",
      workBranch: { kind: "base" },
    });
    expect(resolved).toMatchObject({
      baseBranch: "ephemeral-{{env.TICKET_NUMBER}}",
      workBranch: { kind: "base" },
    });
    expect(resolveRepoConfig(resolved)).toEqual(resolved);
  });
});

describe("repo env typing", () => {
  test("a handle types env from its declared, non-secret vars", () => {
    const spec = defineStep({
      key: "apply",
      name: "Apply",
      environment: frontend,
      repo: ({ env }) => {
        const ticket: string = env.TICKET_NUMBER;
        const mode: string = env.MODE;
        // @ts-expect-error secrets are dropped from env
        void env.TOKEN;
        // @ts-expect-error undeclared keys are rejected
        void env.NOT_DECLARED;
        return Repo.readWrite({
          baseBranch: `ephemeral-${ticket}-${mode}`,
          workBranch: WorkBranch.base(),
        });
      },
      agentPrompt: "go",
    });
    expect(spec.repo).toEqual({
      mode: "readWrite",
      baseBranch: "ephemeral-{{env.TICKET_NUMBER}}-{{env.MODE}}",
      workBranch: { kind: "base" },
    });
  });

  test("inline vars type env strictly", () => {
    defineStep({
      key: "inline",
      name: "Inline",
      input: z.object({ id: z.string() }),
      environment: { vars: { LEVEL: "info", KEY: Env.secret("KEY") } },
      repo: ({ env }) => {
        // @ts-expect-error secrets are dropped from env
        void env.KEY;
        return Repo.readOnly({ baseBranch: env.LEVEL });
      },
      agentPrompt: "go",
    });
  });

  test("a name types env as a string record", () => {
    defineStep({
      key: "named",
      name: "Named",
      environment: "frontend",
      repo: ({ env }) => {
        expectTypeOf(env).toEqualTypeOf<Record<string, string>>();
        return Repo.readOnly({ baseBranch: String(env.ANYTHING) });
      },
      agentPrompt: "go",
    });
  });

  test("codeStep types env the same way", () => {
    const spec = codeStep({
      key: "code",
      name: "Code",
      fn: () => ({}),
      environment: frontend,
      repo: ({ env }) => {
        // @ts-expect-error secrets are dropped from env
        void env.TOKEN;
        return Repo.readWrite({ baseBranch: env.TICKET_NUMBER });
      },
    });
    expect(spec.repo).toEqual({
      mode: "readWrite",
      baseBranch: "{{env.TICKET_NUMBER}}",
    });
    codeStep({
      key: "code-named",
      name: "Code named",
      fn: () => ({}),
      environment: "frontend",
      repo: ({ env }) => {
        expectTypeOf(env).toEqualTypeOf<Record<string, string>>();
        return Repo.readOnly();
      },
    });
    codeStep({
      key: "code-inline",
      name: "Code inline",
      fn: () => ({}),
      environment: { vars: { LEVEL: "info" } },
      repo: ({ env }) => {
        // @ts-expect-error undeclared keys are rejected
        void env.OTHER;
        return Repo.readOnly({ baseBranch: env.LEVEL });
      },
    });
  });
});
