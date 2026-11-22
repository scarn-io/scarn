import type { ProjectIntegrationAutoSyncContract } from "@scarn/core/integrations/project-integration/contracts/project-integration-contracts";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import type { SecretContract } from "@scarn/core/secrets/secret/contracts/secret-contracts";
import type { AutoSyncSectionIntegration } from "./integration-auto-sync-section";

export const PROJECT_ID = "0198f2c4-0000-7000-8000-0000000000a0";
export const JIRA_KEY_ID = "0198f2c4-0000-7000-8000-000000000001";
export const GITHUB_KEY_ID = "0198f2c4-0000-7000-8000-000000000002";

export const autoSyncOff: ProjectIntegrationAutoSyncContract = {
  supported: true,
  state: "off",
  syncsAs: null,
  pausedReason: null,
  pausedDetail: null,
  pausedAt: null,
};

export const autoSyncOn: ProjectIntegrationAutoSyncContract = {
  ...autoSyncOff,
  state: "on",
  syncsAs: {
    userId: parseUuidV7("0198f2c4-0000-7000-8000-0000000000b0"),
    displayName: "Alice",
    secretName: "Work key",
  },
};

export const autoSyncPaused = (
  pausedReason: NonNullable<ProjectIntegrationAutoSyncContract["pausedReason"]>,
  pausedDetail: string | null = null,
): ProjectIntegrationAutoSyncContract => ({
  ...autoSyncOff,
  state: "paused",
  pausedReason,
  pausedDetail,
  pausedAt: "2026-11-01T00:00:00.000Z",
});

export const jiraIntegration = (
  autoSync: ProjectIntegrationAutoSyncContract = autoSyncOff,
): AutoSyncSectionIntegration => ({
  id: "0198f2c4-0000-7000-8000-0000000000c1",
  kind: "jira",
  externalScope: { projectKeys: ["ACME", "WEB"] },
  lastSyncedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
  autoSync,
});

export const githubIntegration = (
  autoSync: ProjectIntegrationAutoSyncContract = autoSyncOff,
): AutoSyncSectionIntegration => ({
  id: "0198f2c4-0000-7000-8000-0000000000c2",
  kind: "github_token",
  externalScope: {
    repos: [{ fullName: "acme/api" }, { fullName: "acme/web" }],
  },
  lastSyncedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
  autoSync,
});

const keyBase = {
  lastFour: "ab12",
  expiresAt: null,
  lastUsedAt: null,
  status: "active",
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
  usedBy: [],
};

export const savedKeys = [
  {
    ...keyBase,
    id: JIRA_KEY_ID,
    kind: "jira_api_key",
    name: "Work Jira",
    metadata: { email: "alice@acme.test" },
  },
  {
    ...keyBase,
    id: GITHUB_KEY_ID,
    kind: "github_token",
    name: "Work GitHub",
    metadata: { login: "alice" },
  },
  {
    ...keyBase,
    id: "0198f2c4-0000-7000-8000-000000000003",
    kind: "bitbucket_api_token",
    name: "Work Bitbucket",
    metadata: { email: "alice@acme.test" },
  },
] as unknown as SecretContract[];
