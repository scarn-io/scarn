"use client";

import {
  Button,
  Card,
  CardContent,
  Chip,
  IconButton,
  Stack,
  Typography,
} from "@mui/material";
import DeleteIcon from "@mui/icons-material/Delete";
import GitHubIcon from "@mui/icons-material/GitHub";
import SourceOutlinedIcon from "@mui/icons-material/SourceOutlined";
import SyncIcon from "@mui/icons-material/Sync";
import type { CredentialPlatform } from "@/components/integrations/credential-platforms";
import type { ImportSchedule } from "@/components/integrations/import-schedules";
import { IntegrationImportSchedule } from "@/components/integrations/integration-import-schedule";

type RepoRef = { id: number; fullName: string };
type GitHubScope = { repos: RepoRef[] };
type BitbucketScope = {
  repos: Array<{ workspace: string; slug: string; fullName: string }>;
};
type JiraScope = { baseUrl: string; projectKeys: string[] };

type ProjectIntegrationViewBase = {
  id: string;
  projectId: string;
  status: "active" | "paused" | "error";
  lastSyncedAt: string | null;
  lastError: string | null;
  createdAt: string;
};

export type ProjectIntegrationView =
  | (ProjectIntegrationViewBase & {
      kind: "github_app";
      installationId: string;
      externalScope: GitHubScope;
    })
  | (ProjectIntegrationViewBase & {
      kind: "github_token";
      externalScope: GitHubScope;
    })
  | (ProjectIntegrationViewBase & {
      kind: "bitbucket";
      externalScope: BitbucketScope;
    })
  | (ProjectIntegrationViewBase & {
      kind: "jira";
      externalScope: JiraScope;
    });

/**
 * The platform whose credential a sync needs, or null when the integration
 * authenticates on its own (the GitHub App).
 */
export const credentialPlatformFor = (
  integration: ProjectIntegrationView,
): CredentialPlatform | null => {
  switch (integration.kind) {
    case "github_app":
      return null;
    case "github_token":
      return "github";
    case "bitbucket":
      return "bitbucket";
    case "jira":
      return "jira";
  }
};

function scopeChips(labels: Array<{ key: string | number; label: string }>) {
  return labels.map(({ key, label }) => (
    <Chip key={key} size="small" variant="outlined" label={label} />
  ));
}

const repoChips = (scope: GitHubScope | BitbucketScope) =>
  scopeChips(
    scope.repos.map((repo) => ({ key: repo.fullName, label: repo.fullName })),
  );

function integrationSummary(integration: ProjectIntegrationView) {
  switch (integration.kind) {
    case "github_app":
      return {
        title: `GitHub installation ${integration.installationId}`,
        subtitle: null,
        method: "Connected through GitHub App",
        chips: repoChips(integration.externalScope),
      };
    case "github_token":
      return {
        title: "GitHub",
        subtitle: null,
        method: "Connected with your token",
        chips: repoChips(integration.externalScope),
      };
    case "bitbucket":
      return {
        title: "Bitbucket",
        subtitle: null,
        method: "Connected with your token",
        chips: repoChips(integration.externalScope),
      };
    case "jira":
      return {
        title: `Jira — ${integration.externalScope.baseUrl}`,
        subtitle: integration.externalScope.baseUrl,
        method: "Connected with your token",
        chips: scopeChips(
          integration.externalScope.projectKeys.map((key) => ({
            key,
            label: key,
          })),
        ),
      };
  }
}

const statusColor = (status: ProjectIntegrationView["status"]) =>
  status === "active" ? "success" : status === "error" ? "error" : "default";

export function ProjectIntegrationCard({
  integration,
  isSyncing,
  disabled,
  importSchedules,
  onSync,
  onRemove,
}: {
  integration: ProjectIntegrationView;
  isSyncing: boolean;
  disabled: boolean;
  /** The schedule rules importing this integration's issues. */
  importSchedules: readonly ImportSchedule[];
  onSync: () => void;
  onRemove: () => void;
}) {
  const summary = integrationSummary(integration);
  return (
    <Card variant="outlined">
      <CardContent>
        <Stack
          direction={{ xs: "column", md: "row" }}
          spacing={2}
          justifyContent="space-between"
          alignItems={{ md: "center" }}
        >
          <Stack spacing={0.75}>
            <Stack direction="row" spacing={1} alignItems="center">
              {integration.kind === "github_app" ||
              integration.kind === "github_token" ? (
                <GitHubIcon fontSize="small" />
              ) : integration.kind === "bitbucket" ? (
                <SourceOutlinedIcon fontSize="small" />
              ) : null}
              <Typography variant="subtitle1">{summary.title}</Typography>
              <Chip
                size="small"
                color={statusColor(integration.status)}
                label={integration.status}
              />
            </Stack>
            {summary.subtitle ? (
              <Typography variant="caption" color="text.secondary">
                {summary.subtitle}
              </Typography>
            ) : null}
            <Typography variant="caption" color="text.secondary">
              {summary.method}
            </Typography>
            <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
              {summary.chips}
            </Stack>
            <Typography variant="caption" color="text.secondary">
              {integration.lastSyncedAt
                ? `Last synced ${new Date(integration.lastSyncedAt).toLocaleString()}`
                : "Never synced"}
            </Typography>
            {integration.lastError ? (
              <Typography variant="caption" color="error">
                {integration.lastError.length > 300
                  ? `${integration.lastError.slice(0, 300)}…`
                  : integration.lastError}
              </Typography>
            ) : null}
            {integration.kind === "jira" ||
            integration.kind === "github_token" ? (
              <IntegrationImportSchedule
                integration={integration}
                schedules={importSchedules}
              />
            ) : null}
          </Stack>
          <Stack direction="row" spacing={1} alignItems="center">
            <Button
              variant="outlined"
              startIcon={<SyncIcon />}
              onClick={onSync}
              loading={isSyncing}
              disabled={disabled && !isSyncing}
            >
              Sync now
            </Button>
            <IconButton
              aria-label="Remove integration"
              color="error"
              onClick={onRemove}
              disabled={disabled}
            >
              <DeleteIcon />
            </IconButton>
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  );
}
