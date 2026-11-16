import { describe, expect, test } from "bun:test";
import {
  BASE_BRANCH_DEPENDS_ON_INPUT_NOTE,
  BaseBranchEnvUndeclaredError,
  assertBaseBranchFitsEnvironment,
  dryRunBaseBranch,
  environmentRefVars,
  renderBaseBranch,
  type BaseBranchEnvVar,
} from "../../../../src/work/task-run/application/render-base-branch";
import { RepoBranchInvalidError } from "../../../../src/work/task-run/application/repo-branch-invalid-error";
import { MissingStepEnvError } from "../../../../src/work/task-run/application/resolve-step-env";
import { buildTaskRunFailurePayload } from "../../../../src/work/task-run/application/build-task-run-failure-payload";
import { listStepHealthCheckFindings } from "../../../../src/work/task-run/application/pipeline-health-check-report";
import { rejectionOf } from "./helpers/orchestrator-launch-fakes";

const vars: BaseBranchEnvVar[] = [
  { name: "TICKET", source: "value", value: "123", secret: false },
  {
    name: "TEAM",
    source: "inherit",
    from: "WORKER_TEAM",
    secret: false,
    default: "core",
  },
  { name: "TOKEN", source: "inherit", from: "WORKER_TOKEN", secret: true },
  { name: "KEY", source: "secret" },
  { name: "TITLE", source: "value", value: "{{input.title}}", secret: false },
];

function render(template: string | null, workerEnv = {}) {
  return dryRunBaseBranch({ template, envVars: vars, workerEnv });
}

describe("dryRunBaseBranch", () => {
  test("no baseBranch falls through without a note", () => {
    expect(render(null)).toEqual({
      baseWorkBranch: null,
      baseBranchNote: null,
    });
  });

  test("a literal is used as is", () => {
    expect(render("release/1.2").baseWorkBranch).toBe("release/1.2");
  });

  test("renders env tokens from value and non-secret inherit vars", () => {
    expect(render("ephemeral-{{env.TICKET}}").baseWorkBranch).toBe(
      "ephemeral-123",
    );
    expect(
      render("{{env.TEAM}}/{{ env.TICKET }}", { WORKER_TEAM: "web" })
        .baseWorkBranch,
    ).toBe("web/123");
    expect(render("{{env.TEAM}}/x").baseWorkBranch).toBe("core/x");
  });

  for (const template of [
    "feature/{{input.branch}}",
    "{{workItem.platformKey}}",
    "{{env.TICKET}}-{{input.n}}",
  ]) {
    test(`skips ${template}: depends on input`, () => {
      expect(render(template)).toEqual({
        baseWorkBranch: null,
        baseBranchNote: BASE_BRANCH_DEPENDS_ON_INPUT_NOTE,
      });
    });
  }

  for (const name of ["TOKEN", "KEY", "TITLE", "MISSING"]) {
    test(`skips an env token it cannot resolve without a run (${name})`, () => {
      const result = render(`b-{{env.${name}}}`, { WORKER_TOKEN: "s3cret" });
      expect(result.baseWorkBranch).toBeNull();
      expect(result.baseBranchNote).toContain(name);
      expect(result.baseBranchNote).not.toContain("s3cret");
    });
  }

  test("skips a rendered name that is not a valid branch", () => {
    const result = render("{{env.TEAM}}", { WORKER_TEAM: "bad name" });
    expect(result.baseWorkBranch).toBeNull();
    expect(result.baseBranchNote).toContain("not a valid branch name");
  });
});

describe("environmentRefVars", () => {
  test("reads inline and named environments' vars", () => {
    const ticket = {
      name: "TICKET",
      source: "value" as const,
      value: "123",
      secret: false,
    };
    expect(environmentRefVars(null)).toEqual([]);
    expect(environmentRefVars({ kind: "inline", envJson: [ticket] })).toEqual([
      ticket,
    ]);
    expect(
      environmentRefVars({
        kind: "named",
        name: "env",
        version: 1,
        content: { vars: [ticket] },
      }),
    ).toEqual([ticket]);
    expect(
      environmentRefVars({ kind: "named", name: "env", notFound: true }),
    ).toEqual([]);
  });
});

describe("the run-offer gate's base branch note", () => {
  test("is reported without blocking, even when the launch failed", () => {
    const step = {
      stepDefinitionId: "id-a",
      stepKey: "a",
      stepName: "A",
      runtime: "host",
      environmentProblems: [],
      mcpServers: [],
      healthChecks: [],
      baseBranchNote: BASE_BRANCH_DEPENDS_ON_INPUT_NOTE,
    };
    for (const launchError of [null, "boom"]) {
      expect(
        listStepHealthCheckFindings([{ ...step, launchError }])[0],
      ).toMatchObject({
        checkName: "base branch",
        message: BASE_BRANCH_DEPENDS_ON_INPUT_NOTE,
        blocking: false,
      });
    }
  });
});

