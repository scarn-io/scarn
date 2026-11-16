import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach } from "bun:test";
import type { ResolvedEnvironmentRefInput } from "@scarn/sdk/environment";
import { runGit } from "../../../../../src/runtime/runtime-service/infra/run-git";
import { readGitCommit } from "../../../../../src/work/task-run/infra/git-commit";
import { DefaultLocalProjectRuntimeEnvironmentOrchestrator } from "../../../../../src/work/task-run/infra/local-project-runtime-environment";
import {
  buildLaunchInput,
  buildOrchestratorFakeDeps,
  FakeGitCommitPushService,
  type CallLog,
} from "./orchestrator-launch-fakes";

type NamedEnvironmentContent = Extract<
  ResolvedEnvironmentRefInput,
  { content: unknown }
>["content"];

/** A named environment as the server pins it in the run's worker context. */
export function namedEnvironment(
  content: NamedEnvironmentContent,
  { name = "local", version = 1 } = {},
): ResolvedEnvironmentRefInput {
  return { kind: "named", name, version, content };
}

export function environmentLaunchFixture(onWorkspace: (path: string) => void) {
  let directory: string;
  let workspacePath: string;
  let hasGit = false;
  beforeEach(async () => {
    hasGit = false;
    directory = await mkdtemp(
      path.join(os.tmpdir(), "environment-resolution-"),
    );
    workspacePath = path.join(directory, "repo");
    await mkdir(workspacePath);
    onWorkspace(workspacePath);
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function setup() {
    const log: CallLog = [];
    const git = new FakeGitCommitPushService(log);
    const deps = buildOrchestratorFakeDeps({
      workspacePath,
      providerOutputDir: path.join(directory, "provider"),
      log,
      gitCommitPushService: git,
    });
    deps.readGitCommit = (workspace, ref) =>
      hasGit ? readGitCommit(workspace, ref) : Promise.resolve("a".repeat(40));
    deps.gitCloneService.cloneRepository = () => {
      log.push("clone");
      return Promise.resolve({ resolvedBranch: "main" });
    };
    return {
      deps,
      git,
      log,
      orchestrator: new DefaultLocalProjectRuntimeEnvironmentOrchestrator(
        undefined,
        deps,
      ),
      input: { ...buildLaunchInput(), startAgent: false },
    };
  }

  async function writeCanonical() {
    await mkdir(path.join(workspacePath, ".devcontainer"), { recursive: true });
    await writeFile(
      path.join(workspacePath, ".devcontainer/devcontainer.json"),
      '{"image":"checkout-image"}',
    );
  }

  function gitCommand(...args: string[]) {
    return runGit(["-C", workspacePath, ...args], {
      label: args.join(" "),
      timeoutMs: 10_000,
    });
  }

  async function commitFile(content: string, file = "README.md") {
    await mkdir(path.dirname(path.join(workspacePath, file)), {
      recursive: true,
    });
    await writeFile(path.join(workspacePath, file), content);
    await gitCommand("add", ".");
    await gitCommand(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      file,
    );
    return (await gitCommand("rev-parse", "HEAD")).trim();
  }

  async function initRepo(content = "repo", file?: string) {
    await gitCommand("init", "-b", "main");
    hasGit = true;
    const commit = await commitFile(content, file);
    await gitCommand("update-ref", "refs/remotes/origin/main", commit);
    return commit;
  }

  return {
    setup,
    writeCanonical,
    gitCommand,
    commitFile,
    initRepo,
  };
}
