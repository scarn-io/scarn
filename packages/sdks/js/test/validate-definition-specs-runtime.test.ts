import { describe, expect, test } from "bun:test";
import { validateDefinitionSpecs } from "../src/definitions/validation";
import { stepSpecWithOverrides } from "./definition-spec-fixtures";
import type { RuntimeSpec } from "../src/definitions/steps/runtime";

/**
 * `validateDefinitionSpecs — runtime`: the `runtime` check runs the shared
 * `devcontainerConfigPathSchema` over hand-built specs that bypass `Runtime`,
 * and rejects a config path on a host step, and any code step
 * on a host runtime.
 */
describe("validateDefinitionSpecs — runtime", () => {
  const validate = (steps: ReturnType<typeof stepSpecWithOverrides>[]) =>
    validateDefinitionSpecs(steps);

  test.concurrent(
    "accepts a devcontainer step with a valid config path",
    () => {
      expect(
        validate([
          stepSpecWithOverrides("alt", {
            environment: {
              kind: "inline",
              envJson: null,
              runtime: {
                kind: "devcontainer",
                config: ".devcontainer/alt/devcontainer.json",
              },
            },
          }),
        ]),
      ).toEqual([]);
    },
  );

  test.concurrent("accepts a path with a leading ./", () => {
    expect(
      validate([
        stepSpecWithOverrides("alt", {
          environment: {
            kind: "inline",
            envJson: null,
            runtime: {
              kind: "devcontainer",
              config: "./.devcontainer/alt/devcontainer.json",
            },
          },
        }),
      ]),
    ).toEqual([]);
  });

  test.concurrent("stays quiet for null, omitted and host-without-path", () => {
    expect(
      validate([
        stepSpecWithOverrides("null-environment", { environment: null }),
        stepSpecWithOverrides("no-path"),
        stepSpecWithOverrides("host", {
          environment: {
            kind: "inline",
            envJson: null,
            runtime: { kind: "host" },
          },
        }),
      ]),
    ).toEqual([]);
  });

  test.concurrent("does not infer a runtime from a config path", () => {
    const issues = validate([
      stepSpecWithOverrides("alt", {
        environment: {
          kind: "inline",
          envJson: null,
          runtime: { config: "devcontainer.json" } as unknown as RuntimeSpec,
        },
      }),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("environment.runtime.kind");
  });

  test.each([
    ["/etc/devcontainer.json", "relative"],
    ["C:/work/devcontainer.json", "relative"],
    [".devcontainer\\devcontainer.json", "backslash"],
    ["../devcontainer.json", '".."'],
    [".devcontainer/other.json", "devcontainer.json"],
    ["", "devcontainer.json"],
    [`${"a".repeat(260)}/devcontainer.json`, "255"],
  ])("rejects the config path %j", (devcontainerConfigPath, fragment) => {
    const issues = validate([
      stepSpecWithOverrides("bad-path", {
        environment: {
          kind: "inline",
          envJson: null,
          runtime: {
            kind: "devcontainer",
            config: devcontainerConfigPath,
          },
        },
      }),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe("runtime");
    expect(issues[0]?.severity).toBe("error");
    expect(issues[0]?.message).toContain(
      'Step "bad-path" environment.runtime.config',
    );
    expect(issues[0]?.message).toContain(fragment);
  });

  test.concurrent("rejects a config path on a host step", () => {
    const issues = validate([
      stepSpecWithOverrides("host-step", {
        environment: {
          kind: "inline",
          envJson: null,
          runtime: {
            kind: "host",
            config: ".devcontainer/devcontainer.json",
          } as RuntimeSpec,
        },
      }),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe("runtime");
    expect(issues[0]?.severity).toBe("error");
    expect(issues[0]?.message).toContain('Step "host-step"');
    expect(issues[0]?.message).toContain('Unrecognized key: "config"');
  });

  test.concurrent("rejects a code step on a host runtime", () => {
    const issues = validate([
      stepSpecWithOverrides("host-code", {
        kind: "code",
        environment: {
          kind: "inline",
          envJson: null,
          runtime: { kind: "host" },
        },
      }),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe("runtime");
    expect(issues[0]?.severity).toBe("error");
    expect(issues[0]?.message).toContain('Step "host-code"');
    expect(issues[0]?.message).toContain("Runtime.host()");
    expect(issues[0]?.message).toContain("codeStep");
  });

  test.concurrent(
    "accepts code steps on repository-default and devcontainer runtimes",
    () => {
      expect(
        validate([
          stepSpecWithOverrides("code-default", { kind: "code" }),
          stepSpecWithOverrides("code-alt", {
            kind: "code",
            environment: {
              kind: "inline",
              envJson: null,
              runtime: {
                kind: "devcontainer",
                config: ".devcontainer/alt/devcontainer.json",
              },
            },
          }),
        ]),
      ).toEqual([]);
    },
  );

  test.concurrent("still allows a host agent step", () => {
    expect(
      validate([
        stepSpecWithOverrides("host-agent", {
          kind: "user_defined",
          environment: {
            kind: "inline",
            envJson: null,
            runtime: { kind: "host" },
          },
        }),
      ]),
    ).toEqual([]);
  });

  test.concurrent("reports both problems for a bad path on a host step", () => {
    const issues = validate([
      stepSpecWithOverrides("both", {
        environment: {
          kind: "inline",
          envJson: null,
          runtime: {
            kind: "host",
            config: "/abs/devcontainer.json",
          } as RuntimeSpec,
        },
      }),
    ]);
    expect(issues).toHaveLength(2);
    expect(issues.every((issue) => issue.check === "runtime")).toBe(true);
  });
});

describe("validateDefinitionSpecs — managed runtime", () => {
  const validate = (steps: ReturnType<typeof stepSpecWithOverrides>[]) =>
    validateDefinitionSpecs(steps);

  test.concurrent.each(["bun1", "node24"] as const)(
    "accepts a managed code step on %s",
    (managedRuntime) => {
      expect(
        validate([
          stepSpecWithOverrides("managed", {
            kind: "code",
            environment: {
              kind: "inline",
              envJson: null,
              runtime: {
                kind: "managed",
                id: managedRuntime,
              },
            },
          }),
        ]),
      ).toEqual([]);
    },
  );

  test.concurrent("accepts no environment on any step", () => {
    expect(
      validate([
        stepSpecWithOverrides("agent", { environment: null }),
        stepSpecWithOverrides("code", { kind: "code", environment: null }),
      ]),
    ).toEqual([]);
  });

  test.concurrent("rejects an unknown identifier", () => {
    const issues = validate([
      stepSpecWithOverrides("unknown", {
        kind: "code",
        environment: {
          kind: "inline",
          envJson: null,
          runtime: { kind: "managed", id: "bun9" } as unknown as RuntimeSpec,
        },
      }),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe("runtime");
    expect(issues[0]?.severity).toBe("error");
    expect(issues[0]?.message).toContain(
      'Step "unknown" environment.runtime.id',
    );
    expect(issues[0]?.message).toContain('"bun1"|"node24"');
  });

  test.concurrent("accepts a managed runtime on an agent step", () => {
    expect(
      validate([
        stepSpecWithOverrides("agent", {
          kind: "user_defined",
          environment: {
            kind: "inline",
            envJson: null,
            runtime: {
              kind: "managed",
              id: "bun1",
            },
          },
        }),
      ]),
    ).toEqual([]);
  });

  test.concurrent(
    "rejects a managed runtime with a devcontainer config path",
    () => {
      const issues = validate([
        stepSpecWithOverrides("both", {
          kind: "code",
          environment: {
            kind: "inline",
            envJson: null,
            runtime: {
              kind: "managed",
              id: "bun1",
              config: ".devcontainer/devcontainer.json",
            } as RuntimeSpec,
          },
        }),
      ]);
      expect(issues).toHaveLength(1);
      expect(issues[0]?.check).toBe("runtime");
      expect(issues[0]?.message).toContain('Unrecognized key: "config"');
    },
  );

  test.concurrent("rejects managed runtime details on a host step", () => {
    const issues = validate([
      stepSpecWithOverrides("host-managed", {
        kind: "code",
        environment: {
          kind: "inline",
          envJson: null,
          runtime: { kind: "host", id: "bun1" } as RuntimeSpec,
        },
      }),
    ]);
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues.every((issue) => issue.check === "runtime")).toBe(true);
    expect(
      issues.some((issue) => issue.message.includes('Unrecognized key: "id"')),
    ).toBe(true);
  });
});
