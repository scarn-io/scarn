import type { GitHost } from "@scarn/sdk/git-url";
import type { IssueTrackerInput } from "@scarn/core/projects/project/contracts/project-setup-contracts";
import type { AutoSyncIntegration } from "@/components/integrations/auto-sync-text";
import type { VerifiedCredential } from "@/components/integrations/token-credential-form";

/**
 * The issue-tracking options a repo's host allows, in display order. The
 * GitHub App comes first (and is recommended) when the server has it
 * configured.
 */
export type IssueTrackerOption =
  "github_app" | "github_token" | "bitbucket" | "jira";

export function issueTrackerOptions(
  host: GitHost["host"],
  githubAppConfigured: boolean,
): IssueTrackerOption[] {
  switch (host) {
    case "github":
      return githubAppConfigured
        ? ["github_app", "github_token", "jira"]
        : ["github_token", "jira"];
    case "bitbucket":
      return ["bitbucket", "jira"];
    case "other":
      return ["jira"];
  }
}

/** A checked, ready-to-create issue tracker. Credentials stay in memory only. */
export type IssueTrackerChoice =
  | { type: "github_app"; installationId: string; accountLogin: string | null }
  | { type: "github_token"; verified: VerifiedCredential; autoSync?: boolean }
  | { type: "bitbucket"; verified: VerifiedCredential }
  | {
      type: "jira";
      baseUrl: string;
      projectKeys: string[];
      verified: VerifiedCredential;
      autoSync?: boolean;
    };

const autoSyncField = (autoSync: boolean | undefined) =>
  autoSync ? { autoSync: true } : {};

export function issueTrackerInput(
  choice: IssueTrackerChoice,
): IssueTrackerInput {
  switch (choice.type) {
    case "github_app":
      return { type: "github_app", installationId: choice.installationId };
    case "github_token":
      return {
        type: "github_token",
        credential: choice.verified.credential,
        ...autoSyncField(choice.autoSync),
      };
    case "bitbucket":
      return { type: "bitbucket", credential: choice.verified.credential };
    case "jira":
      return {
        type: "jira",
        baseUrl: choice.baseUrl,
        projectKeys: choice.projectKeys,
        credential: choice.verified.credential,
        ...autoSyncField(choice.autoSync),
      };
  }
}

/**
 * The integration a saved Jira key or GitHub token would be lent to, for the
 * "Auto-sync with this key" consent. Null for the App, Bitbucket and pasted
 * keys, which can't be lent.
 */
export function autoSyncCandidate(
  choice: IssueTrackerChoice | null,
  repoName: string,
): AutoSyncIntegration | null {
  if (!choice || choice.type === "github_app" || choice.type === "bitbucket") {
    return null;
  }
  if (choice.verified.connection.method !== "saved") return null;
  if (choice.type === "jira") {
    return { kind: "jira", externalScope: { projectKeys: choice.projectKeys } };
  }
  return {
    kind: "github_token",
    externalScope: {
      repos: [{ fullName: choice.verified.repo?.fullName ?? repoName }],
    },
  };
}

export const usesUnsavedToken = (choice: IssueTrackerChoice | null): boolean =>
  choice !== null &&
  choice.type !== "github_app" &&
  choice.verified.connection.method === "unsaved";

/**
 * "via GitHub App", "via your token (saved as 'GitHub token')" or "via your
 * token (not saved)".
 */
export function connectionSummary(choice: IssueTrackerChoice): string {
  if (choice.type === "github_app") {
    return "via GitHub App";
  }
  const { connection } = choice.verified;
  return connection.method === "saved"
    ? `via your token (saved as '${connection.name}')`
    : "via your token (not saved)";
}
