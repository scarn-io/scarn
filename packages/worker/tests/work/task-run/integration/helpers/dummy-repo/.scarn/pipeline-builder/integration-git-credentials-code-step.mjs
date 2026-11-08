import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function git(args, options = {}) {
  const result = spawnSync("git", args, { encoding: "utf8", ...options });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function credentialFill(authority) {
  const result = git(["credential", "fill"], {
    input: `protocol=https\nhost=${authority}\npath=acme/private.git\n\n`,
  });
  const fields = Object.fromEntries(
    result.stdout
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [
        line.slice(0, line.indexOf("=")),
        line.slice(line.indexOf("=") + 1),
      ]),
  );
  return {
    status: result.status,
    username: fields.username ?? null,
    passwordSha256:
      fields.password === undefined
        ? null
        : createHash("sha256").update(fields.password).digest("hex"),
  };
}

function pushProbe(authority) {
  const repo = mkdtempSync(path.join(tmpdir(), "scarn-push-probe-"));
  git(["init", "-q", repo]);
  git([
    "-C",
    repo,
    "-c",
    "user.name=Scarn Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "probe",
  ]);
  const result = git([
    "-C",
    repo,
    "push",
    `https://${authority}/acme/private.git`,
    "HEAD:refs/heads/main",
  ]);
  return { status: result.status, stderr: result.stderr };
}

function readPostCreateRecord() {
  const recordUrl = new URL(
    "../tmp/git-credentials-post-create.txt",
    import.meta.url,
  );
  return existsSync(recordUrl) ? readFileSync(recordUrl, "utf8") : null;
}

function integrationGitCredentialsCodeStep(input) {
  return {
    summary: "probed git credentials",
    postCreate: readPostCreateRecord(),
    fill: credentialFill(input.authority),
    push: pushProbe(input.authority),
  };
}

export const gitCredentialsStep = {
  key: "integration-step",
  name: "Integration Step",
  version: 1,
  kind: "code",
  entrypoint: { fn: integrationGitCredentialsCodeStep },
};
