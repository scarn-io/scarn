"use client";

import { useState, useTransition } from "react";
import {
  Alert,
  Button,
  Card,
  CardContent,
  Stack,
  Typography,
} from "@mui/material";
import GitHubIcon from "@mui/icons-material/GitHub";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import { useRouter } from "next/navigation";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { parseApiError } from "@/app/_lib/api-error";
import type { IntegrationCredentialChoice } from "@scarn/core/secrets/secret/contracts/secret-contracts";
import { IntegrationCredentialDialog } from "@/components/integrations/integration-credential-dialog";
import { CREDENTIAL_PLATFORMS } from "@/components/integrations/credential-platforms";
import { parseJiraProjectKeys } from "@/components/integrations/jira-site-fields";
import { useHasProjectPermission } from "@/components/project-route-context";
import { githubInstallHref } from "@/app/_lib/scarn-api-url";
import {
  ConnectBitbucketDialog,
  ConnectGitHubTokenDialog,
  ConnectJiraDialog,
} from "./project-integrations-panel-dialogs";
import {
  ProjectIntegrationCard,
  credentialPlatformFor,
  type ProjectIntegrationView,
} from "./project-integration-card";

export type { ProjectIntegrationView } from "./project-integration-card";

export type FlashMessage = {
  severity: "success" | "info" | "warning" | "error";
  text: string;
};

