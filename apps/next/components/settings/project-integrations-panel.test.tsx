import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ProjectIntegrationView } from "./project-integrations-panel";
import { installDom } from "@/tests/support/install-dom";

type ApiResult = { data: unknown; error: unknown };

let syncResult: ApiResult = { data: { totalUpserted: 2 }, error: null };
type SyncBody =
  | { secretId: string }
  | { email: string; apiKey: string }
  | { token: string }
  | undefined;

const syncCalls: { integrationId: string; body: SyncBody }[] = [];

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      projects: () => ({
        integrations: (params: { integrationId: string }) => ({
          sync: {
            post: (body: SyncBody) => {
              syncCalls.push({ integrationId: params.integrationId, body });
              return Promise.resolve(syncResult);
            },
          },
        }),
      }),
    },
  }),
}));

void mock.module("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {} }),
}));

const SAVED_SECRET_ID = "01966a2c-9494-7db5-aa46-0f8f5cbbea01";

/**
 * `IntegrationCredentialDialog` has its own tests; this fake hands back each
 * credential shape so these tests cover only how the panel picks the
 * platform and sends the choice as the sync body.
 */
void mock.module(
  "@/components/integrations/integration-credential-dialog",
  () => ({
    IntegrationCredentialDialog: (props: {
      platform: string;
      open: boolean;
      onClose: () => void;
      onConfirm: (choice: NonNullable<SyncBody>) => void;
    }) => {
      if (!props.open) return null;
      return (
        <div role="dialog" aria-label={`${props.platform} credential`}>
          <button
            onClick={() => {
              props.onConfirm({ token: "test-github-token" });
            }}
          >
            Use pasted token
          </button>
          <button
            onClick={() => {
              props.onConfirm({ secretId: SAVED_SECRET_ID });
            }}
          >
            Use saved key
          </button>
          <button
            onClick={() => {
              props.onConfirm({
                email: "jira-user@acme.test",
                apiKey: "test-jira-api-key",
              });
            }}
          >
            Use pasted key
          </button>
          <button onClick={props.onClose}>Cancel</button>
        </div>
      );
    },
  }),
);

const { ProjectIntegrationsPanel } =
  await import("./project-integrations-panel");
const { ProjectRouteProvider } =
  await import("@/components/project-route-context");

const autoSyncOff: ProjectIntegrationView["autoSync"] = {
  supported: true,
  state: "off",
  syncsAs: null,
  pausedReason: null,
  pausedDetail: null,
  pausedAt: null,
};

const jiraIntegration: ProjectIntegrationView = {
  id: "01966a2c-9494-7db5-aa46-0f8f5cbbeb01",
  projectId: "01966a2c-9494-7db5-aa46-0f8f5cbbe000",
  kind: "jira",
  externalScope: {
    baseUrl: "https://acme.atlassian.net",
    projectKeys: ["PROJ"],
  },
  status: "active",
  autoSync: autoSyncOff,
  lastSyncedAt: null,
  lastError: null,
  createdAt: "2026-06-01T00:00:00.000Z",
};

const githubIntegration: ProjectIntegrationView = {
  id: "01966a2c-9494-7db5-aa46-0f8f5cbbeb02",
  projectId: "01966a2c-9494-7db5-aa46-0f8f5cbbe000",
  kind: "github_app",
  installationId: "123",
  externalScope: { repos: [{ id: 1, fullName: "acme/widgets" }] },
  status: "active",
  autoSync: autoSyncOff,
  lastSyncedAt: null,
  lastError: null,
  createdAt: "2026-06-01T00:00:00.000Z",
};

const githubTokenIntegration: ProjectIntegrationView = {
  id: "01966a2c-9494-7db5-aa46-0f8f5cbbeb03",
  projectId: "01966a2c-9494-7db5-aa46-0f8f5cbbe000",
  kind: "github_token",
  externalScope: { repos: [{ id: 1, fullName: "acme/widgets" }] },
  status: "active",
  autoSync: autoSyncOff,
  lastSyncedAt: null,
  lastError: null,
  createdAt: "2026-06-01T00:00:00.000Z",
};

const renderPanel = (
  integrations: ProjectIntegrationView[],
  permissions: string[] = ["work-items:read", "integrations:write"],
) =>
  render(
    <ProjectRouteProvider
      username="tester"
      projectSlug="demo"
      projectId="01966a2c-9494-7db5-aa46-0f8f5cbbe000"
      isMember
      permissions={permissions}
    >
      <ProjectIntegrationsPanel
        projectId="01966a2c-9494-7db5-aa46-0f8f5cbbe000"
        projectGitUrl="https://github.com/acme/widgets"
        initialIntegrations={integrations}
        githubAppConfigured
        flashMessage={null}
      />
    </ProjectRouteProvider>,
  );

