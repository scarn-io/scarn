import { Elysia, type AnyElysia } from "elysia";
import { autoHead } from "elysia/auto-head";
import type { AppContext as CoreAppContext } from "@scarn/core/lib/di";
import { initServerAnalytics } from "./analytics";
import { cors } from "./http/cors";
import { apiErrorHandler } from "./http/error-handler";
import type { OpenApiPlugin } from "./http/openapi";
import { createAuthRoutes } from "./http/routes/auth";
import { createProjectRoutes } from "./http/routes/projects";
import { createProjectRunsRoutes } from "./http/routes/project-runs";
import { createStepDefinitionRoutes } from "./http/routes/step-definitions";
import { createTaskRunsRoutes } from "./http/routes/task-runs";
import { createTaskGrantRequestRoutes } from "./http/routes/task-grant-requests";
import { createTasksRoutes } from "./http/routes/tasks";
import { createWorkItemsRoutes } from "./http/routes/work-items";
import { createWorkItemCommentsRoutes } from "./http/routes/work-item-comments";
import { createWorkItemCommentDraftsRoutes } from "./http/routes/work-item-comment-drafts";
import { createWorkItemBlocksRoutes } from "./http/routes/work-item-blocks";
import { createPipelineDefinitionRoutes } from "./http/routes/pipeline-definitions";
import { createPipelineDefinitionReadRoutes } from "./http/routes/pipeline-definition-reads";
import { createAutomationRoutes } from "./http/routes/automations";
import { createPipelineExecutionRoutes } from "./http/routes/pipeline-executions";
import { createPipelineExecutionCancelRoutes } from "./http/routes/pipeline-execution-cancels";
import { createPipelineExecutionStepMessageRoutes } from "./http/routes/pipeline-execution-step-messages";
import { createPipelineExecutionReadRoutes } from "./http/routes/pipeline-execution-reads";
import { createConversationRoutes } from "./http/routes/conversations";
import { createProjectArtifactsRoutes } from "./http/routes/project-artifacts";
import { createUserNotificationRoutes } from "./http/routes/user-notifications";
import { createProjectInboxRoutes } from "./http/routes/project-inbox";
import { createWorkSignalTokenRoutes } from "./http/routes/work-signal-token";
import { createTaskRunLogFeedTokenRoutes } from "./http/routes/task-run-log-feed-token";
import { createNotificationRuleRoutes } from "./http/routes/notification-rules";
import { createProjectIntegrationRoutes } from "./http/routes/project-integrations";
import { createIntegrationsReconcileRoutes } from "./http/routes/integrations-reconcile";
import { createAutomationSchedulesTickRoutes } from "./http/routes/automation-schedules-tick";
import { createGitHubIntegrationRoutes } from "./http/routes/github-integration";
import { createProjectSetupRoutes } from "./http/routes/projects-setup";
import { createProjectInviteRoutes } from "./http/routes/project-invites";
import { createUsageRoutes } from "./http/routes/usage";
import { createExecutionsMaintenanceRoutes } from "./http/routes/executions-maintenance";
import { createDemoProjectMaintenanceRoutes } from "./http/routes/demo-project-maintenance";
import { createUsernameRoutes } from "./http/routes/username";
import { createSecretRoutes } from "./http/routes/secrets";
import { createProjectSecretRoutes } from "./http/routes/project-secrets";
import { createEnvironmentRoutes } from "./http/routes/environments";
import { createConnectorRoutes } from "./http/routes/connectors";
import { createManagedMcpOAuthRoutes } from "./http/routes/managed-mcp-oauth";
import { createManagedMcpConnectionRoutes } from "./http/routes/managed-mcp-connections";
import { createManagedMcpConnectionCliRoutes } from "./http/routes/managed-mcp-connections-cli";
import { createManagedMcpConnectionsMaintenanceRoutes } from "./http/routes/managed-mcp-connections-maintenance";
import { createManagedMcpRelayRoutes } from "./http/routes/managed-mcp-relay";
import { createTaskRunEnvironmentRoutes } from "./http/routes/task-run-environment";
import { createTaskRunManagedLaunchRoutes } from "./http/routes/task-run-managed-launch";
// eslint-disable-next-line no-restricted-imports -- the one seam into hosted-only code; the public mirror replaces hosted/routes.ts with a no-op
import { createHostedRoutes } from "./hosted/routes";
import {
  applyPosthogApiTiming,
  buildRouteMetadata,
} from "./http/posthog-api-timing";

export type CreateAppCoreOptions<OpenApi = OpenApiPlugin> = {
  openApi: OpenApi;
};

