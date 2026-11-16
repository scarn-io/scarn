import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createLogger } from "@scarn/observability/logging/host";
import { GitCliCloneService } from "../../../../../src/runtime/runtime-service/infra/git-cli-clone-service";
import { DefaultLocalProjectRuntimeEnvironmentOrchestrator } from "../../../../../src/work/task-run/infra/local-project-runtime-environment";
import { buildLocalProjectRuntimeDeps } from "../../../../../src/work/task-run/infra/local-project-runtime-environment-deps";
import { DirectProviderAccessResolver } from "../../../../../src/work/task-run/infra/provider-access/direct-provider-access-resolver";
import { SafeProviderAccessResolver } from "../../../../../src/work/task-run/infra/provider-access/safe-provider-access-resolver";
import { SessionRuntimeConfigMaterializer } from "../../../../../src/work/task-run/infra/provider-access/session-runtime-config-materializer";

const execFileAsync = promisify(execFile);

export async function buildHostCheckout() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "health-check-repo-"));
  const gitUrl = path.join(directory, "repo");
  const dispose = () => rm(directory, { recursive: true, force: true });
  const git = (args: string[]) =>
    execFileAsync("git", ["-C", gitUrl, ...args], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  try {
    await mkdir(gitUrl);
    await git(["init", "-b", "main"]);
    await writeFile(path.join(gitUrl, "README.md"), "# Health check fixture\n");
    await git(["add", "."]);
    await git([
      "-c",
      "user.name=Scarn Integration",
      "-c",
      "user.email=integration@scarn.io",
      "commit",
      "--no-gpg-sign",
      "-m",
      "Initial fixture",
    ]);
    const logger = createLogger({
      name: "@scarn/worker",
      level:
        process.env["SCARN_INTEGRATION_VERBOSE"] === "true"
          ? "debug"
          : "silent",
    });
    const deps = buildLocalProjectRuntimeDeps(
      logger,
      {},
      {
        gitCloneService: new GitCliCloneService(logger),
        providerAccessResolver: new SafeProviderAccessResolver(
          new DirectProviderAccessResolver({ logger }),
        ),
        runtimeConfigMaterializer: new SessionRuntimeConfigMaterializer({
          outputBaseDir: path.join(directory, "provider-config"),
        }),
        loadCredentials: () => Promise.resolve([]),
        openGitCredentialRelaySession: null,
      },
    );
    return {
      gitUrl,
      orchestrator: new DefaultLocalProjectRuntimeEnvironmentOrchestrator(
        logger,
        deps,
      ),
      async seedMcpConfig(mcp: Record<string, unknown>) {
        await mkdir(path.join(gitUrl, ".opencode"), { recursive: true });
        await writeFile(
          path.join(gitUrl, ".opencode/opencode.json"),
          JSON.stringify({ mcp }),
        );
        await git(["add", ".opencode"]);
        await git([
          "-c",
          "user.name=Scarn Integration",
          "-c",
          "user.email=integration@scarn.io",
          "commit",
          "--no-gpg-sign",
          "-m",
          "Configure MCP fixture",
        ]);
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
