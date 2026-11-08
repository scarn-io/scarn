/**
 * Unit tests for {@link resolveGitCredentialRelayConfig}: source mode, extra
 * hosts and bind address from the worker env.
 */
import { describe, expect, test } from "bun:test";
import { ConfigurationError } from "../../../../src/lib/errors";
import {
  ApiGitCredentialSourceNotImplementedError,
  resolveGitCredentialRelayConfig,
} from "../../../../src/runtime/git-credentials/infra";

function configError(run: () => unknown): ConfigurationError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigurationError);
    return error as ConfigurationError;
  }
  throw new Error("expected a ConfigurationError");
}

describe("resolveGitCredentialRelayConfig", () => {
  test("defaults to on, the host source and no extra hosts", () => {
    expect(resolveGitCredentialRelayConfig({}, "linux")).toEqual({
      enabled: true,
      sourceMode: "host",
      extraHosts: [],
      bindAddress: "0.0.0.0",
    });
  });

  test("SCARN_GIT_CREDENTIALS is case-insensitive and blank means on", () => {
    for (const value of ["", "  ", "on", " ON "]) {
      expect(
        resolveGitCredentialRelayConfig({ SCARN_GIT_CREDENTIALS: value })
          .enabled,
      ).toBe(true);
    }
    expect(
      resolveGitCredentialRelayConfig({ SCARN_GIT_CREDENTIALS: " Off " })
        .enabled,
    ).toBe(false);
  });

  test("off skips validating the other settings", () => {
    expect(
      resolveGitCredentialRelayConfig({
        SCARN_GIT_CREDENTIALS: "off",
        SCARN_GIT_CREDENTIAL_SOURCE: "vault",
        SCARN_GIT_CREDENTIAL_HOSTS: "https://bad",
      }).enabled,
    ).toBe(false);
  });

  test("an unknown SCARN_GIT_CREDENTIALS is GIT_CREDENTIALS_INVALID", () => {
    const error = configError(() =>
      resolveGitCredentialRelayConfig({ SCARN_GIT_CREDENTIALS: "read" }),
    );
    expect(error.code).toBe("GIT_CREDENTIALS_INVALID");
  });

  test("binds loopback on macOS and Windows, all interfaces on Linux", () => {
    expect(resolveGitCredentialRelayConfig({}, "darwin").bindAddress).toBe(
      "127.0.0.1",
    );
    expect(resolveGitCredentialRelayConfig({}, "win32").bindAddress).toBe(
      "127.0.0.1",
    );
    expect(resolveGitCredentialRelayConfig({}, "linux").bindAddress).toBe(
      "0.0.0.0",
    );
  });

  test("SCARN_GIT_CREDENTIAL_RELAY_BIND overrides the default", () => {
    expect(
      resolveGitCredentialRelayConfig(
        { SCARN_GIT_CREDENTIAL_RELAY_BIND: " 172.17.0.1 " },
        "linux",
      ).bindAddress,
    ).toBe("172.17.0.1");
    expect(
      resolveGitCredentialRelayConfig(
        { SCARN_GIT_CREDENTIAL_RELAY_BIND: "   " },
        "darwin",
      ).bindAddress,
    ).toBe("127.0.0.1");
  });

  test("source is case-insensitive and blank means host", () => {
    for (const value of ["", "  ", "host", " HOST "]) {
      expect(
        resolveGitCredentialRelayConfig({ SCARN_GIT_CREDENTIAL_SOURCE: value })
          .sourceMode,
      ).toBe("host");
    }
  });

  test("api is a declared seam that is not implemented yet", () => {
    expect(() =>
      resolveGitCredentialRelayConfig({ SCARN_GIT_CREDENTIAL_SOURCE: "api" }),
    ).toThrow(ApiGitCredentialSourceNotImplementedError);
  });

  test("an unknown source is GIT_CREDENTIAL_SOURCE_INVALID", () => {
    const error = configError(() =>
      resolveGitCredentialRelayConfig({ SCARN_GIT_CREDENTIAL_SOURCE: "vault" }),
    );
    expect(error.code).toBe("GIT_CREDENTIAL_SOURCE_INVALID");
  });

  test("extra hosts are trimmed, lowercased, deduplicated; blanks skipped", () => {
    expect(
      resolveGitCredentialRelayConfig({
        SCARN_GIT_CREDENTIAL_HOSTS:
          " GitLab.example.com, ,pkgs.example:9000,gitlab.example.com,[::1]:8443,",
      }).extraHosts,
    ).toEqual(["gitlab.example.com", "pkgs.example:9000", "[::1]:8443"]);
  });

  test("an entry that is not host[:port] is GIT_CREDENTIAL_HOSTS_INVALID", () => {
    for (const value of [
      "https://github.com",
      "github.com/acme",
      "user@github.com",
      "git hub.com",
      "github.com:",
      "*.github.com",
    ]) {
      const error = configError(() =>
        resolveGitCredentialRelayConfig({ SCARN_GIT_CREDENTIAL_HOSTS: value }),
      );
      expect(error.code).toBe("GIT_CREDENTIAL_HOSTS_INVALID");
    }
  });
});
