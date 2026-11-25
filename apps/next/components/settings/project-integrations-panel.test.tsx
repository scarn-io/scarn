import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { AutomationListItemContract } from "@scarn/api/frontend-contracts";
import type { Grant } from "@scarn/sdk/definitions/steps";
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
const { poller } =
  await import("@/components/pipelines/pipeline-page-tabs-fixtures");

const jiraIntegration: ProjectIntegrationView = {
  id: "01966a2c-9494-7db5-aa46-0f8f5cbbeb01",
  projectId: "01966a2c-9494-7db5-aa46-0f8f5cbbe000",
  kind: "jira",
  externalScope: {
    baseUrl: "https://acme.atlassian.net",
    projectKeys: ["PROJ"],
  },
  status: "active",
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
  lastSyncedAt: null,
  lastError: null,
  createdAt: "2026-06-01T00:00:00.000Z",
};

const jiraImporter: AutomationListItemContract = {
  ...poller,
  title: "Issue import",
  latestVersion: {
    id: poller.id,
    version: 1,
    schemaVersion: 1,
    contentHash: "hash",
    publishedAt: "2026-11-01T12:00:00.000Z",
    document: {
      kind: "automation",
      schemaVersion: 1,
      key: poller.key,
      scope: "project",
      rules: [
        {
          key: "hourly",
          event: "schedule",
          cron: "0 * * * *",
          next: { routes: [{ kind: "step", to: "import-jira" }] },
        },
      ],
    },
  },
};

const renderPanel = (
  integrations: ProjectIntegrationView[],
  permissions: string[] = ["work-items:read", "integrations:write"],
  automations: AutomationListItemContract[] = [],
  stepGrants: ReadonlyMap<string, readonly Grant[]> = new Map(),
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
        automations={automations}
        stepGrants={stepGrants}
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

  test("cards show the connection method", () => {
    const view = renderPanel([githubIntegration, githubTokenIntegration]);

    expect(view.getByText("Connected through GitHub App")).toBeTruthy();
    expect(view.getByText("Connected with your token")).toBeTruthy();
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

  test("token integrations without an import schedule explain the library poller", () => {
    const view = renderPanel([githubIntegration, jiraIntegration]);

    expect(view.getAllByText(/To import on a schedule/)).toHaveLength(1);
    expect(view.getByText("@scarn/sdk/library/jira")).toBeTruthy();
    expect(
      view.getByRole("link", { name: /Pipelines & Automations/ }),
    ).toBeTruthy();
  });

  test("a token integration shows its import schedule's last run", () => {
    const view = renderPanel(
      [jiraIntegration],
      undefined,
      [jiraImporter],
      new Map([
        [
          "import-jira",
          [
            {
              resource: "workItem",
              action: "update",
              scope: "project",
              keyPrefix: "PROJ-",
            },
          ],
        ],
      ]),
    );

    expect(view.getByTestId("integration-import-schedule").textContent).toMatch(
      /^Imported by Issue import · last run .+Failed/,
    );
    expect(view.getByText("3 failures in a row")).toBeTruthy();
    expect(view.queryByText(/To import on a schedule/)).toBeNull();
  });
});