describe("assertBaseBranchFitsEnvironment", () => {
  const check = (template: string | null, environmentLabel?: string) => () => {
    assertBaseBranchFitsEnvironment({
      template,
      envVars: vars,
      ...(environmentLabel ? { environmentLabel } : {}),
    });
  };

  test("declared non-secret vars and other tokens pass", () => {
    expect(check(null)).not.toThrow();
    expect(
      check("{{env.TICKET}}-{{env.TEAM}}/{{input.x}}/{{workItem.platformKey}}"),
    ).not.toThrow();
  });

  test("an undeclared var is SCARN_ENVIRONMENT_UNRESOLVED", () => {
    const run = check("b/{{env.MISSING}}", "environment frontend v3");
    expect(run).toThrow(BaseBranchEnvUndeclaredError);
    expect(run).toThrow(MissingStepEnvError);
    expect(run).toThrow(
      "repo.baseBranch reads {{env.MISSING}}, which environment frontend v3 does not declare",
    );
    const error = (() => {
      try {
        run();
      } catch (thrown) {
        return thrown as Error;
      }
      return null;
    })();
    expect(buildTaskRunFailurePayload(error).errorJson).toMatchObject({
      name: "Scarn.EnvironmentUnresolved",
      code: "SCARN_ENVIRONMENT_UNRESOLVED",
    });
  });

  test("secret and secret inherit vars are SCARN_REPO_BRANCH_INVALID", () => {
    for (const name of ["KEY", "TOKEN"]) {
      const run = check(`{{env.${name}}}`);
      expect(run).toThrow(RepoBranchInvalidError);
      expect(run).toThrow(`{{env.${name}}} names a secret var`);
      try {
        run();
      } catch (thrown) {
        expect(
          buildTaskRunFailurePayload(thrown as Error).errorJson,
        ).toMatchObject({
          name: "Scarn.RepoBranchInvalid",
          code: "SCARN_REPO_BRANCH_INVALID",
        });
      }
    }
  });
});

describe("renderBaseBranch", () => {
  const renderRun = (
    template: string | null,
    context: Partial<Parameters<typeof renderBaseBranch>[1]> = {},
  ) =>
    renderBaseBranch(template, {
      inputJson: { version: "1.2", empty: "" },
      envVars: vars,
      workerEnv: {},
      ...context,
    });

  test("no baseBranch renders null", async () => {
    expect(await renderRun(null)).toBeNull();
  });

  test("renders env, input and workItem tokens", async () => {
    let reads = 0;
    const loadWorkItem = () => {
      reads += 1;
      return Promise.resolve({ title: "t", platformKey: "ABC-123" });
    };
    expect(
      await renderRun("ephemeral-{{ env.TICKET }}", { loadWorkItem }),
    ).toBe("ephemeral-123");
    expect(reads).toBe(0);
    expect(await renderRun("release/{{input.version}}")).toBe("release/1.2");
    expect(
      await renderRun("{{env.TEAM}}/{{workItem.platformKey}}", {
        loadWorkItem,
        workerEnv: { WORKER_TEAM: "web" },
      }),
    ).toBe("web/ABC-123");
    expect(reads).toBe(1);
  });

  test("an env value var renders against the input", async () => {
    expect(
      await renderRun("b/{{env.TITLE}}", { inputJson: { title: "fix" } }),
    ).toBe("b/fix");
  });

  test("an inherit var the worker doesn't set is SCARN_ENVIRONMENT_UNRESOLVED", async () => {
    const error = (await rejectionOf(
      renderRun("b/{{env.TEAM}}", {
        envVars: [
          {
            name: "TEAM",
            source: "inherit",
            from: "WORKER_TEAM",
            secret: false,
          },
        ],
      }),
    )) as Error;
    expect(error).toBeInstanceOf(MissingStepEnvError);
    expect(error.message).toContain("WORKER_TEAM");
    expect(buildTaskRunFailurePayload(error).errorJson.code).toBe(
      "SCARN_ENVIRONMENT_UNRESOLVED",
    );
  });

  test("an undeclared var is SCARN_ENVIRONMENT_UNRESOLVED", async () => {
    const error = (await rejectionOf(renderRun("b/{{env.MISSING}}"))) as Error;
    expect(error).toBeInstanceOf(BaseBranchEnvUndeclaredError);
  });

  for (const [label, template, context] of [
    ["an empty input token", "b/{{input.empty}}", {}],
    ["an absent input token", "b/{{input.nope}}", {}],
    ["an unread work item", "{{workItem.platformKey}}", {}],
    ["a trailing dot", "b/{{input.version}}.", {}],
    ["a .. from input", "{{input.dots}}", { inputJson: { dots: "a..b" } }],
    ["a secret var", "{{env.TOKEN}}", { workerEnv: { WORKER_TOKEN: "s" } }],
  ] as const) {
    test(`${label} is SCARN_REPO_BRANCH_INVALID`, async () => {
      const error = (await rejectionOf(renderRun(template, context))) as Error;
      expect(error).toBeInstanceOf(RepoBranchInvalidError);
      expect(buildTaskRunFailurePayload(error).errorJson).toMatchObject({
        name: "Scarn.RepoBranchInvalid",
        code: "SCARN_REPO_BRANCH_INVALID",
      });
    });
  }
});
