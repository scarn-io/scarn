/**
 * Integration test for the per-Task-run git credential relay inside a real
 * devcontainer: `repo: { mode: "readOnly", gitCredentials: "auto" }` makes the
 * orchestrator open a real relay session (stub credential source), patch the
 * cloned devcontainer.json with the helper mount, host-gateway run args and
 * `GIT_CONFIG_*` containerEnv, and launch it with the real devcontainer CLI
 * (the testcontainers launcher the other suites use ignores
 * `postCreateCommand` and `containerEnv`, which are what is under test).
 *
 * The selected config's `postCreateCommand` runs a real
 * `git ls-remote https://host.docker.internal:<port>/acme/private.git` against
 * a host-side stub HTTPS git server that answers 401 until git sends the
 * relay's credential, so the ls-remote only succeeds if the helper, env,
 * mount and relay all work during `postCreateCommand`. The stub's authority is
 * an extra allowed host (`SCARN_GIT_CREDENTIAL_HOSTS`).
 *
 * A code step (driven through the real `docker exec` path) then reads back the
 * post-create record, runs its own `git credential fill` (proving `docker
 * exec` inherits the env with no change to the code-step executor) and tries a
 * `git push` to the same https remote, which must fail on
 * `scarn-push-disabled`. The step reports a SHA-256 of the password it got,
 * never the password.
 *
 * Gated behind SCARN_INTEGRATION=true because it starts Docker containers.
 *
 * Run with:
 *   SCARN_INTEGRATION=true bun test tests/work/task-run/integration/work-command-git-credentials.integration.test.ts
 */
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import type { GitCredentialQuery } from "../../../../src/runtime/git-credentials/domain/git-credential-protocol";
import {
  createGitCredentialRelaySessionOpener,
  resolveGitCredentialRelayConfig,
  type OpenGitCredentialRelaySession,
} from "../../../../src/runtime/git-credentials/infra";
import type { DevcontainerLauncher } from "../../../../src/runtime/runtime-service/application/devcontainer-launcher";
import { DevcontainerCliLauncher } from "../../../../src/runtime/runtime-service/infra/devcontainer-cli-launcher";
import { runProjectWork } from "../../../../src/work/task-run/application/run-project-work";
import {
  buildIntegrationDeps,
  type IntegrationDeps,
} from "./helpers/build-integration-deps";
import type { ContainerRegistry } from "./helpers/containers/container-registry";
import { FakeTaskRunWorkerClient } from "./helpers/fake-worker-client";
import { buildSingleStepScenario } from "./helpers/scenario";
import {
  STUB_GIT_REF_SHA,
  StubHttpsGitServer,
} from "./helpers/stub-https-git-server";

const integrationEnabled = process.env["SCARN_INTEGRATION"] === "true";
const TEST_TIMEOUT_MS = 4 * 60 * 1000;
const CONFIG_PATH = ".devcontainer/git-credentials/devcontainer.json";
const CODE_STEP_ENTRYPOINT = {
  sourceFile:
    ".scarn/pipeline-builder/integration-git-credentials-code-step.mjs",
};
const STUB_USERNAME = "x-access-token";
const STUB_PASSWORD = "stub-relay-password-not-a-real-secret-4f9c";
const WORKER_PACKAGE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

type CodeStepResult = {
  summary: string;
  postCreate: string | null;
  fill: {
    status: number | null;
    username: string | null;
    passwordSha256: string | null;
  };
  push: { status: number | null; stderr: string };
};

/** The real devcontainer CLI, with each launched container tracked for teardown. */
function trackedCliLauncher(registry: ContainerRegistry): DevcontainerLauncher {
  const cli = new DevcontainerCliLauncher();
  return {
    resolveConfigPath: (input) => cli.resolveConfigPath(input),
    launch: async (input) => {
      const result = await cli.launch(input);
      registry.registerContainerId(result.containerId);
      return result;
    },
    stop: (containerId) => cli.stop(containerId),
  };
}

