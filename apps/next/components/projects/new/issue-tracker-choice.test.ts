import { describe, expect, test } from "bun:test";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import type { VerifiedCredential } from "@/components/integrations/token-credential-form";
import { autoSyncCandidate, issueTrackerInput } from "./issue-tracker-choice";

const SECRET_ID = parseUuidV7("0190a3b2-0000-7000-8000-000000000001");

const saved: VerifiedCredential = {
  credential: { secretId: SECRET_ID },
  connection: { method: "saved", name: "Team key" },
  account: "octocat",
  repo: { id: 7, fullName: "acme/api" },
};

const pasted: VerifiedCredential = {
  credential: { token: "ghp_t" },
  connection: { method: "unsaved" },
  account: "octocat",
  repo: { id: 7, fullName: "acme/api" },
};

describe("issueTrackerInput", () => {
  test("sends autoSync for a GitHub token or Jira choice that asked for it", () => {
    expect(
      issueTrackerInput({
        type: "github_token",
        verified: saved,
        autoSync: true,
      }),
    ).toEqual({
      type: "github_token",
      credential: { secretId: SECRET_ID },
      autoSync: true,
    });
    expect(
      issueTrackerInput({
        type: "jira",
        baseUrl: "https://acme.atlassian.net",
        projectKeys: ["ABC"],
        verified: saved,
        autoSync: true,
      }),
    ).toMatchObject({ type: "jira", autoSync: true });
  });

  test("leaves autoSync out when it wasn't asked for", () => {
    expect(
      issueTrackerInput({ type: "github_token", verified: saved }),
    ).not.toHaveProperty("autoSync");
  });
});

describe("autoSyncCandidate", () => {
  test("is the integration a saved key would be lent to", () => {
    expect(
      autoSyncCandidate({ type: "github_token", verified: saved }, "x/y"),
    ).toEqual({
      kind: "github_token",
      externalScope: { repos: [{ fullName: "acme/api" }] },
    });
  });

  test("is null for a pasted key, Bitbucket or the App", () => {
    expect(
      autoSyncCandidate({ type: "github_token", verified: pasted }, "x/y"),
    ).toBeNull();
    expect(
      autoSyncCandidate({ type: "bitbucket", verified: saved }, "x/y"),
    ).toBeNull();
    expect(
      autoSyncCandidate(
        { type: "github_app", installationId: "1", accountLogin: null },
        "x/y",
      ),
    ).toBeNull();
  });
});