describe("ProjectIntegrationsPanel sync", () => {
  beforeEach(() => {
    installDom({ url: "http://localhost/" });

    syncResult = { data: { totalUpserted: 2 }, error: null };
    syncCalls.length = 0;
  });

  afterEach(() => {
    cleanup();
  });

  test("shows the Jira site URL on the integration card", () => {
    const view = renderPanel([jiraIntegration]);

    expect(view.getByText("https://acme.atlassian.net")).toBeTruthy();
  });

  test("syncing GitHub calls sync without a credential or dialog", async () => {
    const view = renderPanel([githubIntegration]);

    fireEvent.click(view.getByRole("button", { name: "Sync now" }));

    await waitFor(() => {
      expect(syncCalls).toEqual([
        { integrationId: githubIntegration.id, body: undefined },
      ]);
    });
    expect(view.queryByRole("dialog")).toBeNull();
  });

  test("syncing Jira opens the key picker first", () => {
    const view = renderPanel([jiraIntegration]);

    fireEvent.click(view.getByRole("button", { name: "Sync now" }));

    expect(view.getByRole("dialog", { name: "jira credential" })).toBeTruthy();
    expect(syncCalls).toEqual([]);
  });

  test("a saved key is sent as the sync body { secretId }", async () => {
    const view = renderPanel([jiraIntegration]);

    fireEvent.click(view.getByRole("button", { name: "Sync now" }));
    fireEvent.click(view.getByRole("button", { name: "Use saved key" }));

    await waitFor(() => {
      expect(syncCalls).toEqual([
        {
          integrationId: jiraIntegration.id,
          body: { secretId: SAVED_SECRET_ID },
        },
      ]);
    });
    expect(await view.findByText("Synced 2 work items.")).toBeTruthy();
    expect(view.queryByRole("dialog")).toBeNull();
  });

  test("a pasted key is sent as the sync body { email, apiKey }", async () => {
    const view = renderPanel([jiraIntegration]);

    fireEvent.click(view.getByRole("button", { name: "Sync now" }));
    fireEvent.click(view.getByRole("button", { name: "Use pasted key" }));

    await waitFor(() => {
      expect(syncCalls).toEqual([
        {
          integrationId: jiraIntegration.id,
          body: { email: "jira-user@acme.test", apiKey: "test-jira-api-key" },
        },
      ]);
    });
  });

  test("cards show the connection method, and manual sync only for token integrations", () => {
    const view = renderPanel([githubIntegration, githubTokenIntegration]);

    expect(view.getByText("Connected through GitHub App")).toBeTruthy();
    expect(
      view.getByText("Connected with your token · Manual sync only"),
    ).toBeTruthy();
  });

  test("syncing a GitHub token integration asks for a GitHub token", async () => {
    const view = renderPanel([githubTokenIntegration]);

    fireEvent.click(view.getByRole("button", { name: "Sync now" }));
    expect(
      view.getByRole("dialog", { name: "github credential" }),
    ).toBeTruthy();
    expect(syncCalls).toEqual([]);

    fireEvent.click(view.getByRole("button", { name: "Use pasted token" }));

    await waitFor(() => {
      expect(syncCalls).toEqual([
        {
          integrationId: githubTokenIntegration.id,
          body: { token: "test-github-token" },
        },
      ]);
    });
  });

  test("cancelling the key picker doesn't sync", () => {
    const view = renderPanel([jiraIntegration]);

    fireEvent.click(view.getByRole("button", { name: "Sync now" }));
    fireEvent.click(view.getByRole("button", { name: "Cancel" }));

    expect(view.queryByRole("dialog")).toBeNull();
    expect(syncCalls).toEqual([]);
  });

  test("token integrations show auto-sync controls to members who can manage them", () => {
    const view = renderPanel([
      githubIntegration,
      { ...jiraIntegration, autoSync: autoSyncOff },
    ]);

    expect(view.getAllByText("Auto-sync off")).toHaveLength(1);
    expect(
      view.getAllByRole("button", { name: "Turn on auto-sync" }),
    ).toHaveLength(1);
  });

  test("read-only members see the auto-sync status without the controls", () => {
    const view = renderPanel([jiraIntegration], ["work-items:read"]);

    expect(view.getByText("Auto-sync off")).toBeTruthy();
    expect(
      view.queryByRole("button", { name: "Turn on auto-sync" }),
    ).toBeNull();
  });
});