describe.skipIf(!integrationEnabled)(
  "git credential relay in a devcontainer (integration)",
  () => {
    const savedEnv: Record<string, string | undefined> = {};
    let homeDir: string;
    let stubServer: StubHttpsGitServer;
    let built: IntegrationDeps | undefined;

    function setEnv(key: string, value: string): void {
      if (!(key in savedEnv)) {
        savedEnv[key] = process.env[key];
      }
      process.env[key] = value;
    }

    beforeEach(async () => {
      homeDir = await mkdtemp(path.join(os.tmpdir(), "scarn-git-cred-it-"));
      setEnv("HOME", homeDir);
      setEnv(
        "SCARN_DEVCONTAINER_SCRIPT",
        process.env["SCARN_DEVCONTAINER_SCRIPT"] ??
          Bun.resolveSync(
            "@devcontainers/cli/dist/spec-node/devContainersSpecCLI.js",
            WORKER_PACKAGE_DIR,
          ),
      );
      stubServer = new StubHttpsGitServer({
        username: STUB_USERNAME,
        password: STUB_PASSWORD,
      });
    });

    afterEach(async () => {
      await built?.containerRegistry.stopAll();
      built = undefined;
      await stubServer.stop();
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) {
          Reflect.deleteProperty(process.env, key);
        } else {
          process.env[key] = value;
        }
        Reflect.deleteProperty(savedEnv, key);
      }
      await rm(homeDir, { recursive: true, force: true }).catch(
        () => undefined,
      );
    });

    test(
      "postCreateCommand's git ls-remote authenticates through the relay, a code step's git credential fill gets the credential, and git push fails",
      async () => {
        const bindAddress = resolveGitCredentialRelayConfig({}).bindAddress;
        const stubPort = await stubServer.start(bindAddress);
        const authority = `host.docker.internal:${String(stubPort)}`;
        setEnv("SCARN_IT_GIT_STUB_AUTHORITY", authority);

        const queries: GitCredentialQuery[] = [];
        const registeredSecrets: string[] = [];
        const realOpener = createGitCredentialRelaySessionOpener({
          config: resolveGitCredentialRelayConfig({
            SCARN_GIT_CREDENTIAL_HOSTS: authority,
          }),
          sourceFactory: () => ({
            mode: "host",
            get: (query) => {
              queries.push(query);
              return Promise.resolve({
                username: STUB_USERNAME,
                password: STUB_PASSWORD,
                expiresAt: null,
              });
            },
          }),
          baseDir: path.join(homeDir, "git-credential-sessions"),
        });
        const openGitCredentialRelaySession: OpenGitCredentialRelaySession = (
          input,
        ) =>
          realOpener({
            ...input,
            onSecretValues: (values) => {
              registeredSecrets.push(...values);
              input.onSecretValues(values);
            },
          });

        const scenario = buildSingleStepScenario({
          projectId: createUuidV7(),
          taskRunId: createUuidV7(),
          findings: {},
          devcontainerConfigPath: CONFIG_PATH,
          codeEntrypoint: CODE_STEP_ENTRYPOINT,
          repo: { mode: "readOnly", gitCredentials: "auto" },
          inputJson: { authority },
        });
        const workerClient = new FakeTaskRunWorkerClient(scenario);
        built = buildIntegrationDeps({
          workerClient,
          verbose: process.env["SCARN_INTEGRATION_VERBOSE"] === "true",
          devcontainerLauncher: trackedCliLauncher,
          openGitCredentialRelaySession,
        });

        const result = await runProjectWork(
          {
            projectId: scenario.projectId,
            baseUrl: "http://127.0.0.1:1",
            concurrency: 1,
            batchSize: 1,
            pollIntervalMs: 250,
            missingFindingsGraceMs: 5_000,
            leaseDurationSeconds: 60,
            once: true,
            sessionStartTimeoutMs: 60_000,
          },
          built.deps,
        );

        expect(result.processedCount).toBe(1);
        expect(workerClient.failCalls).toEqual([]);
        expect(workerClient.completeCalls).toHaveLength(1);
        const step = workerClient.completeCalls[0]
          ?.resultJson as CodeStepResult;

        expect(step.postCreate).toBe(
          `status=0\n${STUB_GIT_REF_SHA}\tHEAD\n${STUB_GIT_REF_SHA}\trefs/heads/main\n`,
        );
        expect(stubServer.authAttempts.map((a) => a.outcome)).toContain(
          "accepted",
        );
        expect(stubServer.authAttempts.map((a) => a.outcome)).not.toContain(
          "rejected",
        );

        expect(step.fill).toEqual({
          status: 0,
          username: STUB_USERNAME,
          passwordSha256: createHash("sha256")
            .update(STUB_PASSWORD)
            .digest("hex"),
        });

        expect(step.push.status).not.toBe(0);
        expect(step.push.stderr).toContain("scarn-push-disabled");

        expect(queries).toEqual([
          { protocol: "https", host: authority, path: "acme/private.git" },
          { protocol: "https", host: authority, path: "acme/private.git" },
        ]);
        expect(registeredSecrets).toEqual([STUB_PASSWORD, STUB_PASSWORD]);

        const shipped = workerClient.appendedLogLines.map(
          (line) => line.content,
        );
        const auditLine = `[git-credentials] git credential get ${authority}/acme/private.git: issued (host)`;
        expect(shipped.filter((line) => line === auditLine)).toHaveLength(2);
        expect(shipped.join("\n")).not.toContain(STUB_PASSWORD);
      },
      TEST_TIMEOUT_MS,
    );
  },
);