/**
 * Builds the `/api` Elysia app around a caller-supplied OpenAPI plugin.
 * `createApp` passes the live `@elysia/openapi` plugin; the Cloudflare Worker
 * passes documents pre-rendered at build time, so `@elysia/openapi` (and the
 * spec generation it does on first request) stays out of the Worker bundle.
 *
 * Some route plugins are paired inside a nested `new Elysia().use(a).use(b)`
 * on purpose: every chained `.use()` deepens Elysia's accumulated route type,
 * and a fully flat chain trips TS2589 ("type instantiation is excessively
 * deep") here and in code that consumes the app's type (e.g.
 * `share-links-app.integration.test.ts`). Nesting resets that depth without
 * changing routes or the `App` shape. When adding a route plugin, put it in a
 * new or existing nested group rather than lengthening the top-level chain.
 */
export const createAppCore = <OpenApi extends OpenApiPlugin | AnyElysia>(
  appContext: CoreAppContext,
  { openApi }: CreateAppCoreOptions<OpenApi>,
) => {
  // Must run before any request is served: the timing hooks below capture into
  // a client that is null (and therefore drops every event) until init runs.
  initServerAnalytics();

  const routeMetadataRef = { current: buildRouteMetadata([]) };
  const { app: timingApp, captureErrorTiming } = applyPosthogApiTiming(
    new Elysia({ prefix: "/api" }).use(cors()).use(openApi),
    routeMetadataRef,
  );
  const app = timingApp
    .onError((context) => {
      const problem = apiErrorHandler(context, appContext.logger);
      captureErrorTiming(context, problem);
      return problem;
    })
    .use(createAuthRoutes())
    .use(createProjectRoutes(appContext))
    .use(createStepDefinitionRoutes(appContext))
    .use(
      new Elysia()
        .use(createTasksRoutes(appContext))
        .use(createTaskRunsRoutes(appContext)),
    )
    .use(createPipelineDefinitionRoutes(appContext))
    .use(createPipelineDefinitionReadRoutes(appContext))
    .use(createAutomationRoutes(appContext))
    .use(
      new Elysia()
        .use(createPipelineExecutionRoutes(appContext))
        .use(createProjectRunsRoutes(appContext))
        .use(createWorkSignalTokenRoutes(appContext))
        .use(createTaskRunLogFeedTokenRoutes(appContext)),
    )
    .use(createPipelineExecutionCancelRoutes(appContext))
    .use(createPipelineExecutionStepMessageRoutes(appContext))
    .use(
      new Elysia()
        .use(createPipelineExecutionReadRoutes(appContext))
        .use(createConversationRoutes(appContext)),
    )
    .use(createWorkItemsRoutes(appContext))
    .use(createWorkItemCommentsRoutes(appContext))
    .use(createWorkItemCommentDraftsRoutes(appContext))
    .use(
      new Elysia()
        .use(createWorkItemBlocksRoutes(appContext))
        .use(createTaskGrantRequestRoutes(appContext)),
    )
    .use(createProjectArtifactsRoutes(appContext))
    .use(
      new Elysia()
        .use(createUserNotificationRoutes(appContext))
        .use(createProjectInboxRoutes(appContext)),
    )
    .use(createNotificationRuleRoutes(appContext))
    .use(createProjectIntegrationRoutes(appContext))
    .use(
      new Elysia()
        .use(createIntegrationsReconcileRoutes(appContext))
        .use(createAutomationSchedulesTickRoutes(appContext)),
    )
    .use(createGitHubIntegrationRoutes(appContext))
    .use(createProjectSetupRoutes(appContext))
    .use(createProjectInviteRoutes(appContext))
    .use(createUsageRoutes(appContext))
    .use(createExecutionsMaintenanceRoutes(appContext))
    .use(createDemoProjectMaintenanceRoutes(appContext))
    .use(createUsernameRoutes(appContext))
    .use(
      new Elysia()
        .use(createSecretRoutes(appContext))
        .use(createProjectSecretRoutes(appContext))
        .use(createEnvironmentRoutes(appContext))
        .use(createTaskRunEnvironmentRoutes(appContext))
        .use(createTaskRunManagedLaunchRoutes(appContext))
        .use(createConnectorRoutes(appContext))
        .use(
          new Elysia()
            .use(createManagedMcpOAuthRoutes(appContext))
            .use(createManagedMcpConnectionRoutes(appContext))
            .use(createManagedMcpConnectionCliRoutes(appContext))
            .use(createManagedMcpConnectionsMaintenanceRoutes(appContext))
            .use(createManagedMcpRelayRoutes(appContext)),
        ),
    )
    .use(createHostedRoutes(appContext))
    .use(autoHead());

  routeMetadataRef.current = buildRouteMetadata(app.routes);

  return app;
};
