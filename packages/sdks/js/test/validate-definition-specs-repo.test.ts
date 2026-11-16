import { describe, expect, test } from "bun:test";
import { validateDefinitionSpecs } from "../src/definitions/validation";
import { stepSpecWithOverrides } from "./definition-spec-fixtures";

/**
 * `validateDefinitionSpecs — repo`: the `repo` check runs `repoConfigInputSchema`
 * over hand-built specs that bypass `Repo`, independently of runtime.
 */
describe("validateDefinitionSpecs — repo", () => {
  const validate = (steps: ReturnType<typeof stepSpecWithOverrides>[]) =>
    validateDefinitionSpecs(steps);

  test.concurrent("accepts every valid pair", () => {
    expect(
      validate([
        stepSpecWithOverrides("rw", {
          environment: {
            kind: "inline",
            runtime: { kind: "devcontainer" },
            envJson: null,
          },
          repo: { mode: "readWrite", message: "fix: {{result.summary}}" },
        }),
        stepSpecWithOverrides("ro", {
          environment: {
            kind: "inline",
            runtime: { kind: "devcontainer" },
            envJson: null,
          },
          repo: { mode: "readOnly" },
        }),
        stepSpecWithOverrides("host", {
          environment: {
            kind: "inline",
            runtime: { kind: "host" },
            envJson: null,
          },
          repo: { mode: "readOnly", gitCredentials: "none" },
        }),
      ]),
    ).toEqual([]);
  });

  test.concurrent("validates repo shape with an omitted runtime", () => {
    expect(
      validate([stepSpecWithOverrides("s", { repo: { mode: "readOnly" } })]),
    ).toEqual([]);
    const issues = validate([
      stepSpecWithOverrides("s", { repo: { mode: "none" } as never }),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe("repo");
  });

  test.concurrent("stays quiet for an omitted repo", () => {
    expect(
      validate([
        stepSpecWithOverrides("a"),
        stepSpecWithOverrides("b", {
          environment: {
            kind: "inline",
            runtime: { kind: "host" },
            envJson: null,
          },
        }),
      ]),
    ).toEqual([]);
  });

  test.concurrent("accepts a resolved repo sent back as input", () => {
    expect(
      validate([
        stepSpecWithOverrides("s", {
          repo: { mode: "readWrite", message: null, onPushFailure: "fail" },
        }),
      ]),
    ).toEqual([]);
  });

  test.each([
    { mode: "readWrite" },
    { mode: "readOnly" },
    { mode: "readOnly", gitCredentials: "none" },
    {
      mode: "readWrite",
      message: "fix: {{result.summary}}",
      onPushFailure: "warn",
      gitCredentials: "none",
    },
  ] as const)("accepts %j on a host step", (repo) => {
    expect(
      validate([
        stepSpecWithOverrides("host-step", {
          environment: {
            kind: "inline",
            runtime: { kind: "host" },
            envJson: null,
          },
          repo,
        }),
      ]),
    ).toEqual([]);
  });

  test.concurrent(
    "rejects the removed none mode on a devcontainer step",
    () => {
      const issues = validate([
        stepSpecWithOverrides("dev-step", {
          environment: {
            kind: "inline",
            runtime: { kind: "devcontainer" },
            envJson: null,
          },
          repo: { mode: "none" } as never,
        }),
      ]);
      expect(issues).toHaveLength(1);
      expect(issues[0]?.check).toBe("repo");
      expect(issues[0]?.severity).toBe("error");
      expect(issues[0]?.message).toContain('Step "dev-step"');
      expect(issues[0]?.message).toContain("readOnly");
      expect(issues[0]?.message).toContain("readWrite");
    },
  );

  test.concurrent("rejects a code step with the removed none mode", () => {
    const issues = validate([
      stepSpecWithOverrides("code", {
        kind: "code",
        repo: { mode: "none" } as never,
      }),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe("repo");
  });

  test.concurrent("rejects an env token in the message", () => {
    const issues = validate([
      stepSpecWithOverrides("leaky", {
        repo: { mode: "readWrite", message: "deploy {{env.API_TOKEN}}" },
      }),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe("repo");
    expect(issues[0]?.message).toContain('Step "leaky" repo message');
    expect(issues[0]?.message).toContain("tokens");
  });

  test.concurrent("rejects a newline in the message", () => {
    const issues = validate([
      stepSpecWithOverrides("multi", {
        repo: { mode: "readWrite", message: "one\ntwo" },
      }),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("single line");
  });

  test.concurrent("rejects a message over 500 characters", () => {
    const issues = validate([
      stepSpecWithOverrides("long", {
        repo: { mode: "readWrite", message: "a".repeat(501) },
      }),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe("repo");
    expect(issues[0]?.message).toContain('Step "long" repo message');
  });

  test.concurrent("rejects a message on readOnly", () => {
    const issues = validate([
      stepSpecWithOverrides("ro", {
        repo: { mode: "readOnly", message: "x" } as never,
      }),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe("repo");
  });

  test.concurrent(
    "rejects an unknown mode and an unknown onPushFailure",
    () => {
      const badMode = validate([
        stepSpecWithOverrides("m", { repo: { mode: "write" } as never }),
      ]);
      expect(badMode).toHaveLength(1);
      expect(badMode[0]?.check).toBe("repo");

      const badPush = validate([
        stepSpecWithOverrides("p", {
          repo: { mode: "readWrite", onPushFailure: "ignore" } as never,
        }),
      ]);
      expect(badPush).toHaveLength(1);
      expect(badPush[0]?.message).toContain('Step "p" repo onPushFailure');
    },
  );

  test.concurrent("still rejects an invalid message on a host step", () => {
    const issues = validate([
      stepSpecWithOverrides("both", {
        environment: {
          kind: "inline",
          runtime: { kind: "host" },
          envJson: null,
        },
        repo: { mode: "readWrite", message: "{{env.X}}" },
      }),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("tokens");
  });
});
