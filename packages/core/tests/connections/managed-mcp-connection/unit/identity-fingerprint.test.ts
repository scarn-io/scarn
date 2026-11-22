import { describe, expect } from "bun:test";
import { identityFingerprint } from "@/connections/managed-mcp-connection/domain/identity-fingerprint";
import { concurrentTest } from "tests/utils";

const base = {
  issuer: "https://mcp.notion.com",
  workspaceId: "workspace-1",
  userId: "user-1",
  scopes: ["read", "write", "comment"],
};

describe("identityFingerprint", () => {
  concurrentTest("is the same whatever order the scopes come in", () => {
    expect(identityFingerprint(base)).toBe(
      identityFingerprint({ ...base, scopes: ["comment", "write", "read"] }),
    );
    expect(identityFingerprint(base)).toBe(
      identityFingerprint({
        ...base,
        scopes: ["write", "read", "comment", "read"],
      }),
    );
  });

  concurrentTest("changes with the issuer, workspace, user or scopes", () => {
    const fingerprint = identityFingerprint(base);
    for (const changed of [
      { ...base, issuer: "https://other.example" },
      { ...base, workspaceId: "workspace-2" },
      { ...base, userId: "user-2" },
      { ...base, userId: null },
      { ...base, scopes: ["read", "write"] },
    ]) {
      expect(identityFingerprint(changed)).not.toBe(fingerprint);
    }
  });

  concurrentTest("can't be forged by moving text between fields", () => {
    expect(
      identityFingerprint({ ...base, workspaceId: "a", userId: "bc" }),
    ).not.toBe(
      identityFingerprint({ ...base, workspaceId: "ab", userId: "c" }),
    );
  });
});
