/**
 * Integration tests for {@link HostGitCredentialSource} against a real `git`
 * with an isolated temp `HOME` that uses the `store` credential helper.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HostGitCredentialSource } from "../../../../src/runtime/git-credentials/infra";

const PASSWORD = "ghp_hostStoreSecret0123456789";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "scarn-git-cred-home-"));
  await writeFile(
    path.join(home, ".git-credentials"),
    `https://octo:${PASSWORD}@github.com\nhttps://ci:portSecret@git.example.com:8443\n`,
    { mode: 0o600 },
  );
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function writeGitconfig(helper: string): Promise<void> {
  await writeFile(
    path.join(home, ".gitconfig"),
    `[credential]\n\thelper = ${helper}\n`,
  );
}

function isolatedEnv(): NodeJS.ProcessEnv {
  return {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
    PATH: process.env["PATH"],
  };
}

describe("HostGitCredentialSource", () => {
  test("returns the stored credential for a matching host", async () => {
    await writeGitconfig("store");
    const source = new HostGitCredentialSource({ env: isolatedEnv() });
    expect(source.mode).toBe("host");
    expect(
      await source.get({
        protocol: "https",
        host: "github.com",
        path: "acme/app.git",
      }),
    ).toEqual({ username: "octo", password: PASSWORD, expiresAt: null });
  });

  test("matches a host with a port", async () => {
    await writeGitconfig("store");
    const source = new HostGitCredentialSource({ env: isolatedEnv() });
    expect(
      await source.get({
        protocol: "https",
        host: "git.example.com:8443",
        path: null,
      }),
    ).toEqual({ username: "ci", password: "portSecret", expiresAt: null });
  });

  test("returns null without prompting when the host has no credential", async () => {
    await writeGitconfig("store");
    const source = new HostGitCredentialSource({ env: isolatedEnv() });
    expect(
      await source.get({ protocol: "https", host: "gitlab.com", path: null }),
    ).toBeNull();
  });

  test("rejects with a timeout and no credential material", async () => {
    const helper = path.join(home, "slow-helper.sh");
    await writeFile(helper, "#!/bin/sh\nsleep 5\n", { mode: 0o755 });
    await writeGitconfig(`!${helper}`);
    const source = new HostGitCredentialSource({
      env: isolatedEnv(),
      timeoutMs: 200,
    });
    const started = Date.now();
    let caught: Error | null = null;
    try {
      await source.get({ protocol: "https", host: "github.com", path: null });
    } catch (error) {
      caught = error as Error;
    }
    expect(caught?.message).toContain("timed out after 200ms");
    expect(caught?.message).not.toContain(PASSWORD);
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});
