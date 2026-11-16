import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DevcontainerCliLauncher,
  ImplicitDevcontainerConfigMissingError,
} from "../../../../src/runtime/runtime-service/infra/devcontainer-cli-launcher";
import { MANAGED_RUNTIME_INSTALL_ARTIFACT_PATHS } from "../../../../src/runtime/runtime-service/domain/managed-runtimes";
import { DefaultLocalProjectRuntimeEnvironmentOrchestrator } from "../../../../src/work/task-run/infra/local-project-runtime-environment";
import { WORK_BRANCH_EXCLUDE_PATHS } from "../../../../src/work/task-run/infra/work-branch-manager";
import { BrokenDevcontainerReference } from "@scarn/sdk/environment";
import {
  buildLaunchInput,
  buildOrchestratorFakeDeps,
  FakeGitCommitPushService,
  rejectionOf,
  type CallLog,
} from "./helpers/orchestrator-launch-fakes";

const BUN1_CONFIG_PATH = ".scarn/managed-devcontainers/bun1/devcontainer.json";

describe("Repo default launch runtime", () => {
  let sessionDir: string;
  let workspacePath: string;

  beforeEach(async () => {
    sessionDir = await mkdtemp(path.join(os.tmpdir(), "repo-default-"));
    workspacePath = path.join(sessionDir, "repo");
    await mkdir(workspacePath);
  });

  afterEach(async () => {
    await rm(sessionDir, { recursive: true, force: true });
  });

  function setup() {
    const log: CallLog = [];
    const commitPush = new FakeGitCommitPushService(log);
    const deps = buildOrchestratorFakeDeps({
      workspacePath,
      providerOutputDir: path.join(sessionDir, "provider"),
      log,
      gitCommitPushService: commitPush,
    });
    const resolver = new DevcontainerCliLauncher();
    deps.gitCloneService.cloneRepository = () =>
      Promise.resolve({ resolvedBranch: "main" });
    deps.devcontainerLauncher.resolveConfigPath = (input) =>
      resolver.resolveConfigPath(input);
    const messages: string[] = [];
    const input = {
      ...buildLaunchInput(),
      startAgent: false,
      logger: {
        debug() {},
        error() {},
        log(scope: string, message: string) {
          if (scope === "runtime") messages.push(message);
        },
      },
    };
    const orchestrator = new DefaultLocalProjectRuntimeEnvironmentOrchestrator(
      undefined,
      deps,
    );
    return { deps, orchestrator, input, messages, commitPush };
  }

  async function writeConfig(
    configPath: string,
    content = '{"image":"repo-image"}',
  ) {
    await mkdir(path.dirname(path.join(workspacePath, configPath)), {
      recursive: true,
    });
    await writeFile(path.join(workspacePath, configPath), content);
  }

  for (const configPath of [
    ".devcontainer/devcontainer.json",
    "devcontainer.json",
  ]) {
    test(`uses present ${configPath} and logs the lookup branch reason`, async () => {
      await writeConfig(configPath);
      const { orchestrator, input, messages } = setup();
      const env = await orchestrator.launch({
        ...input,
        stepKey: "code",
        baseWorkBranch: "scarn/previous",
      });

      expect(env.devcontainerConfigPath).toBe(configPath);
      expect(
        messages.filter((message) => message.startsWith("Repo default")),
      ).toEqual([
        `Repo default picked devcontainer (${configPath}): config found on lookup branch "scarn/previous".`,
      ]);
      expect(
        await Bun.file(path.join(workspacePath, BUN1_CONFIG_PATH)).exists(),
      ).toBe(false);
    });
  }

  test("prefers the conventional nested config when both exist", async () => {
    await writeConfig(".devcontainer/devcontainer.json");
    await writeConfig("devcontainer.json");
    const { orchestrator, input } = setup();
    const env = await orchestrator.launch(input);
    expect(env.devcontainerConfigPath).toBe(".devcontainer/devcontainer.json");
  });

  for (const startAgent of [false, true]) {
    test(`missing configs select bun1 with the correct install policy (startAgent=${String(startAgent)})`, async () => {
      const { deps, orchestrator, input, messages } = setup();
      const env = await orchestrator.launch({ ...input, startAgent });
      const config = JSON.parse(
        await readFile(path.join(workspacePath, BUN1_CONFIG_PATH), "utf8"),
      ) as Record<string, unknown>;

      expect(env.devcontainerConfigPath).toBe(BUN1_CONFIG_PATH);
      expect(
        deps.devcontainerLauncher.launchInputs[0]?.devcontainerConfigPath,
      ).toBe(BUN1_CONFIG_PATH);
      expect(config["image"]).toBe("oven/bun:1.4.0-debian");
      expect(typeof config["onCreateCommand"]).toBe(
        startAgent ? "undefined" : "string",
      );
      expect(
        messages.filter((message) => message.startsWith("Repo default")),
      ).toEqual([
        'Repo default picked bun1: neither .devcontainer/devcontainer.json nor devcontainer.json exists on lookup branch "main".',
      ]);
    });
  }

  test("keeps fallback config and install artifacts out of commits", async () => {
    const { orchestrator, input, commitPush } = setup();
    const env = await orchestrator.launch({ ...input, stepKey: "code" });
    await env.commitAndPushWorkBranch?.({ result: {} });
    expect(commitPush.commitAllExcludePaths).toEqual([
      [
        ...WORK_BRANCH_EXCLUDE_PATHS,
        BUN1_CONFIG_PATH,
        ...MANAGED_RUNTIME_INSTALL_ARTIFACT_PATHS,
      ],
    ]);
  });

  test("a present invalid config fails parsing without fallback", async () => {
    await writeConfig(".devcontainer/devcontainer.json", "{ invalid json");
    const { deps, orchestrator, input, messages } = setup();
    await rejectionOf(orchestrator.launch({ ...input, startAgent: true }));
    expect(deps.devcontainerLauncher.launchInputs).toEqual([]);
    expect(
      messages.some((message) =>
        message.startsWith("Repo default picked bun1"),
      ),
    ).toBe(false);
    expect(
      await Bun.file(path.join(workspacePath, BUN1_CONFIG_PATH)).exists(),
    ).toBe(false);
  });

  test("a build failure never triggers fallback", async () => {
    await writeConfig("devcontainer.json");
    const { deps, orchestrator, input } = setup();
    const error = new ImplicitDevcontainerConfigMissingError(workspacePath);
    deps.devcontainerLauncher.launch = () => Promise.reject(error);
    expect(await rejectionOf(orchestrator.launch(input))).toBe(error);
    expect(
      await Bun.file(path.join(workspacePath, BUN1_CONFIG_PATH)).exists(),
    ).toBe(false);
  });

  test("explicit pathless devcontainer does not fall back", async () => {
    const { deps, orchestrator, input } = setup();
    expect(
      await rejectionOf(
        orchestrator.launch({
          ...input,
          environment: { kind: "inline", runtime: { kind: "devcontainer" } },
        }),
      ),
    ).toBeInstanceOf(BrokenDevcontainerReference);
    expect(deps.devcontainerLauncher.launchInputs).toEqual([]);
  });

  test("an explicit missing config never falls back", async () => {
    const { deps, orchestrator, input } = setup();
    const error = await rejectionOf(
      orchestrator.launch({
        ...input,
        environment: {
          kind: "inline",
          runtime: {
            kind: "devcontainer",
            config: ".devcontainer/custom/devcontainer.json",
          },
        },
      }),
    );
    expect((error as Error).message).toContain('branch "main"');
    expect(deps.devcontainerLauncher.launchInputs).toEqual([]);
    expect(
      await Bun.file(path.join(workspacePath, BUN1_CONFIG_PATH)).exists(),
    ).toBe(false);
  });

  for (const code of ["EACCES", "ENOTDIR", "ELOOP", undefined]) {
    test(`does not interpret a ${code ?? "generic missing-text"} error as absence`, async () => {
      const { deps, orchestrator, input } = setup();
      await writeConfig("devcontainer.json");
      const error = Object.assign(new Error("No devcontainer spec found"), {
        code,
      });
      deps.devcontainerLauncher.resolveConfigPath = () => Promise.reject(error);
      const failure = await rejectionOf(orchestrator.launch(input));
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).cause).toBe(error);
      expect((failure as Error).message).toContain('branch "main"');
      expect(deps.devcontainerLauncher.launchInputs).toEqual([]);
    });
  }

  test("a real filesystem lookup error propagates instead of using the root config", async () => {
    await symlink(".devcontainer", path.join(workspacePath, ".devcontainer"));
    await writeConfig("devcontainer.json");
    const { deps, orchestrator, input } = setup();
    const error = await rejectionOf(orchestrator.launch(input));
    expect((error as NodeJS.ErrnoException).code).toBe("ELOOP");
    expect(deps.devcontainerLauncher.launchInputs).toEqual([]);
  });

  test("an explicit managed runtime overrides Repo default without a default-choice log", async () => {
    const { orchestrator, input, messages } = setup();
    const env = await orchestrator.launch({
      ...input,
      environment: {
        kind: "inline",
        runtime: { kind: "managed", id: "node24" },
      },
    });
    expect(env.devcontainerConfigPath).toContain("/node24/");
    expect(
      messages.filter((message) => message.startsWith("Repo default")),
    ).toEqual([]);
  });
});
