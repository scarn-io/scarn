import { expect } from "bun:test";
import { getBetterAuthTrustedOrigins } from "@scarn/identity";
import { createLogger } from "@scarn/observability/logging";
import { createApp } from "@scarn/api/app";
import type { UuidV7 } from "@/common/contracts/uuid-v7";
import { GuardedMcpPassthrough } from "@/connections/managed-mcp-connection/infra/guarded-mcp-passthrough";
import { GuardedMcpServerProber } from "@/connections/managed-mcp-connection/infra/guarded-mcp-server-prober";
import { SdkManagedMcpToolLister } from "@/connections/managed-mcp-connection/infra/sdk-managed-mcp-tool-lister";
import { MANAGED_CONNECTION_PRESETS } from "@/connections/managed-mcp-connection/infra/managed-connection-presets";
import { ManagedConnectionGuards } from "@/connections/managed-mcp-connection/infra/managed-connection-guards";
import { McpOAuthProviders } from "@/connections/managed-mcp-connection/infra/mcp-oauth-providers";
import { ManagedConnectionEntity } from "@/connections/managed-mcp-connection/domain/managed-connection-entity";
import type {
  ManagedOAuthProviderTarget,
  ManagedOAuthProviders,
} from "@/connections/managed-mcp-connection/application/managed-oauth-providers";
import type { ManagedOAuthAuthorizeProbe } from "@/connections/managed-mcp-connection/application/managed-oauth-authorize-probe";
import type { ManagedOAuthProvider } from "@/connections/managed-mcp-connection/application/oauth-provider";
import { runWithBackgroundTaskHost } from "@/lib/background-tasks";
import { createAppContext } from "@/lib/di";
import type { TimeProvider } from "@/lib/time-provider";
import { FakeMcpOAuth } from "tests/connections/support/fake-mcp-oauth";
import {
  createProjectSecretsTestProject,
  createProjectSecretsTestUser,
  type ProjectSecretsTestUser,
} from "tests/secrets/secret/integration/project-secret-test-support";
import { createScarnTreaty } from "tests/treaty";
import { unwrapAsync } from "tests/utils";
import {
  presetsWithFake,
  startConnectionFromDefinition,
} from "./managed-connection-fake-presets";

export const MANAGED_CONNECTION_APP_URL = "https://scarn.test";

/** A clock that follows real time until a test pins or advances it. */
export class TestClock implements TimeProvider {
  private offsetMs = 0;

  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }

  nowIso(): string {
    return this.now().toISOString();
  }

  advance(ms: number): void {
    this.offsetMs += ms;
  }

  reset(): void {
    this.offsetMs = 0;
  }
}

/**
 * The API wired to a loopback fake of Notion's OAuth server, which fetches
 * Scarn's CIMD document from the in-process app. Everything the app logs is
 * kept in `logs`.
 */
