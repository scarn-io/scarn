import { Stack, Typography } from "@mui/material";
import { notFound } from "next/navigation";
import { getGitHubAppConfig } from "@scarn/identity";
import { PageHeader } from "@/components/page-header";
import {
  ProjectIntegrationsPanel,
  type FlashMessage,
} from "@/components/settings/project-integrations-panel";
import { ProjectSecretsPanel } from "@/components/settings/project-secrets-panel";
import { ProjectMcpConnectionsPanel } from "@/components/settings/project-mcp-connections-panel";
import { isManagedOAuthCallbackError } from "@/components/settings/project-mcp-connection-messages";
import { ProjectCollaboratorsPanel } from "@/components/settings/project-collaborators-panel";
import { ProjectArtifactsPanel } from "@/components/settings/project-artifacts-panel";
import { ProjectAutomationsPanel } from "@/components/settings/project-automations-panel";
import { NotificationRulesPanel } from "@/components/notifications/notification-rules-panel";
import {
  getScarnApiClient,
  getScarnApiRequestHeaders,
} from "@/app/_lib/scarn-api-client";
import { getServerSession } from "@/app/_lib/auth";
import { resolveProjectBySlug } from "@/app/(protected)/projects/_lib/project-work-items-server";
import { isProjectMember } from "@/app/_lib/project-membership";
import {
  parseUuidV7,
  type NotificationRuleContract,
} from "@scarn/api/frontend-contracts";
import { stepGrantsByKey } from "@/components/automation-graph/step-grants";

const ERROR_MESSAGES: Record<string, string> = {
  missing_params:
    "GitHub redirected back without the expected parameters. Try again.",
  malformed: "The install link was malformed. Try again.",
  signature_mismatch:
    "The install state could not be verified. Start the flow from your project settings.",
  expired:
    "The install link expired before you finished. Start the flow again.",
  invalid_payload: "The install state was invalid. Start the flow again.",
  invalid_state: "The install state was invalid. Start the flow again.",
  github_app_not_configured:
    "GitHub App is not configured on this server. Ask an admin to set GITHUB_APP_* env vars.",
};

const buildFlashMessage = (
  params: Record<string, string | string[] | undefined>,
): FlashMessage | null => {
  const integration = params["integration"];
  const error = params["error"];
  if (typeof integration === "string") {
    if (integration === "connected") {
      return { severity: "success", text: "GitHub integration connected." };
    }
    if (integration === "no_repositories") {
      return {
        severity: "warning",
        text: "Installation has no repositories yet. Add repos on GitHub, then click Connect GitHub again.",
      };
    }
  }
  if (typeof error === "string" && !isManagedOAuthCallbackError(error)) {
    return {
      severity: "error",
      text: ERROR_MESSAGES[error] ?? `Could not connect GitHub: ${error}`,
    };
  }
  return null;
};

