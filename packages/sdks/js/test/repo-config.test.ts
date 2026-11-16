import { describe, expect, test } from "bun:test";
import {
  MAX_REPO_COMMIT_MESSAGE_LENGTH,
  findDisallowedCommitMessageTokenRoots,
  repoConfigInputSchema,
  repoConfigSchema,
  resolveRepoConfig,
  type RepoConfig,
} from "../src/repo-config";

const READ_ONLY_DEFAULTS = { baseBranch: null } as const;
const READ_WRITE_DEFAULTS = {
  ...READ_ONLY_DEFAULTS,
  workBranch: { kind: "create" },
} as const;

describe("repoConfigInputSchema", () => {
  test.each([
    [{ mode: "readOnly" }],
    [{ mode: "readWrite" }],
    [{ mode: "readWrite", message: "fix: {{result.summary}}" }],
    [{ mode: "readWrite", onPushFailure: "warn" }],
    [{ mode: "readWrite", message: "{{input.title}}", onPushFailure: "fail" }],
    [{ mode: "readOnly", gitCredentials: "none" }],
    [{ mode: "readOnly", gitCredentials: "auto" }],
    [{ mode: "readWrite", gitCredentials: "none" }],
  ])("accepts %j", (input) => {
    expect(repoConfigInputSchema.safeParse(input).success).toBe(true);
  });

  test.each([
    [{}, "no mode"],
    [{ mode: "none" }, "removed mode"],
    [{ mode: "write" }, "unknown mode"],
    [{ mode: "read_write" }, "snake_case mode"],
    [{ mode: "none", message: "x" }, "message on none"],
    [{ mode: "readOnly", message: "x" }, "message on readOnly"],
    [{ mode: "readOnly", onPushFailure: "fail" }, "onPushFailure on readOnly"],
    [{ mode: "readWrite", onPushFailure: "ignore" }, "unknown onPushFailure"],
    [{ mode: "readWrite", message: 3 }, "non-string message"],
    [{ mode: "readWrite", extra: true }, "unknown key"],
    [{ mode: "none", gitCredentials: "none" }, "gitCredentials on none"],
    [{ mode: "none", gitCredentials: "auto" }, "gitCredentials auto on none"],
    [{ mode: "readOnly", gitCredentials: "write" }, "unknown gitCredentials"],
  ])("rejects %j (%s)", (input) => {
    expect(repoConfigInputSchema.safeParse(input).success).toBe(false);
  });

  test("a resolved RepoConfig is a valid input", () => {
    const resolved: RepoConfig[] = [
      { mode: "readOnly", gitCredentials: "auto", ...READ_ONLY_DEFAULTS },
      { mode: "readOnly", gitCredentials: "none", ...READ_ONLY_DEFAULTS },
      {
        mode: "readWrite",
        message: null,
        onPushFailure: "fail",
        gitCredentials: "auto",
        ...READ_WRITE_DEFAULTS,
      },
      {
        mode: "readWrite",
        message: "x {{input.a}}",
        onPushFailure: "warn",
        gitCredentials: "none",
        baseBranch: "ephemeral-{{env.TICKET}}",
        workBranch: { kind: "base" },
      },
    ];
    for (const config of resolved) {
      expect(repoConfigInputSchema.safeParse(config).success).toBe(true);
    }
  });
});

