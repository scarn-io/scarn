import { describe, expect } from "bun:test";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import type { CoreValidationError } from "@/lib/errors";
import type { TaskExecutionConfigContentInput } from "@/tasks/task-execution-config/contracts/task-execution-config-contracts";
import { TaskExecutionConfigEntity } from "@/tasks/task-execution-config/domain/task-execution-config-entity";
import { concurrentTest } from "tests/utils";

const readOnly = (gitCredentials: "auto" | "none") =>
  ({
    mode: "readOnly",
    gitCredentials,
    baseBranch: null,
  }) as const;

const emptyContent: TaskExecutionConfigContentInput = {
  environment: null,
  git: null,
  mcp: null,
  healthChecks: null,
};

const create = (
  content: Partial<TaskExecutionConfigContentInput>,
  projectId = createUuidV7(),
) =>
  TaskExecutionConfigEntity.create({
    projectId,
    content: { ...emptyContent, ...content },
  });

const codeOf = (build: () => unknown) => {
  try {
    build();
  } catch (error) {
    return (error as CoreValidationError).code;
  }
  return null;
};

describe("task execution config entity", () => {
  concurrentTest("an all-null config is empty", () => {
    expect(create({}).isEmpty()).toBe(true);
  });

  concurrentTest(
    "preserves explicit empty inline while normalizing empty vars",
    () => {
      const config = create({ environment: { kind: "inline", vars: [] } });
      expect(config.environment).toEqual({ kind: "inline" });
      expect(config.isEmpty()).toBe(false);
    },
  );

  concurrentTest("preserves schema-valid named refs on write paths", () => {
    const config = create({
      environment: { kind: "named", name: "integration" },
    });
    expect(config.environment).toEqual({ kind: "named", name: "integration" });
    expect(config.isEmpty()).toBe(false);
    expect(config.contentHash()).toBe(
      create(
        {
          environment: { kind: "named", name: "integration" },
        },
        config.projectId,
      ).contentHash(),
    );
  });

  concurrentTest(
    "normalizes empty lists, maps and repo defaults to null",
    () => {
      const config = create({
        git: { mode: "readWrite" },
        mcp: {},
        healthChecks: [],
      });

      expect(config.isEmpty()).toBe(true);
      expect<object>(config.content()).toEqual(emptyContent);
    },
  );

  concurrentTest("any override makes the config non-empty", () => {
    expect(
      create({
        environment: { kind: "inline", runtime: { kind: "host" } },
      }).isEmpty(),
    ).toBe(false);
    expect(create({ git: { mode: "readOnly" } }).isEmpty()).toBe(false);
    expect(
      create({
        healthChecks: [{ kind: "cli", command: ["gh", "--version"] }],
      }).isEmpty(),
    ).toBe(false);
  });

  concurrentTest("defaults env var applies to agent", () => {
    const config = create({
      environment: {
        kind: "inline",
        vars: [
          { name: "LOG_LEVEL", source: "value", value: "debug", secret: false },
        ],
      },
    });

    expect(
      config.environment?.kind === "inline" && config.environment.vars,
    ).toEqual([
      {
        name: "LOG_LEVEL",
        source: "value",
        value: "debug",
        secret: false,
        applies: "agent",
      },
    ]);
  });

  concurrentTest("is frozen", () => {
    const config = create({
      environment: { kind: "inline", runtime: { kind: "host" } },
    });

    expect(Object.isFrozen(config)).toBe(true);
  });

  describe("{env:VAR} rule (D10)", () => {
    concurrentTest("rejects a literal local server environment value", () => {
      expect(
        codeOf(() =>
          create({
            mcp: {
              db: {
                type: "local",
                command: ["db"],
                environment: { DB_TOKEN: "s3cret-literal" },
              },
            },
          }),
        ),
      ).toBe("TASK_EXECUTION_CONFIG_INVALID");
    });

    concurrentTest("rejects a literal remote server header", () => {
      expect(
        codeOf(() =>
          create({
            mcp: {
              hosted: {
                type: "remote",
                url: "https://example.com/mcp",
                headers: { authorization: "Bearer token" },
              },
            },
          }),
        ),
      ).toBe("TASK_EXECUTION_CONFIG_INVALID");
    });

    concurrentTest("rejects a placeholder mixed with a literal", () => {
      expect(
        codeOf(() =>
          create({
            mcp: {
              db: {
                type: "local",
                command: ["db"],
                environment: { URL: "postgres://{env:HOST}/db" },
              },
            },
          }),
        ),
      ).toBe("TASK_EXECUTION_CONFIG_INVALID");
    });

    concurrentTest("accepts {env:VAR} values and an auth scheme prefix", () => {
      const config = create({
        mcp: {
          db: {
            type: "local",
            command: ["db"],
            environment: { DB_TOKEN: "{env:DB_TOKEN}" },
          },
          hosted: {
            type: "remote",
            url: "https://example.com/mcp",
            headers: { authorization: "Bearer {env:HOSTED_TOKEN}" },
          },
        },
      });

      expect(Object.keys(config.mcp ?? {})).toEqual(["db", "hosted"]);
    });
  });

  describe("git vs runtime (D9)", () => {
    concurrentTest("rejects git none in the default devcontainer", () => {
      expect(codeOf(() => create({ git: { mode: "none" } as never }))).toBe(
        "TASK_EXECUTION_CONFIG_INVALID",
      );
    });

    concurrentTest("accepts readOnly on a host runtime", () => {
      expect(
        create({
          environment: { kind: "inline", runtime: { kind: "host" } },
          git: { mode: "readOnly" },
        }).git,
      ).toEqual(readOnly("auto"));
    });

    concurrentTest("accepts readOnly on a managed runtime", () => {
      const config = create({
        environment: {
          kind: "inline",
          runtime: { kind: "managed", id: "bun1" },
        },
        git: { mode: "readOnly" },
      });

      expect(config.git).toEqual(readOnly("auto"));
    });

    concurrentTest(
      "keeps explicit host readOnly without credentials as a nondefault",
      () => {
        expect(
          create({
            environment: { kind: "inline", runtime: { kind: "host" } },
            git: { mode: "readOnly", gitCredentials: "none" },
          }).git,
        ).toEqual(readOnly("none"));
      },
    );

    concurrentTest("stores the runtime's default git as null", () => {
      expect(
        create({
          environment: { kind: "inline", runtime: { kind: "host" } },
          git: { mode: "readWrite" },
        }).git,
      ).toBeNull();
      expect(
        create({
          git: { mode: "readWrite", message: null, onPushFailure: "fail" },
        }).git,
      ).toBeNull();
    });

    concurrentTest("keeps a non-default readWrite git", () => {
      expect(
        create({ git: { mode: "readWrite", onPushFailure: "warn" } }).git,
      ).toEqual({
        mode: "readWrite",
        message: null,
        onPushFailure: "warn",
        gitCredentials: "auto",
        baseBranch: null,
        workBranch: { kind: "create" },
      });
    });
  });

  describe("cross-field rules (D14)", () => {
    const refServer = { github: { type: "ref" as const } };

    concurrentTest("rejects an env var naming an unknown MCP server", () => {
      expect(
        codeOf(() =>
          create({
            environment: {
              kind: "inline",
              vars: [
                {
                  name: "GITHUB_TOKEN",
                  source: "inherit",
                  from: "GITHUB_TOKEN",
                  secret: true,
                  optional: false,
                  mcp: "github",
                },
              ],
            },
          }),
        ),
      ).toBe("TASK_EXECUTION_CONFIG_ENV_MCP_UNKNOWN");
    });

    concurrentTest("accepts an env var naming an inline MCP server", () => {
      const config = create({
        mcp: { github: { type: "local", command: ["gh-mcp"] } },
        environment: {
          kind: "inline",
          vars: [
            {
              name: "GITHUB_TOKEN",
              source: "inherit",
              from: "GITHUB_TOKEN",
              secret: true,
              optional: false,
              mcp: "github",
            },
          ],
        },
      });

      expect(
        config.environment?.kind === "inline" && config.environment.vars?.[0],
      ).toMatchObject({ mcp: "github" });
    });

    concurrentTest("rejects an MCP env var that applies to setup", () => {
      expect(
        codeOf(() =>
          create({
            mcp: refServer,
            environment: {
              kind: "inline",
              vars: [
                {
                  name: "GITHUB_TOKEN",
                  source: "inherit",
                  from: "GITHUB_TOKEN",
                  secret: true,
                  optional: false,
                  mcp: "github",
                  applies: "setup",
                },
              ],
            },
          }),
        ),
      ).toBe("TASK_EXECUTION_CONFIG_ENV_MCP_APPLIES_NOT_ALLOWED");
    });

    concurrentTest("rejects a setup env var on a host runtime", () => {
      expect(
        codeOf(() =>
          create({
            environment: {
              kind: "inline",
              runtime: { kind: "host" },
              vars: [
                {
                  name: "NPM_TOKEN",
                  source: "value",
                  value: "x",
                  secret: false,
                  applies: "both",
                },
              ],
            },
          }),
        ),
      ).toBe("TASK_EXECUTION_CONFIG_ENV_SETUP_WITHOUT_WORKSPACE");
    });

    concurrentTest("keeps a setup env var on a workspace runtime", () => {
      const config = create({
        environment: {
          kind: "inline",
          vars: [
            {
              name: "NPM_TOKEN",
              source: "inherit",
              from: "NPM_TOKEN",
              secret: true,
              optional: false,
              applies: "setup",
            },
          ],
        },
      });

      expect(
        config.environment?.kind === "inline" &&
          config.environment.vars?.[0]?.applies,
      ).toBe("setup");
    });

    concurrentTest("accepts an MCP env var for a ref server", () => {
      const config = create({
        mcp: refServer,
        environment: {
          kind: "inline",
          vars: [
            {
              name: "GITHUB_TOKEN",
              source: "inherit",
              from: "GITHUB_TOKEN",
              secret: true,
              optional: false,
              mcp: "github",
            },
          ],
        },
      });

      expect(
        config.environment?.kind === "inline" && config.environment.vars?.[0],
      ).toMatchObject({
        mcp: "github",
        applies: "agent",
      });
    });

    concurrentTest(
      "rejects a health check naming an unknown MCP server",
      () => {
        expect(
          codeOf(() =>
            create({
              mcp: refServer,
              healthChecks: [
                { kind: "tool", tool: "list_issues", mcp: "jira" },
              ],
            }),
          ),
        ).toBe("TASK_EXECUTION_CONFIG_HEALTH_CHECK_MCP_UNKNOWN");
      },
    );

    concurrentTest("accepts a health check naming any declared server", () => {
      const config = create({
        mcp: { browser: { type: "local", command: ["pw"] } },
        healthChecks: [{ kind: "tool", tool: "navigate", mcp: "browser" }],
      });

      expect(config.healthChecks).toHaveLength(1);
    });
  });
});
