import { describe, expect, test } from "bun:test";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import type { VerifiedCredential } from "@/components/integrations/token-credential-form";
import { issueTrackerInput } from "./issue-tracker-choice";

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
  test("sends the GitHub token's credential", () => {
    expect(
      issueTrackerInput({ type: "github_token", verified: saved }),
    ).toEqual({
      type: "github_token",
      credential: { secretId: SECRET_ID },
    });
  });

  test("sends a Jira choice's site, keys and credential", () => {
    expect(
      issueTrackerInput({
        type: "jira",
        baseUrl: "https://acme.atlassian.net",
        projectKeys: ["ABC"],
        verified: pasted,
      }),
    ).toEqual({
      type: "jira",
      baseUrl: "https://acme.atlassian.net",
      projectKeys: ["ABC"],
      credential: { token: "ghp_t" },
    });
  });
});