describe("repoConfigSchema", () => {
  test("accepts every resolved shape", () => {
    for (const config of [
      { mode: "readOnly", gitCredentials: "auto", ...READ_ONLY_DEFAULTS },
      {
        mode: "readWrite",
        message: null,
        onPushFailure: "fail",
        gitCredentials: "auto",
        ...READ_WRITE_DEFAULTS,
      },
      {
        mode: "readWrite",
        message: "m",
        onPushFailure: "warn",
        gitCredentials: "none",
        ...READ_WRITE_DEFAULTS,
      },
    ]) {
      expect(repoConfigSchema.safeParse(config).success).toBe(true);
    }
  });

  test("requires message, onPushFailure and gitCredentials on readWrite", () => {
    expect(repoConfigSchema.safeParse({ mode: "readWrite" }).success).toBe(
      false,
    );
    expect(
      repoConfigSchema.safeParse({
        mode: "readWrite",
        onPushFailure: "fail",
        gitCredentials: "auto",
        ...READ_WRITE_DEFAULTS,
      }).success,
    ).toBe(false);
    expect(
      repoConfigSchema.safeParse({
        mode: "readWrite",
        message: null,
        gitCredentials: "auto",
        ...READ_WRITE_DEFAULTS,
      }).success,
    ).toBe(false);
    expect(
      repoConfigSchema.safeParse({
        mode: "readWrite",
        message: null,
        onPushFailure: "fail",
      }).success,
    ).toBe(false);
  });

  test("requires gitCredentials on readOnly and rejects it on none", () => {
    expect(repoConfigSchema.safeParse({ mode: "readOnly" }).success).toBe(
      false,
    );
    expect(
      repoConfigSchema.safeParse({ mode: "none", gitCredentials: "auto" })
        .success,
    ).toBe(false);
  });

  test("applies the message rules to a stored message", () => {
    expect(
      repoConfigSchema.safeParse({
        mode: "readWrite",
        message: "{{env.TOKEN}}",
        onPushFailure: "fail",
        gitCredentials: "auto",
      }).success,
    ).toBe(false);
  });
});

describe("commit message rule", () => {
  const parse = (message: string) =>
    repoConfigInputSchema.safeParse({ mode: "readWrite", message });

  test("accepts exactly the maximum length", () => {
    expect(parse("a".repeat(MAX_REPO_COMMIT_MESSAGE_LENGTH)).success).toBe(
      true,
    );
  });

  test("rejects one character over the maximum", () => {
    expect(parse("a".repeat(MAX_REPO_COMMIT_MESSAGE_LENGTH + 1)).success).toBe(
      false,
    );
  });

  test.each(["line one\nline two", "line one\r\nline two", "a\rb"])(
    "rejects a newline in %j",
    (message) => {
      const result = parse(message);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toContain("single line");
    },
  );

  test.each([
    "{{input.title}}",
    "{{result.summary}}",
    "{{input.a.b}} and {{result.c}}",
    "{{input}}",
    "{{workItem.title}}",
    "{{workItem.platformKey}}: {{result.summary}}",
    "no tokens at all",
    "unterminated {{env.X",
  ])("accepts %j", (message) => {
    expect(parse(message).success).toBe(true);
  });

  test.each([
    "{{env.SECRET}}",
    "{{scarn.artifactsDir}}",
    "ok {{input.a}} then {{env.B}}",
    "{{ input.spaced }}",
    "{{inputs.title}}",
    "{{other}}",
    "{{workItem}}",
    "{{workItem.description}}",
    "{{workItem.fields.size}}",
    "{{workItem.title.length}}",
  ])("rejects the token root in %j", (message) => {
    const result = parse(message);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("tokens");
  });

  test("lists the disallowed roots in order", () => {
    expect(
      findDisallowedCommitMessageTokenRoots(
        "{{env.A}} {{input.b}} {{scarn.c}} {{result.d}}",
      ),
    ).toEqual(["env", "scarn"]);
  });

  test("lists a disallowed workItem token by its whole path", () => {
    expect(
      findDisallowedCommitMessageTokenRoots(
        "{{workItem.title}} {{workItem.fields.size}}",
      ),
    ).toEqual(["workItem.fields.size"]);
  });
});