export function ProjectIntegrationsPanel({
  projectId,
  projectGitUrl,
  initialIntegrations,
  githubAppConfigured,
  flashMessage,
}: {
  projectId: string;
  projectGitUrl: string;
  initialIntegrations: ProjectIntegrationView[];
  githubAppConfigured: boolean;
  flashMessage: FlashMessage | null;
}) {
  const router = useRouter();
  const canManage = useHasProjectPermission("integrations:write");
  const [integrations, setIntegrations] = useState(initialIntegrations);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [syncSummary, setSyncSummary] = useState<string | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const [jiraConnectOpen, setJiraConnectOpen] = useState(false);
  const [jiraBaseUrl, setJiraBaseUrl] = useState("");
  const [jiraProjectKeysRaw, setJiraProjectKeysRaw] = useState("");
  const [jiraConnecting, setJiraConnecting] = useState(false);
  const [githubTokenConnectOpen, setGitHubTokenConnectOpen] = useState(false);
  const [bitbucketConnectOpen, setBitbucketConnectOpen] = useState(false);

  const [credentialDialogFor, setCredentialDialogFor] =
    useState<ProjectIntegrationView | null>(null);
  const credentialPlatform = credentialDialogFor
    ? credentialPlatformFor(credentialDialogFor)
    : null;

  const handleIntegrationChange = (updated: ProjectIntegrationView) => {
    setIntegrations((current) =>
      current.map((entry) => (entry.id === updated.id ? updated : entry)),
    );
  };

  const handleRemove = (integrationId: string) => {
    setErrorMessage(null);
    startTransition(async () => {
      const client = getBrowserScarnApiClient();
      const { error } = await client.api
        .projects({ projectId })
        .integrations({ integrationId })
        .delete();
      if (error) {
        setErrorMessage(
          parseApiError(error, "Could not remove the integration."),
        );
        return;
      }
      setIntegrations((current) =>
        current.filter((entry) => entry.id !== integrationId),
      );
    });
  };

  const handleSync = (
    integrationId: string,
    credential?: IntegrationCredentialChoice,
  ) => {
    setErrorMessage(null);
    setSyncSummary(null);
    setSyncingId(integrationId);
    startTransition(async () => {
      const client = getBrowserScarnApiClient();
      const { data, error } = await client.api
        .projects({ projectId })
        .integrations({ integrationId })
        .sync.post(credential);
      setSyncingId(null);
      if (error) {
        setErrorMessage(
          parseApiError(
            error,
            "Sync failed. Check the integration card for details.",
          ),
        );
        router.refresh();
        return;
      }
      setSyncSummary(
        `Synced ${String(data.totalUpserted)} work item${data.totalUpserted === 1 ? "" : "s"}.`,
      );
      router.refresh();
    });
  };

  const handleSyncClick = (integration: ProjectIntegrationView) => {
    if (credentialPlatformFor(integration) === null) {
      handleSync(integration.id);
    } else {
      setCredentialDialogFor(integration);
    }
  };

  const handleCredentialConfirm = (choice: IntegrationCredentialChoice) => {
    if (!credentialDialogFor) return;
    const integrationId = credentialDialogFor.id;
    setCredentialDialogFor(null);
    handleSync(integrationId, choice);
  };

  const handleJiraConnect = () => {
    setErrorMessage(null);
    setJiraConnecting(true);
    startTransition(async () => {
      const client = getBrowserScarnApiClient();
      const { data, error } = await client.api
        .projects({ projectId })
        .integrations.post({
          kind: "jira",
          externalScope: {
            baseUrl: jiraBaseUrl.trim(),
            projectKeys: parseJiraProjectKeys(jiraProjectKeysRaw),
          },
        });
      setJiraConnecting(false);
      if (error) {
        setErrorMessage(
          parseApiError(
            error,
            "Could not connect Jira. Check the URL and project keys.",
          ),
        );
        return;
      }
      setJiraConnectOpen(false);
      setJiraBaseUrl("");
      setJiraProjectKeysRaw("");
      setIntegrations((current) => [...current, data]);
    });
  };

  const connectHref = githubInstallHref({ projectId });

  return (
    <Stack spacing={2}>
      {flashMessage ? (
        <Alert severity={flashMessage.severity}>{flashMessage.text}</Alert>
      ) : null}
      {errorMessage ? <Alert severity="error">{errorMessage}</Alert> : null}
      {syncSummary ? <Alert severity="success">{syncSummary}</Alert> : null}

      <Stack
        direction="row"
        spacing={1}
        justifyContent="flex-end"
        flexWrap="wrap"
        useFlexGap
      >
        {githubAppConfigured ? (
          <Button
            variant="outlined"
            startIcon={<GitHubIcon />}
            endIcon={<OpenInNewIcon />}
            href={connectHref}
          >
            Connect GitHub
          </Button>
        ) : null}
        <Button
          variant="outlined"
          startIcon={<GitHubIcon />}
          onClick={() => {
            setGitHubTokenConnectOpen(true);
          }}
        >
          Connect GitHub with a token
        </Button>
        <Button
          variant="outlined"
          onClick={() => {
            setBitbucketConnectOpen(true);
          }}
        >
          Connect Bitbucket
        </Button>
        <Button
          variant="contained"
          onClick={() => {
            setJiraConnectOpen(true);
          }}
        >
          Connect Jira
        </Button>
      </Stack>

      {!githubAppConfigured ? (
        <Alert severity="info">
          GitHub App is not configured. Set <code>GITHUB_APP_ID</code>,{" "}
          <code>GITHUB_APP_SLUG</code>, and <code>GITHUB_APP_PRIVATE_KEY</code>{" "}
          in your environment to connect GitHub through the App. You can still
          connect GitHub with a token.
        </Alert>
      ) : null}

      {integrations.length === 0 ? (
        <Card variant="outlined">
          <CardContent>
            <Typography variant="body2">
              No integrations yet. Connect GitHub, Bitbucket or Jira to start
              ingesting issues.
            </Typography>
          </CardContent>
        </Card>
      ) : (
        <Stack spacing={1.5}>
          {integrations.map((integration) => (
            <ProjectIntegrationCard
              key={integration.id}
              integration={integration}
              isSyncing={syncingId === integration.id}
              disabled={isPending}
              canManage={canManage}
              githubAppConfigured={githubAppConfigured}
              onSync={() => {
                handleSyncClick(integration);
              }}
              onRemove={() => {
                handleRemove(integration.id);
              }}
              onIntegrationChange={handleIntegrationChange}
            />
          ))}
        </Stack>
      )}

      <ConnectJiraDialog
        open={jiraConnectOpen}
        jiraBaseUrl={jiraBaseUrl}
        jiraProjectKeysRaw={jiraProjectKeysRaw}
        jiraConnecting={jiraConnecting}
        onClose={() => {
          setJiraConnectOpen(false);
        }}
        onConfirm={handleJiraConnect}
        onJiraBaseUrlChange={setJiraBaseUrl}
        onJiraProjectKeysRawChange={setJiraProjectKeysRaw}
      />
      <ConnectGitHubTokenDialog
        open={githubTokenConnectOpen}
        projectId={projectId}
        initialGitUrl={projectGitUrl}
        onClose={() => {
          setGitHubTokenConnectOpen(false);
        }}
        onConnected={(integration) => {
          setGitHubTokenConnectOpen(false);
          setIntegrations((current) => [...current, integration]);
        }}
      />
      <ConnectBitbucketDialog
        open={bitbucketConnectOpen}
        projectId={projectId}
        initialGitUrl={projectGitUrl}
        onClose={() => {
          setBitbucketConnectOpen(false);
        }}
        onConnected={(integration) => {
          setBitbucketConnectOpen(false);
          setIntegrations((current) => [...current, integration]);
        }}
      />
      <IntegrationCredentialDialog
        platform={credentialPlatform ?? "jira"}
        open={credentialPlatform !== null}
        onClose={() => {
          setCredentialDialogFor(null);
        }}
        onConfirm={handleCredentialConfirm}
        title={`Sync ${CREDENTIAL_PLATFORMS[credentialPlatform ?? "jira"].label}`}
        confirmLabel="Sync"
      />
    </Stack>
  );
}