export const createManagedConnectionHarness = (
  options: {
    slowMs?: number;
    /** Overrides the provider's 10 s outbound timeout, to time out a slow fake quickly. */
    outboundTimeoutMs?: number;
    /** Overrides the MCP tool lister's 20 s timeout and 2 MiB cap. */
    mcp?: { timeoutMs?: number; maxResponseBytes?: number };
    /** Overrides the relay passthrough's 4 min call and 60 s idle limits. */
    relay?: { callTimeoutMs?: number; idleTimeoutMs?: number };
    /** The origin the app is served from, when a real listener stands in for it. */
    appUrl?: string;
    /** `null` runs the fake as a server without a preset: no identity parser, no forced `iss`. */
    preset?: null;
    /** More loopback origins every connection's guard may reach, for other fakes. */
    loopbackOrigins?: readonly string[];
    /** How the fake and the seeded connection identify the client; `cimd` by default. */
    clientRegistration?: "cimd" | "dcr";
    /** A client the fake knows up front, which the seeded connection signs in as; overrides `clientRegistration`. */
    suppliedClient?: { clientId: string; redirectUri: string };
    /** Catalog presets pointed at other loopback fakes, by preset key. */
    presetFakes?: Readonly<
      Record<string, { resource: string; origin: string }>
    >;
    /** Whether the fake's `/authorize` matches redirect URIs exactly, loopback ports included; false by default. */
    strictRedirects?: boolean;
    /** Stands in for the authorize probe loopback DCR starts make. */
    authorizeProbe?: ManagedOAuthAuthorizeProbe;
    /** Runs the fake like Slack's server, whose endpoint origin the custom-server probe takes for Slack's; needs `suppliedClient`. */
    slackLike?: boolean;
  } = {},
) => {
  const appUrl = options.appUrl ?? MANAGED_CONNECTION_APP_URL;
  const appRef: { current: ReturnType<typeof createApp> | null } = {
    current: null,
  };
  const fetchClientMetadata = (url: string) =>
    appRef.current?.handle(new Request(url)) ??
    Promise.resolve(new Response(null, { status: 503 }));
  const clientRegistration = options.clientRegistration ?? "cimd";
  const supplied = options.suppliedClient;
  const fake = new FakeMcpOAuth({
    fetchClientMetadata,
    clientRegistration,
    ...(supplied === undefined ? {} : { suppliedClient: supplied }),
    ...(options.slackLike === true ? { slackLike: true } : {}),
    ...(options.slowMs === undefined ? {} : { slowMs: options.slowMs }),
    ...(options.strictRedirects === undefined
      ? {}
      : { strictRedirects: options.strictRedirects }),
  }).start();
  const clock = new TestClock();
  const logs: string[] = [];
  const fakeTarget: ManagedOAuthProviderTarget = {
    server:
      supplied === undefined
        ? { ...fake.target, clientRegistration }
        : {
            ...fake.target,
            clientRegistration: "supplied",
            suppliedClientId: supplied.clientId,
            suppliedRedirectUri: supplied.redirectUri,
          },
    preset: options.preset === null ? null : "notion",
  };
  const loopbackOrigins = [
    ...new Set([
      fake.origin,
      fake.endpointOrigin,
      ...(options.loopbackOrigins ?? []),
    ]),
  ];
  const guards = new ManagedConnectionGuards({ loopbackOrigins });
  const presets = presetsWithFake(fake, options.presetFakes);
  const appContext = createAppContext({
    appUrl,
    apiUrl: null,
    managedOAuthLoopbackOrigins: loopbackOrigins,
    managedConnectionPresets: presets,
    ...(options.authorizeProbe === undefined
      ? {}
      : { managedOAuthAuthorizeProbe: options.authorizeProbe }),
    ...(options.slackLike === true
      ? {
          managedMcpServerProber: new GuardedMcpServerProber(guards, {
            slackTokenOrigins: [fake.endpointOrigin],
          }),
        }
      : {}),
    ...(options.outboundTimeoutMs === undefined
      ? {}
      : {
          managedOAuthProviders: new McpOAuthProviders({
            timeProvider: clock,
            guards: new ManagedConnectionGuards({
              loopbackOrigins,
              timeoutMs: options.outboundTimeoutMs,
            }),
            presets,
          }),
        }),
    ...(options.mcp === undefined
      ? {}
      : {
          managedMcpToolLister: new SdkManagedMcpToolLister({
            guards,
            ...options.mcp,
          }),
        }),
    ...(options.relay === undefined
      ? {}
      : {
          managedMcpPassthrough: new GuardedMcpPassthrough({
            guards,
            ...options.relay,
          }),
        }),
    timeProvider: clock,
    logger: createLogger(
      { name: "managed-connection-test", level: "trace" },
      { write: (line: string) => logs.push(line) },
    ),
  });
  const app = createApp(appContext);
  appRef.current = app;
  const apiClient = createScarnTreaty(app);
  const origin = getBetterAuthTrustedOrigins()[0] ?? "";

  const connections = (projectId: UuidV7) =>
    apiClient.api.projects({ projectId })["mcp-connections"];

  /**
   * Gives the project its "notion" connection pointed at the fake, as
   * starting a connect would create it pointed at Notion's real server.
   * A project that already has one keeps it.
   */
  const seedFakeConnection = async (projectId: UuidV7) => {
    if (
      await appContext.managedConnectionRepo.loadByName(projectId, "notion")
    ) {
      return;
    }
    await appContext.managedConnectionRepo.insert(
      ManagedConnectionEntity.create({
        projectId,
        name: "notion",
        label: MANAGED_CONNECTION_PRESETS.notion.label,
        ...fakeTarget,
        now: clock.now(),
      }),
    );
  };

  /**
   * Starts a connect against the fake and returns what the browser would be
   * sent to. The route only creates connections from presets, so a harness
   * without one calls the use case directly.
   */
  const startConnect = async (
    user: ProjectSecretsTestUser,
    projectId: UuidV7,
  ) => {
    await seedFakeConnection(projectId);
    if (fakeTarget.preset === null) {
      return await startConnectionFromDefinition(appContext, user, projectId, {
        name: "notion",
        label: MANAGED_CONNECTION_PRESETS.notion.label,
        ...fakeTarget,
      });
    }
    return await unwrapAsync(
      connections(projectId).post(
        { preset: "notion" },
        { headers: { ...user.authHeaders, origin } },
      ),
    );
  };

  /** The provider every connection the harness creates uses. */
  const fakeProvider = () => appContext.managedOAuthProviders.for(fakeTarget);

  /** Follows the fake's `/authorize` and returns the callback it redirects to. */
  const authorize = async (authorizationUrl: string): Promise<URL> => {
    const response = await fetch(authorizationUrl, { redirect: "manual" });
    expect(response.status).toBe(302);
    return new URL(response.headers.get("location") ?? "");
  };

  const callback = async (
    url: URL | string,
    headers: Record<string, string>,
  ): Promise<{ response: Response; location: URL }> => {
    const response = await app.handle(new Request(url, { headers }));
    expect(response.status).toBe(302);
    return {
      response,
      location: new URL(response.headers.get("location") ?? ""),
    };
  };

  const getConnection = async (
    user: ProjectSecretsTestUser,
    projectId: UuidV7,
    connectionId: string,
  ) =>
    await unwrapAsync(
      connections(projectId)({ connectionId }).get({
        headers: user.authHeaders,
      }),
    );

  /** A new owner, their project, and a connect that has reached the callback URL. */
  const connectToCallback = async (label: string) => {
    const owner = await createProjectSecretsTestUser(label);
    const projectId = await createProjectSecretsTestProject(apiClient, owner);
    const started = await startConnect(owner, projectId);
    const callbackUrl = await authorize(started.authorizationUrl);
    return {
      owner,
      projectId,
      connectionId: started.connectionId,
      authorizationUrl: started.authorizationUrl,
      callbackUrl,
    };
  };

  /** As {@link connectToCallback}, then lands on the callback so a candidate is waiting. */
  const connectToCandidate = async (label: string) => {
    const started = await connectToCallback(label);
    const { location } = await callback(
      started.callbackUrl,
      started.owner.authHeaders,
    );
    expect(location.searchParams.get("error")).toBeNull();
    const pending = await getConnection(
      started.owner,
      started.projectId,
      started.connectionId,
    );
    const candidate = pending.candidate;
    if (!candidate) {
      throw new Error("expected a candidate");
    }
    return { ...started, pending, candidate };
  };

  /** As {@link connectToCandidate}, then confirms it, leaving the project connected. */
  const connectToReady = async (label: string) => {
    const started = await connectToCandidate(label);
    const ready = await unwrapAsync(
      connections(started.projectId)({
        connectionId: started.connectionId,
      }).candidate.confirm.post(
        {
          candidateId: started.candidate.id,
          fingerprint: started.candidate.fingerprint,
          expectedVersion: started.pending.version,
        },
        { headers: { ...started.owner.authHeaders, origin } },
      ),
    );
    return { ...started, ready };
  };

  /** Starts a reconnect of an existing connection and returns what the browser would be sent to. */
  const startReconnect = async (
    user: ProjectSecretsTestUser,
    projectId: UuidV7,
    connectionId: string,
  ) =>
    await unwrapAsync(
      connections(projectId)({ connectionId }).reconnect.post(undefined, {
        headers: { ...user.authHeaders, origin },
      }),
    );

  /** Starts a reconnect and follows `/authorize`, returning the callback URL. */
  const reconnectToCallback = async (
    user: ProjectSecretsTestUser,
    projectId: UuidV7,
    connectionId: string,
  ): Promise<URL> => {
    const started = await startReconnect(user, projectId, connectionId);
    return await authorize(started.authorizationUrl);
  };

  /** As {@link reconnectToCallback}, then lands on the callback so a reconnect candidate is waiting. */
  const reconnectToCandidate = async (
    user: ProjectSecretsTestUser,
    projectId: UuidV7,
    connectionId: string,
  ) => {
    const callbackUrl = await reconnectToCallback(
      user,
      projectId,
      connectionId,
    );
    const { location } = await callback(callbackUrl, user.authHeaders);
    expect(location.searchParams.get("error")).toBeNull();
    const pending = await getConnection(user, projectId, connectionId);
    const candidate = pending.candidate;
    if (!candidate) {
      throw new Error("expected a reconnect candidate");
    }
    return { pending, candidate };
  };

  const backgroundTasks: Promise<unknown>[] = [];

  /**
   * Serves `request` the way a host that waits for after-response work
   * does, keeping that work for {@link settleBackgroundTasks}.
   */
  const handleWithBackgroundTasks = (request: Request) =>
    runWithBackgroundTaskHost(
      {
        waitUntil: (task) => {
          backgroundTasks.push(task);
        },
      },
      () => app.handle(request),
    );

  /** Waits for every after-response task scheduled so far. */
  const settleBackgroundTasks = async () => {
    await Promise.allSettled(backgroundTasks.splice(0));
  };

  const disconnect = async (
    user: ProjectSecretsTestUser,
    projectId: UuidV7,
    connectionId: string,
  ) =>
    await unwrapAsync(
      connections(projectId)({ connectionId }).delete(undefined, {
        headers: { ...user.authHeaders, origin },
      }),
    );

  return {
    fake,
    fakeTarget,
    fakeProvider,
    seedFakeConnection,
    clock,
    logs,
    appContext,
    app,
    apiClient,
    origin,
    connections,
    startConnect,
    authorize,
    callback,
    getConnection,
    connectToCallback,
    connectToCandidate,
    connectToReady,
    startReconnect,
    reconnectToCallback,
    reconnectToCandidate,
    disconnect,
    handleWithBackgroundTasks,
    settleBackgroundTasks,
  };
};

/** `providers` with `overrides` laid over each provider it hands out. */
export const overrideManagedOAuthProviders = (
  providers: ManagedOAuthProviders,
  overrides: Partial<ManagedOAuthProvider>,
): ManagedOAuthProviders => ({
  for: (connection) =>
    Object.assign(
      Object.create(providers.for(connection)) as ManagedOAuthProvider,
      overrides,
    ),
});