describe("resolveRepoConfig", () => {
  test("an omitted repo becomes readWrite", () => {
    expect(resolveRepoConfig()).toEqual({
      mode: "readWrite",
      message: null,
      onPushFailure: "fail",
      gitCredentials: "auto",
      ...READ_WRITE_DEFAULTS,
    });
  });

  test("an explicitly undefined repo becomes readWrite", () => {
    expect(resolveRepoConfig(undefined)).toEqual({
      mode: "readWrite",
      message: null,
      onPushFailure: "fail",
      gitCredentials: "auto",
      ...READ_WRITE_DEFAULTS,
    });
  });

  test("null is treated as omitted", () => {
    expect(resolveRepoConfig(null)).toEqual(resolveRepoConfig());
  });

  test("host read policies retain explicit options", () => {
    expect(
      resolveRepoConfig({
        mode: "readOnly",
        gitCredentials: "none",
      }),
    ).toEqual({
      mode: "readOnly",
      gitCredentials: "none",
      ...READ_ONLY_DEFAULTS,
    });
    expect(
      resolveRepoConfig({
        mode: "readWrite",
        message: "fix: {{result.summary}}",
        onPushFailure: "warn",
        gitCredentials: "none",
      }),
    ).toEqual({
      mode: "readWrite",
      message: "fix: {{result.summary}}",
      onPushFailure: "warn",
      gitCredentials: "none",
      ...READ_WRITE_DEFAULTS,
    });
    expect(resolveRepoConfig({ mode: "readOnly" })).toEqual({
      mode: "readOnly",
      gitCredentials: "auto",
      ...READ_ONLY_DEFAULTS,
    });
  });

  test("readWrite fills an omitted message, onPushFailure and gitCredentials", () => {
    expect(resolveRepoConfig({ mode: "readWrite" })).toEqual({
      mode: "readWrite",
      message: null,
      onPushFailure: "fail",
      gitCredentials: "auto",
      ...READ_WRITE_DEFAULTS,
    });
  });

  test("readWrite fills only the omitted field", () => {
    expect(resolveRepoConfig({ mode: "readWrite", message: "m" })).toEqual({
      mode: "readWrite",
      message: "m",
      onPushFailure: "fail",
      gitCredentials: "auto",
      ...READ_WRITE_DEFAULTS,
    });
    expect(
      resolveRepoConfig({
        mode: "readWrite",
        onPushFailure: "warn",
      }),
    ).toEqual({
      mode: "readWrite",
      message: null,
      onPushFailure: "warn",
      gitCredentials: "auto",
      ...READ_WRITE_DEFAULTS,
    });
    expect(
      resolveRepoConfig({
        mode: "readWrite",
        gitCredentials: "none",
      }),
    ).toEqual({
      mode: "readWrite",
      message: null,
      onPushFailure: "fail",
      gitCredentials: "none",
      ...READ_WRITE_DEFAULTS,
    });
  });

  test("readOnly fills gitCredentials and preserves explicit none credentials", () => {
    expect(resolveRepoConfig({ mode: "readOnly" })).toEqual({
      mode: "readOnly",
      gitCredentials: "auto",
      ...READ_ONLY_DEFAULTS,
    });
    expect(
      resolveRepoConfig({
        mode: "readOnly",
        gitCredentials: "none",
      }),
    ).toEqual({
      mode: "readOnly",
      gitCredentials: "none",
      ...READ_ONLY_DEFAULTS,
    });
  });

  test("is idempotent on a resolved config", () => {
    const resolved = resolveRepoConfig({
      mode: "readWrite",
      message: "{{result.summary}}",
      onPushFailure: "warn",
      gitCredentials: "none",
    });
    expect(resolveRepoConfig(resolved)).toEqual(resolved);
  });

  test("output satisfies repoConfigSchema", () => {
    for (const input of [
      undefined,
      { mode: "readOnly" },
      { mode: "readOnly", gitCredentials: "none" },
      { mode: "readWrite", message: "m" },
      { mode: "readWrite", gitCredentials: "none" },
      {
        mode: "readWrite",
        message: "m",
        onPushFailure: "warn",
        gitCredentials: "none",
        ...READ_WRITE_DEFAULTS,
      },
    ] as const) {
      expect(repoConfigSchema.safeParse(resolveRepoConfig(input)).success).toBe(
        true,
      );
    }
  });
});
