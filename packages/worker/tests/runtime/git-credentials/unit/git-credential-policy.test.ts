/**
 * Unit tests for {@link GitCredentialPolicy}: HTTPS only, and only the repo's
 * host plus configured extra hosts, with exact port matching.
 */
import { describe, expect, test } from "bun:test";
import { GitCredentialPolicy } from "../../../../src/runtime/git-credentials/domain/git-credential-policy";

const query = (host: string, protocol = "https") => ({
  protocol,
  host,
  path: "acme/app.git",
});

describe("GitCredentialPolicy", () => {
  const policy = GitCredentialPolicy.forRepo({
    repoGitUrl: "https://github.com/acme/app.git",
    extraHosts: [],
  });

  test("allows HTTPS to the repo host", () => {
    expect(policy.allowedHosts).toEqual(["github.com"]);
    expect(policy.evaluate(query("github.com"))).toEqual({ allowed: true });
  });

  test("compares host and protocol case-insensitively", () => {
    expect(policy.evaluate(query("GitHub.COM", "HTTPS"))).toEqual({
      allowed: true,
    });
  });

  test("refuses plain http", () => {
    expect(policy.evaluate(query("github.com", "http"))).toEqual({
      allowed: false,
      reason: "protocol",
    });
  });

  test("refuses another host", () => {
    expect(policy.evaluate(query("gitlab.com"))).toEqual({
      allowed: false,
      reason: "host",
    });
    expect(policy.evaluate(query("evil.github.com"))).toEqual({
      allowed: false,
      reason: "host",
    });
  });

  test("an SCP-style repo URL allows its host over HTTPS", () => {
    const scp = GitCredentialPolicy.forRepo({
      repoGitUrl: "git@GitHub.com:acme/app.git",
      extraHosts: [],
    });
    expect(scp.allowedHosts).toEqual(["github.com"]);
    expect(scp.evaluate(query("github.com"))).toEqual({ allowed: true });
  });

  test("an ssh:// repo URL drops its SSH port for the HTTPS host", () => {
    const ssh = GitCredentialPolicy.forRepo({
      repoGitUrl: "ssh://git@git.example.com:2222/acme/app.git",
      extraHosts: [],
    });
    expect(ssh.allowedHosts).toEqual(["git.example.com"]);
    expect(ssh.evaluate(query("git.example.com"))).toEqual({ allowed: true });
    expect(ssh.evaluate(query("git.example.com:2222"))).toEqual({
      allowed: false,
      reason: "host",
    });
  });

  test("an HTTPS repo port must match exactly", () => {
    const ported = GitCredentialPolicy.forRepo({
      repoGitUrl: "https://git.example.com:8443/acme/app.git",
      extraHosts: [],
    });
    expect(ported.evaluate(query("git.example.com:8443"))).toEqual({
      allowed: true,
    });
    expect(ported.evaluate(query("git.example.com"))).toEqual({
      allowed: false,
      reason: "host",
    });
    expect(ported.evaluate(query("git.example.com:443"))).toEqual({
      allowed: false,
      reason: "host",
    });
  });

  test("extra hosts are allowed, lowercased and deduplicated", () => {
    const extra = GitCredentialPolicy.forRepo({
      repoGitUrl: "https://github.com/acme/app.git",
      extraHosts: [
        "GitLab.example.com",
        "github.com",
        " ",
        "pkgs.example:9000",
      ],
    });
    expect(extra.allowedHosts).toEqual([
      "github.com",
      "gitlab.example.com",
      "pkgs.example:9000",
    ]);
    expect(extra.evaluate(query("gitlab.example.com"))).toEqual({
      allowed: true,
    });
    expect(extra.evaluate(query("pkgs.example:9000"))).toEqual({
      allowed: true,
    });
    expect(extra.evaluate(query("pkgs.example"))).toEqual({
      allowed: false,
      reason: "host",
    });
  });

  test("an unparseable or local repo URL contributes no host", () => {
    for (const repoGitUrl of ["not a url", "/srv/repos/app.git", "../app"]) {
      const local = GitCredentialPolicy.forRepo({ repoGitUrl, extraHosts: [] });
      expect(local.allowedHosts).toEqual([]);
      expect(local.evaluate(query("github.com"))).toEqual({
        allowed: false,
        reason: "host",
      });
    }
  });
});
