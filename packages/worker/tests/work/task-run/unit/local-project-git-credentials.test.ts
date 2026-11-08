/**
 * `prepareGitCredentialRelay`: step 3c of the single-container launch. Opens a
 * relay session for `gitCredentials: "auto"` when the worker offers one,
 * patches the cloned devcontainer.json with its mount, run args and env, skips
 * (without failing) a devcontainer that cannot take the relay, and never
 * leaves a session open when a patch throws.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RepoConfig } from "@scarn/sdk/repo-config";
import { createUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import { prepareGitCredentialRelay } from "../../../../src/work/task-run/infra/local-project-git-credentials";
import {
  DEVCONTAINER_CONFIG_PATH,
  FakeGitCredentialRelayOpener,
  rejectionOf,
  type CallLog,
} from "./helpers/orchestrator-launch-fakes";

const AUTO_REPO: RepoConfig = { mode: "readOnly", gitCredentials: "auto" };
const NONE_REPO: RepoConfig = { mode: "readOnly", gitCredentials: "none" };

describe("prepareGitCredentialRelay", () => {
  let workspacePath: string;
  let log: CallLog;
  let opener: FakeGitCredentialRelayOpener;

  beforeEach(async () => {
    workspacePath = await mkdtemp(path.join(os.tmpdir(), "git-cred-prep-"));
    await mkdir(path.join(workspacePath, ".devcontainer"), { recursive: true });
    log = [];
    opener = new FakeGitCredentialRelayOpener(log);
  });

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true });
  });

  async function writeConfig(config: Record<string, unknown>) {
    await writeFile(
      path.join(workspacePath, DEVCONTAINER_CONFIG_PATH),
      JSON.stringify(config),
      "utf8",
    );
  }

  async function readConfig(): Promise<Record<string, unknown>> {
    return JSON.parse(
      await readFile(
        path.join(workspacePath, DEVCONTAINER_CONFIG_PATH),
        "utf8",
      ),
    ) as Record<string, unknown>;
  }

  function prepare(
    repo: RepoConfig,
    onSecretValues?: (v: readonly string[]) => void,
    workerOffersCredentials = true,
  ) {
    return prepareGitCredentialRelay({
      deps: {
        openGitCredentialRelaySession: workerOffersCredentials
          ? opener.open
          : null,
      },
      repo,
      sessionId: createUuidV7(),
      runContext: {
        taskRunId: createUuidV7(),
        claimToken: "claim-token",
        repoGitUrl: "https://github.com/acme/app.git",
      },
      workspacePath,
      devcontainerConfigPath: DEVCONTAINER_CONFIG_PATH,
      onSecretValues,
    });
  }

  test("returns null and leaves the config alone when the step opts out", async () => {
    await writeConfig({ image: "base" });

    expect(await prepare(NONE_REPO)).toBeNull();
    expect(await prepare({ mode: "none" })).toBeNull();

    expect(opener.openInputs).toHaveLength(0);
    expect(await readConfig()).toEqual({ image: "base" });
  });

  test("returns null and leaves the config alone when the worker has credentials off", async () => {
    await writeConfig({ image: "base" });

    expect(await prepare(AUTO_REPO, undefined, false)).toBeNull();
    expect(await readConfig()).toEqual({ image: "base" });
  });

  test("patches mounts, runArgs and containerEnv for auto", async () => {
    await writeConfig({
      image: "base",
      mounts: ["source=/a,target=/b,type=bind"],
      runArgs: ["--init"],
      containerEnv: { FOO: "bar" },
    });
    const secrets: string[] = [];

    const session = await prepare(AUTO_REPO, (values) => {
      secrets.push(...values);
    });

    expect(session).not.toBeNull();
    expect(opener.openInputs).toHaveLength(1);
    expect(opener.openInputs[0]?.runContext.claimToken).toBe("claim-token");
    expect(opener.openInputs[0]?.runContext.repoGitUrl).toBe(
      "https://github.com/acme/app.git",
    );
    expect(opener.openInputs[0]?.rewriteSshUrls).toBe(true);
    opener.openInputs[0]?.onSecretValues(["issued-password"]);
    expect(secrets).toEqual(["issued-password"]);

    const config = await readConfig();
    expect(config["mounts"]).toEqual([
      "source=/a,target=/b,type=bind",
      expect.stringContaining("target=/opt/scarn/git-credential"),
    ]);
    expect(config["runArgs"]).toEqual([
      "--init",
      "--add-host=host.docker.internal:host-gateway",
    ]);
    expect(config["containerEnv"]).toEqual({
      GIT_CONFIG_COUNT: "1",
      FOO: "bar",
    });
    expect(opener.stopCalls).toBe(0);
  });

  test("skips the relay when containerEnv already sets GIT_CONFIG_COUNT", async () => {
    const config = { image: "base", containerEnv: { GIT_CONFIG_COUNT: "2" } };
    await writeConfig(config);

    expect(await prepare(AUTO_REPO)).toBeNull();
    expect(opener.openInputs).toHaveLength(0);
    expect(await readConfig()).toEqual(config);
  });

  test("skips the relay for a compose devcontainer", async () => {
    const config = { dockerComposeFile: "compose.yml", service: "app" };
    await writeConfig(config);

    expect(await prepare(AUTO_REPO)).toBeNull();
    expect(opener.openInputs).toHaveLength(0);
    expect(await readConfig()).toEqual(config);
  });

  test("keeps SSH URLs when the container forwards an SSH agent", async () => {
    await writeConfig({
      image: "base",
      containerEnv: { SSH_AUTH_SOCK: "/ssh-agent" },
    });

    expect(await prepare(AUTO_REPO)).not.toBeNull();
    expect(opener.openInputs[0]?.rewriteSshUrls).toBe(false);
  });

  test("stops the session when a later patch throws", async () => {
    await writeConfig({
      image: "base",
      mounts: [
        { source: "/x", target: "/opt/scarn/git-credential", type: "bind" },
      ],
    });

    expect(await rejectionOf(prepare(AUTO_REPO))).toMatchObject({
      code: "DEVCONTAINER_MOUNT_CONFLICT",
    });
    expect(opener.stopCalls).toBe(1);
  });
});
