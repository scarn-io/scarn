/**
 * Integration test for the full git credential relay loop on the host: a real
 * session (server + helper dir), the generated helper under `sh`, and real
 * `git credential fill` / `git push` with the container env, against a stub
 * source. No Docker: the helper's `endpoint` points at `127.0.0.1`.
 *
 * Git runs with a temp `HOME`, `GIT_CONFIG_NOSYSTEM=1` and a `PATH` holding
 * only the tools the helper needs, so each HTTP client (`curl`, `wget`) is
 * exercised on its own; a client that isn't installed is skipped.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import type { GitCredentialQuery } from "../../../../src/runtime/git-credentials/domain/git-credential-protocol";
import {
  CONTAINER_GIT_CREDENTIAL_DIR,
  GIT_CREDENTIAL_HELPER_FILENAME,
} from "../../../../src/runtime/git-credentials/domain/git-credential-container-env";
import { GIT_CREDENTIAL_HELPER_MISSING_TOOL_MESSAGE } from "../../../../src/runtime/git-credentials/domain/git-credential-helper-script";
import {
  createGitCredentialRelaySessionOpener,
  type GitCredentialRelaySession,
} from "../../../../src/runtime/git-credentials/infra";

const execFileAsync = promisify(execFile);

const PASSWORD = "ghs_relayIntegrationSecret0123";
const REPO_URL = "https://github.com/acme/app.git";
const BASE_TOOLS = ["cat", "dirname", "mktemp", "rm"];

type GitResult = { code: number; stdout: string; stderr: string };

let scratch: string;
let session: GitCredentialRelaySession;
let queries: GitCredentialQuery[];
let secrets: string[];
let auditLines: string[];
let realGit: string;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), "scarn-git-relay-"));
  await mkdir(path.join(scratch, "home"));
  queries = [];
  secrets = [];
  auditLines = [];
  const execPath = (await execFileAsync("git", ["--exec-path"])).stdout.trim();
  realGit = path.join(execPath, "git");
  const open = createGitCredentialRelaySessionOpener({
    config: {
      enabled: true,
      sourceMode: "host",
      extraHosts: [],
      bindAddress: "127.0.0.1",
    },
    sourceFactory: () => ({
      mode: "host",
      get: (query) => {
        queries.push(query);
        return Promise.resolve({
          username: "x-access-token",
          password: PASSWORD,
          expiresAt: null,
        });
      },
    }),
    baseDir: path.join(scratch, "sessions"),
    endpointHost: "127.0.0.1",
  });
  session = await open({
    sessionId: createUuidV7(),
    runContext: {
      taskRunId: createUuidV7(),
      claimToken: "claim",
      repoGitUrl: REPO_URL,
    },
    rewriteSshUrls: true,
    logger: {
      debug: () => {},
      log: (_scope, message) => auditLines.push(message),
      error: () => {},
    },
    onSecretValues: (values) => secrets.push(...values),
  });
});

afterEach(async () => {
  await session.stop();
  await rm(scratch, { recursive: true, force: true });
});

async function toolBin(
  name: string,
  tools: readonly string[],
): Promise<string> {
  const dir = path.join(scratch, `bin-${name}`);
  await mkdir(dir, { recursive: true });
  for (const tool of tools) {
    const resolved = Bun.which(tool);
    if (resolved === null) {
      throw new Error(`${tool} is not installed`);
    }
    await symlink(resolved, path.join(dir, tool));
  }
  return dir;
}

function gitEnv(binDir: string): NodeJS.ProcessEnv {
  const helperPath = path.join(
    session.mount.source,
    GIT_CREDENTIAL_HELPER_FILENAME,
  );
  return {
    ...session.containerEnv,
    GIT_CONFIG_VALUE_0: helperPath,
    HOME: path.join(scratch, "home"),
    XDG_CONFIG_HOME: path.join(scratch, "home", ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Scarn Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Scarn Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    PATH: binDir,
    TMPDIR: scratch,
  };
}

function run(
  file: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; cwd?: string; input?: string },
): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      { env: options.env, cwd: options.cwd ?? scratch, timeout: 20_000 },
      (error, stdout, stderr) => {
        const code =
          error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolve({ code, stdout, stderr });
      },
    );
    child.stdin?.end(options.input ?? "");
  });
}

function fill(binDir: string, host: string): Promise<GitResult> {
  return run(realGit, ["credential", "fill"], {
    env: gitEnv(binDir),
    input: `protocol=https\nhost=${host}\npath=acme/app.git\n\n`,
  });
}

describe("git credential relay session", () => {
  test("writes the helper dir and describes the container wiring", async () => {
    const dir = session.mount.source;
    expect(session.mount).toEqual({
      source: dir,
      target: CONTAINER_GIT_CREDENTIAL_DIR,
      readOnly: true,
    });
    expect(session.runArgs).toEqual([
      "--add-host",
      "host.docker.internal:host-gateway",
    ]);
    expect(session.containerEnv["GIT_CONFIG_VALUE_0"]).toBe(
      `${CONTAINER_GIT_CREDENTIAL_DIR}/${GIT_CREDENTIAL_HELPER_FILENAME}`,
    );
    const helper = await stat(path.join(dir, GIT_CREDENTIAL_HELPER_FILENAME));
    expect(helper.mode & 0o777).toBe(0o755);
    expect((await stat(path.join(dir, "token"))).mode & 0o777).toBe(0o644);
    expect(await Bun.file(path.join(dir, "endpoint")).text()).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\n$/,
    );
    expect((await Bun.file(path.join(dir, "token")).text()).trim()).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  test("stop closes the server, removes the dir and is idempotent", async () => {
    const dir = session.mount.source;
    await session.stop();
    await session.stop();
    expect(await Bun.file(path.join(dir, "token")).exists()).toBe(false);
  });

  for (const client of ["curl", "wget"]) {
    describe(`helper with only ${client} on PATH`, () => {
      const installed = Bun.which(client) !== null;

      test.skipIf(!installed)(
        "git credential fill gets the credential",
        async () => {
          const bin = await toolBin(client, [...BASE_TOOLS, client]);
          const result = await fill(bin, "github.com");
          expect(result.code).toBe(0);
          expect(result.stdout).toContain("username=x-access-token");
          expect(result.stdout).toContain(`password=${PASSWORD}`);
          expect(queries).toEqual([
            { protocol: "https", host: "github.com", path: "acme/app.git" },
          ]);
          expect(secrets).toEqual([PASSWORD]);
          expect(auditLines).toContain(
            "git credential get github.com/acme/app.git: issued (host)",
          );
          expect(auditLines.join("\n")).not.toContain(PASSWORD);
        },
      );

      test.skipIf(!installed)("a disallowed host gets nothing", async () => {
        const bin = await toolBin(client, [...BASE_TOOLS, client]);
        const result = await fill(bin, "gitlab.com");
        expect(result.code).not.toBe(0);
        expect(result.stdout).not.toContain(PASSWORD);
        expect(queries).toEqual([]);
        expect(auditLines).toContain(
          "git credential get gitlab.com/acme/app.git: denied [host] (host)",
        );
      });
    });
  }

  test("the helper explains when neither curl nor wget exists", async () => {
    const bin = await toolBin("none", BASE_TOOLS);
    const result = await run(
      "/bin/sh",
      [path.join(session.mount.source, GIT_CREDENTIAL_HELPER_FILENAME), "get"],
      {
        env: { PATH: bin },
        input: "protocol=https\nhost=github.com\n\n",
      },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(GIT_CREDENTIAL_HELPER_MISSING_TOOL_MESSAGE);
  });

  test("git push to an https remote fails on scarn-push-disabled", async () => {
    const bin = await toolBin("push", BASE_TOOLS);
    const repo = path.join(scratch, "repo");
    const env = gitEnv(bin);
    expect((await run(realGit, ["init", "-q", repo], { env })).code).toBe(0);
    expect(
      (
        await run(realGit, ["commit", "-q", "--allow-empty", "-m", "init"], {
          env,
          cwd: repo,
        })
      ).code,
    ).toBe(0);
    await run(realGit, ["remote", "add", "origin", REPO_URL], {
      env,
      cwd: repo,
    });
    const result = await run(realGit, ["push", "origin", "HEAD:main"], {
      env,
      cwd: repo,
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("scarn-push-disabled");
    expect(queries).toEqual([]);
  });
});