// Settings is entirely write affordances (integrations, collaborators,
// notification channels) — issue #150 requires it to be reachable by nobody
// but a real member, on a public project exactly as on a private one.
export default async function ProjectSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ username: string; projectSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { username, projectSlug } = await params;
  const search = await searchParams;
  const flashMessage = buildFlashMessage(search);

  const session = await getServerSession();
  const requestHeaders = await getScarnApiRequestHeaders();
  const project = await resolveProjectBySlug(
    username,
    projectSlug,
    requestHeaders,
  );

  if (!project || !isProjectMember(project, session?.user.id)) {
    notFound();
  }

  const projectId = project.id;
  const scarnApiClient = await getScarnApiClient();

  const integrationsResponse = await scarnApiClient.api
    .projects({ projectId })
    .integrations.get({ headers: requestHeaders });

  const integrations = Array.isArray(integrationsResponse.data)
    ? integrationsResponse.data
    : [];

  const secretsResponse = await scarnApiClient.api
    .projects({ projectId })
    .secrets.get({ headers: requestHeaders });

  const secrets = Array.isArray(secretsResponse.data)
    ? secretsResponse.data
    : [];

  const mcpConnectionsResponse = await scarnApiClient.api
    .projects({ projectId })
    ["mcp-connections"].get({ headers: requestHeaders });

  const mcpConnections = Array.isArray(mcpConnectionsResponse.data)
    ? mcpConnectionsResponse.data
    : [];

  const mcpPresetsResponse = await scarnApiClient.api
    .projects({ projectId })
    ["mcp-connection-presets"].get({ headers: requestHeaders });

  const mcpPresets = Array.isArray(mcpPresetsResponse.data)
    ? mcpPresetsResponse.data
    : [];

  const mcpCallbackError =
    typeof search["error"] === "string" &&
    isManagedOAuthCallbackError(search["error"])
      ? search["error"]
      : null;

  const invitesResponse = await scarnApiClient.api
    .projects({ projectId })
    .invites.get({ headers: requestHeaders });

  const invites = Array.isArray(invitesResponse.data)
    ? invitesResponse.data
    : [];

  const membersResponse = await scarnApiClient.api
    .projects({ projectId })
    .members.get({ headers: requestHeaders });

  const members = Array.isArray(membersResponse.data)
    ? membersResponse.data
    : [];

  const notificationRulesResponse = await scarnApiClient.api
    .projects({ projectId })
    ["notification-rules"].get({ headers: requestHeaders });

  const initialNotificationRules: NotificationRuleContract[] = Array.isArray(
    notificationRulesResponse.data,
  )
    ? notificationRulesResponse.data
    : [];

  const artifactsResponse = await scarnApiClient.api
    .projects({ projectId })
    .artifacts.get({ headers: requestHeaders });

  const initialArtifacts = artifactsResponse.data?.artifacts ?? [];
  const initialArtifactsHasMore = artifactsResponse.data?.hasMore ?? false;

  const automationsResponse = await scarnApiClient.api
    .projects({ projectId })
    .automations.get({ headers: requestHeaders });

  const automations = Array.isArray(automationsResponse.data)
    ? automationsResponse.data
    : [];

  const stepDefinitionsResponse = await scarnApiClient.api[
    "step-definitions"
  ].get({
    query: { projectId: parseUuidV7(projectId) },
    headers: requestHeaders,
  });

  const stepGrants = stepGrantsByKey(
    Array.isArray(stepDefinitionsResponse.data)
      ? stepDefinitionsResponse.data
      : [],
  );

  const githubAppConfigured = getGitHubAppConfig() !== null;

  return (
    <Stack spacing={4}>
      <PageHeader title="Settings" />
      <Stack spacing={2}>
        <Typography variant="h6">Integrations</Typography>
        <Typography variant="body2" color="text.secondary">
          Pull tickets from external trackers into this project as work items.
          Connect GitHub to install the Scarn app on the repositories you want
          to ingest issues from.
        </Typography>
        <ProjectIntegrationsPanel
          projectId={projectId}
          projectGitUrl={project.gitUrl}
          initialIntegrations={integrations}
          githubAppConfigured={githubAppConfigured}
          automations={automations}
          stepGrants={stepGrants}
          flashMessage={flashMessage}
        />
      </Stack>
      <Stack spacing={2}>
        <Typography variant="h6">Secrets</Typography>
        <Typography variant="body2" color="text.secondary">
          Save API keys and other values your environments need, then use them
          by name. Values are encrypted and can&apos;t be viewed again after you
          save them. A worker that sets the same name in its own{" "}
          <code>.scarn/.env</code> uses its value instead.
        </Typography>
        <ProjectSecretsPanel projectId={projectId} initialSecrets={secrets} />
      </Stack>
      <Stack spacing={2}>
        <Typography variant="h6">MCP connections</Typography>
        <Typography variant="body2" color="text.secondary">
          Connect this project to MCP servers that need you to sign in, so its
          steps can use them. Scarn keeps each connection&apos;s credentials
          encrypted on its servers; they&apos;re never shown or handed to
          workers.
        </Typography>
        <ProjectMcpConnectionsPanel
          projectId={projectId}
          initialConnections={mcpConnections}
          presets={mcpPresets}
          callbackError={mcpCallbackError}
        />
      </Stack>
      <Stack spacing={2}>
        <Typography variant="h6">Collaborators</Typography>
        <Typography variant="body2" color="text.secondary">
          Invite people to collaborate on this project and choose what each
          member can do. Pending invites can be revoked at any time.
        </Typography>
        <ProjectCollaboratorsPanel
          projectId={projectId}
          initialMembers={members}
          initialInvites={invites}
        />
      </Stack>
      <Stack spacing={2}>
        <Typography variant="h6">Automations</Typography>
        <Typography variant="body2" color="text.secondary">
          Automations start steps and pipelines when work items change. A
          project automation that&apos;s on runs for every top-level work item;
          switch it on or off in Pipelines &amp; Automations. Attach a work-item
          automation from a work item&apos;s page.
        </Typography>
        <ProjectAutomationsPanel automations={automations} />
      </Stack>
      <Stack spacing={2}>
        <Typography variant="h6">Notification Channels</Typography>
        <Typography variant="body2" color="text.secondary">
          Control which delivery channels are enabled for each notification
          kind. In-app notifications are always on. Enable Jira, email, or Slack
          channels here and optionally require a minimum priority before they
          fire.
        </Typography>
        <NotificationRulesPanel
          projectId={projectId}
          initialRules={initialNotificationRules}
        />
      </Stack>
      <Stack spacing={2}>
        <Typography variant="h6">Artifacts</Typography>
        <Typography variant="body2" color="text.secondary">
          Files your pipeline steps produced (traces, screenshots, logs) across
          this project. Delete artifacts you no longer need to free up storage.
        </Typography>
        <ProjectArtifactsPanel
          projectId={projectId}
          initialArtifacts={initialArtifacts}
          initialHasMore={initialArtifactsHasMore}
        />
      </Stack>
    </Stack>
  );
}
