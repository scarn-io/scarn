/**
 * Unit tests for the git credential-helper wire format: parsing requests and
 * answers, and serializing credentials and `quit=1`.
 */
import { describe, expect, test } from "bun:test";
import {
  GitCredentialProtocolError,
  parseGitCredential,
  parseGitCredentialQuery,
  serializeGitCredential,
  serializeGitCredentialQuery,
  serializeQuit,
} from "../../../../src/runtime/git-credentials/domain/git-credential-protocol";

describe("parseGitCredentialQuery", () => {
  test("stops at a blank line", () => {
    const body =
      "protocol=https\nhost=github.com\npath=acme/app.git\n\nhost=evil.example\n";
    expect(parseGitCredentialQuery(body)).toEqual({
      protocol: "https",
      host: "github.com",
      path: "acme/app.git",
    });
  });

  test("accepts EOF without a trailing blank line or newline", () => {
    expect(parseGitCredentialQuery("protocol=https\nhost=github.com")).toEqual({
      protocol: "https",
      host: "github.com",
      path: null,
    });
  });

  test("ignores unknown keys and drops multi-valued keys", () => {
    const body = [
      "capability[]=authtype",
      "capability[]=state",
      "protocol=https",
      "host=gitlab.example:8443",
      'wwwauth[]=Basic realm="x"',
      "something=else",
      "",
    ].join("\n");
    expect(parseGitCredentialQuery(body)).toEqual({
      protocol: "https",
      host: "gitlab.example:8443",
      path: null,
    });
  });

  test("keeps everything after the first '=' as the value", () => {
    expect(
      parseGitCredentialQuery("protocol=https\nhost=h\npath=a=b\n").path,
    ).toBe("a=b");
  });

  test("tolerates CRLF line endings", () => {
    expect(
      parseGitCredentialQuery("protocol=https\r\nhost=github.com\r\n\r\n"),
    ).toEqual({ protocol: "https", host: "github.com", path: null });
  });

  test("a request without protocol or host is a protocol error", () => {
    expect(() => parseGitCredentialQuery("host=github.com\n")).toThrow(
      GitCredentialProtocolError,
    );
    expect(() => parseGitCredentialQuery("protocol=https\n")).toThrow(
      GitCredentialProtocolError,
    );
    expect(() => parseGitCredentialQuery("")).toThrow(
      GitCredentialProtocolError,
    );
  });

  test("a line without '=' is a protocol error that does not quote it", () => {
    let caught: Error | null = null;
    try {
      parseGitCredentialQuery("protocol=https\nhunter2\n");
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeInstanceOf(GitCredentialProtocolError);
    expect(caught?.message).not.toContain("hunter2");
  });

  test("round-trips through serializeGitCredentialQuery", () => {
    const query = { protocol: "https", host: "github.com", path: "a/b.git" };
    expect(parseGitCredentialQuery(serializeGitCredentialQuery(query))).toEqual(
      query,
    );
    expect(serializeGitCredentialQuery({ ...query, path: null })).toBe(
      "protocol=https\nhost=github.com\n",
    );
  });
});

describe("serializeGitCredential / parseGitCredential", () => {
  test("writes username and password without an expiry", () => {
    expect(
      serializeGitCredential({
        username: "x-access-token",
        password: "s3cret",
        expiresAt: null,
      }),
    ).toBe("username=x-access-token\npassword=s3cret\n");
  });

  test("writes password_expiry_utc in epoch seconds and round-trips it", () => {
    const expiresAt = new Date("2026-11-06T12:00:00Z");
    const body = serializeGitCredential({
      username: "u",
      password: "p",
      expiresAt,
    });
    expect(body).toBe(
      `username=u\npassword=p\npassword_expiry_utc=${String(expiresAt.getTime() / 1000)}\n`,
    );
    expect(parseGitCredential(body)).toEqual({
      username: "u",
      password: "p",
      expiresAt,
    });
  });

  test("parses git credential fill output and ignores its other keys", () => {
    expect(
      parseGitCredential(
        "protocol=https\nhost=github.com\nusername=octo\npassword=tok\n",
      ),
    ).toEqual({ username: "octo", password: "tok", expiresAt: null });
  });

  test("an answer without a password is null", () => {
    expect(parseGitCredential("username=octo\n")).toBeNull();
    expect(parseGitCredential("")).toBeNull();
  });

  test("refuses a value with a newline", () => {
    expect(() =>
      serializeGitCredential({
        username: "u",
        password: "p\nhost=evil",
        expiresAt: null,
      }),
    ).toThrow(GitCredentialProtocolError);
  });

  test("serializeQuit writes quit=1", () => {
    expect(serializeQuit()).toBe("quit=1\n");
  });
});
