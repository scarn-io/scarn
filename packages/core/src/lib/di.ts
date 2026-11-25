/* eslint-disable max-lines */
import { resolvePublicUrls } from "./public-urls";
import { systemTimeProvider, type TimeProvider } from "./time-provider";
import { DrizzleWorkItemRepo } from "@scarn/core/work-items/work-item/infra/drizzle-work-item-repo";
import { DrizzleWorkItemTitleReader } from "@scarn/core/work-items/work-item/infra/drizzle-work-item-title-reader";
import { DrizzleChildWorkItemReader } from "@scarn/core/work-items/work-item/infra/drizzle-child-work-item-reader";
import { DrizzleWorkItemCommentRepo } from "@scarn/core/work-items/work-item-comment/infra/drizzle-work-item-comment-repo";
import { DrizzleWorkItemBlockRepo } from "@scarn/core/work-items/work-item-block/infra/drizzle-work-item-block-repo";
import { DrizzleGithubRelationshipPendingRefRepo } from "@scarn/core/integrations/github-ingest/infra/drizzle-github-relationship-pending-ref-repo";
import { DrizzleProjectRepo } from "@scarn/core/projects/project/infra/drizzle-project-repo";
import { DrizzleStepDefinitionRepo } from "@scarn/core/pipeline-definitions/step-definition/infra/drizzle-step-definition-repo";
import { DrizzleEnvironmentRepo } from "@scarn/core/pipeline-definitions/environment/infra/drizzle-environment-repo";
import type { AutomationRepo } from "@scarn/core/pipeline-definitions/automation/application/automation-repo";
import type { WorkItemAutomationRepo } from "@scarn/core/pipeline-definitions/automation/application/work-item-automation-repo";
import { DrizzleAutomationRepo } from "@scarn/core/pipeline-definitions/automation/infra/drizzle-automation-repo";
import type { AutomationScheduleRepo } from "@scarn/core/pipeline-definitions/automation/application/automation-schedule-repo";
import { DrizzleAutomationScheduleRepo } from "@scarn/core/pipeline-definitions/automation/infra/drizzle-automation-schedule-repo";
import { DrizzleWorkItemAutomationRepo } from "@scarn/core/pipeline-definitions/automation/infra/drizzle-work-item-automation-repo";
import { DrizzleTaskRunRepo } from "@scarn/core/tasks/task-run/infra/drizzle-task-run-repo";
import { DrizzleTaskRepo } from "@scarn/core/tasks/task/infra/drizzle-task-repo";
import { DrizzleTaskSummaryReader } from "@scarn/core/tasks/task/infra/drizzle-task-summary-reader";
import type { TaskSummaryReader } from "@scarn/core/tasks/task/application/task-summary-reader";
import type { UserNotificationRepo } from "@scarn/core/notifications/user-notification/application/user-notification-repo";
import { DrizzleUserNotificationRepo } from "@scarn/core/notifications/user-notification/infra/drizzle-user-notification-repo";
import type { NotificationDeliveryRepo } from "@scarn/core/notifications/notification-delivery/application/notification-delivery-repo";
import { DrizzleNotificationDeliveryRepo } from "@scarn/core/notifications/notification-delivery/infra/drizzle-notification-delivery-repo";
import type { NotificationRuleRepo } from "@scarn/core/notifications/notification-policy/application/notification-rule-repo";
import { DrizzleNotificationRuleRepo } from "@scarn/core/notifications/notification-policy/infra/drizzle-notification-rule-repo";
import type { NotificationProvenanceReader } from "@scarn/core/notifications/user-notification/application/notification-provenance-reader";
import { DrizzleNotificationProvenanceReader } from "@scarn/core/notifications/user-notification/infra/drizzle-notification-provenance-reader";
import type { CommentArtifactReader } from "@scarn/core/notifications/comment-artifacts/application/comment-artifact-reader";
import { DrizzleCommentArtifactReader } from "@scarn/core/notifications/comment-artifacts/infra/drizzle-comment-artifact-reader";
import type { NotificationChannelAdapterRegistry } from "@scarn/core/notifications/notification-delivery/application/notification-channel-adapter";
import { DefaultNotificationChannelAdapterRegistry } from "@scarn/core/notifications/notification-delivery/infra/notification-channel-adapter-registry";
import type { GitHubInstallationRepo } from "@scarn/core/integrations/github-installation/application/github-installation-repo";
import { DrizzleGitHubInstallationRepo } from "@scarn/core/integrations/github-installation/infra/drizzle-github-installation-repo";
import type { ProjectIntegrationRepo } from "@scarn/core/integrations/project-integration/application/project-integration-repo";
import { DrizzleProjectIntegrationRepo } from "@scarn/core/integrations/project-integration/infra/drizzle-project-integration-repo";
import type { ProjectInviteRepo } from "@scarn/core/projects/project-invite/application/project-invite-repo";
import { DrizzleProjectInviteRepo } from "@scarn/core/projects/project-invite/infra/drizzle-project-invite-repo";
import type { OrgRepo } from "@scarn/core/organizations/organization/application/org-repo";
import { DrizzleOrgRepo } from "@scarn/core/organizations/organization/infra/drizzle-org-repo";
import type { UsernameReader } from "@scarn/core/organizations/organization/application/username-reader";
import { DrizzleUsernameReader } from "@scarn/core/organizations/organization/infra/drizzle-username-reader";
import type { CommentTaskNameReader } from "@scarn/core/work-items/work-item-comment/application/comment-task-name-reader";
import { DrizzleCommentTaskNameReader } from "@scarn/core/work-items/work-item-comment/infra/drizzle-comment-task-name-reader";
import type { UsageMeterRepo } from "@scarn/core/billing/usage-meter/application/usage-meter-repo";
import { DrizzleUsageMeterRepo } from "@scarn/core/billing/usage-meter/infra/drizzle-usage-meter-repo";
import type { StorageUsageReader } from "@scarn/core/billing/usage-meter/application/storage-usage-reader";
import { DrizzleStorageUsageReader } from "@scarn/core/billing/usage-meter/infra/drizzle-storage-usage-reader";
import { RecordUsageOnLogArchived } from "@scarn/core/billing/usage-meter/application/record-usage-on-log-archived";
import { RecordUsageOnLogArchiveRetrieved } from "@scarn/core/billing/usage-meter/application/record-usage-on-log-archive-retrieved";
import { RecordUsageOnArtifactStored } from "@scarn/core/billing/usage-meter/application/record-usage-on-artifact-stored";
import { RecordUsageOnArtifactDeleted } from "@scarn/core/billing/usage-meter/application/record-usage-on-artifact-deleted";
import { RecordUsageOnSessionSaved } from "@scarn/core/billing/usage-meter/application/record-usage-on-session-saved";
import { RecordUsageOnSessionsReleased } from "@scarn/core/billing/usage-meter/application/record-usage-on-sessions-released";
import { SESSION_SAVED_DOMAIN_EVENT_TYPE } from "@scarn/core/tasks/task-run/domain/session-saved.domain-event";
import { SESSIONS_RELEASED_DOMAIN_EVENT_TYPE } from "@scarn/core/tasks/task-run/domain/sessions-released.domain-event";
import { LOG_ARCHIVED_DOMAIN_EVENT_TYPE } from "@scarn/core/tasks/task-log/domain/log-archived.domain-event";
import { LOG_ARCHIVE_RETRIEVED_DOMAIN_EVENT_TYPE } from "@scarn/core/tasks/task-log/domain/log-archive-retrieved.domain-event";
import { ARTIFACT_STORED_DOMAIN_EVENT_TYPE } from "@scarn/core/tasks/task-artifact/domain/artifact-stored.domain-event";
import { ARTIFACT_DELETED_DOMAIN_EVENT_TYPE } from "@scarn/core/tasks/task-artifact/domain/artifact-deleted.domain-event";
import type {
  LogFeedConnectionConfig,
  LogFeedStore,
} from "@scarn/core/tasks/task-log/application/log-feed-store";
import {
  createLogFeedStoreFromEnv,
  resolveLogFeedConnectionFromEnv,
} from "@scarn/core/tasks/task-log/infra/durable-object-log-feed-store";
import type { StorageSweepRepo } from "@scarn/core/tasks/storage-sweep/application/storage-sweep-repo";
import { DrizzleStorageSweepRepo } from "@scarn/core/tasks/storage-sweep/infra/drizzle-storage-sweep-repo";
import type { ObjectStore } from "@scarn/core/artifacts/object-store";
import {
  LazyS3ObjectStore,
  isS3ObjectStoreConfigured,
} from "@scarn/core/artifacts/infra/s3-object-store";
import { pipelineTaskPipelineRunPort } from "@scarn/core/pipeline-executions/pipeline-run/application/task-pipeline-run-port";
import type { CreateUserNotificationsDeps } from "@scarn/core/notifications/user-notification/application/create-user-notifications-from-task-result";
import type { ProjectRepo } from "@scarn/core/projects/project/application/project-repo";
import type { WorkItemRepo } from "@scarn/core/work-items/work-item/application/work-item-repo";
import type { WorkItemTitleReader } from "@scarn/core/work-items/work-item/application/work-item-title-reader";
import type { ChildWorkItemReader } from "@scarn/core/work-items/work-item/application/child-work-item-reader";
import type { WorkItemCommentRepo } from "@scarn/core/work-items/work-item-comment/application/work-item-comment-repo";
import type { WorkItemBlockRepo } from "@scarn/core/work-items/work-item-block/application/work-item-block-repo";
import type { WorkItemEventsPort } from "@scarn/core/work-items/work-item/application/work-item-events-port";
import { AutomationRunner } from "@scarn/core/pipeline-definitions/automation/application/automation-runner";
import { TaskGroup } from "@scarn/core/tasks/task/application/task-group";
import type { GithubRelationshipPendingRefRepo } from "@scarn/core/integrations/github-ingest/application/github-relationship-pending-ref-repo";
import type { StepDefinitionRepo } from "@scarn/core/pipeline-definitions/step-definition/application/step-definition-repo";
import type { EnvironmentRepo } from "@scarn/core/pipeline-definitions/environment/application/environment-repo";
import type { TaskRunRepo } from "@scarn/core/tasks/task-run/application/task-run-repo";
import type { TaskRepo } from "@scarn/core/tasks/task/application/task-repo";
import type { ArtifactRepo } from "@scarn/core/tasks/task-artifact/application/artifact-repo";
import { DrizzleArtifactRepo } from "@scarn/core/tasks/task-artifact/infra/drizzle-artifact-repo";
import type { ArtifactFailureRepo } from "@scarn/core/tasks/task-artifact/application/artifact-failure-repo";
import { DrizzleArtifactFailureRepo } from "@scarn/core/tasks/task-artifact/infra/drizzle-artifact-failure-repo";
import type { PipelineGraphRepo } from "@scarn/core/pipeline-definitions/pipeline-graph/application/pipeline-graph-repo";
import { DrizzlePipelineGraphRepo } from "@scarn/core/pipeline-definitions/pipeline-graph/infra/drizzle-pipeline-graph-repo";
import type { PipelineGraphVersionRepo } from "@scarn/core/pipeline-definitions/pipeline-graph/application/pipeline-graph-version-repo";
import { DrizzlePipelineGraphVersionRepo } from "@scarn/core/pipeline-definitions/pipeline-graph/infra/drizzle-pipeline-graph-version-repo";
import type { PipelineRunRepo } from "@scarn/core/pipeline-executions/pipeline-run/application/pipeline-run-repo";
import { DrizzlePipelineRunRepo } from "@scarn/core/pipeline-executions/pipeline-run/infra/drizzle-pipeline-run-repo";
import type { NodeVisitQuestionRepo } from "@scarn/core/pipeline-executions/pipeline-run/application/node-visit-question-repo";
import { DrizzleNodeVisitQuestionRepo } from "@scarn/core/pipeline-executions/pipeline-run/infra/drizzle-node-visit-question-repo";
import type { ProjectInboxWaitReader } from "@scarn/core/pipeline-executions/pipeline-run/application/project-inbox-wait-reader";
import { DrizzleProjectInboxWaitReader } from "@scarn/core/pipeline-executions/pipeline-run/infra/drizzle-project-inbox-wait-reader";
import type { ProjectRunsReader } from "@scarn/core/pipeline-executions/project-runs/application/project-runs-reader";
import { DrizzleProjectRunsReader } from "@scarn/core/pipeline-executions/project-runs/infra/drizzle-project-runs-reader";
import { DrizzleTaskRunStepKeyReader } from "@scarn/core/pipeline-executions/pipeline-run/infra/drizzle-task-run-step-key-reader";
import type { TaskRunStepKeyReader } from "@scarn/core/tasks/task-run/application/task-run-step-key-reader";
import type { TaskArtifactResolutionRepo } from "@scarn/core/tasks/task-run/application/task-artifact-resolution-repo";
import { DrizzleTaskArtifactResolutionRepo } from "@scarn/core/tasks/task-run/infra/drizzle-task-artifact-resolution-repo";
import type { TaskExecutionConfigRepo } from "@scarn/core/tasks/task-execution-config/application/task-execution-config-repo";
import { DrizzleTaskExecutionConfigRepo } from "@scarn/core/tasks/task-execution-config/infra/drizzle-task-execution-config-repo";
import type { AgentSessionRepo } from "@scarn/core/tasks/agent-session/application/agent-session-repo";
import { DrizzleAgentSessionRepo } from "@scarn/core/tasks/agent-session/infra/drizzle-agent-session-repo";
import type { TaskMessageRepo } from "@scarn/core/tasks/task-message/application/task-message-repo";
import { DrizzleTaskMessageRepo } from "@scarn/core/tasks/task-message/infra/drizzle-task-message-repo";
import type { ConversationRepo } from "@scarn/core/conversations/conversation/application/conversation-repo";
import { DrizzleConversationRepo } from "@scarn/core/conversations/conversation/infra/drizzle-conversation-repo";
import type { TaskRunHistoryReader } from "@scarn/core/tasks/task-run/application/task-run-history-reader";
import type { RepoConversationReader } from "@scarn/core/conversations/conversation/application/repo-conversation-reader";
import { DrizzleRepoConversationReader } from "@scarn/core/conversations/conversation/infra/drizzle-repo-conversation-reader";
import { DrizzleTaskRunHistoryReader } from "@scarn/core/tasks/task-run/infra/drizzle-task-run-history-reader";
import { InMemoryDomainEventDispatcher } from "@scarn/core/lib/domain-events/in-memory-domain-event-dispatcher";
import { noopLogger, type Logger } from "@scarn/observability/logging";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import { SystemAuthorizationService } from "@scarn/core/access/authorization/infra/system-authorization-service";
import type { WorkItemActivityRepo } from "@scarn/core/work-items/work-item-activity/application/work-item-activity-repo";
import { DrizzleWorkItemActivityRepo } from "@scarn/core/work-items/work-item-activity/infra/drizzle-work-item-activity-repo";
import { ProjectAuthorizationService } from "@scarn/core/access/authorization/infra/project-authorization-service";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { AnalyticsPort } from "@scarn/core/lib/analytics/analytics-port";
import { PostHogAnalytics } from "@scarn/core/lib/analytics/posthog-analytics";
import type { SecretCipher } from "@scarn/core/secrets/secret/application/secret-cipher";
import { LazySecretCipher } from "@scarn/core/secrets/secret/infra/load-secret-cipher-from-env";
import type { SecretRepo } from "@scarn/core/secrets/secret/application/secret-repo";
import { DrizzleSecretRepo } from "@scarn/core/secrets/secret/infra/drizzle-secret-repo";
import type { ManagedConnectionRepo } from "@scarn/core/connections/managed-mcp-connection/application/managed-connection-repo";
import type { ManagedOAuthAttemptRepo } from "@scarn/core/connections/managed-mcp-connection/application/managed-oauth-attempt-repo";
import type { ManagedOAuthGrantRepo } from "@scarn/core/connections/managed-mcp-connection/application/managed-oauth-grant-repo";
import type { ManagedConnectionEventRepo } from "@scarn/core/connections/managed-mcp-connection/application/managed-connection-event-repo";
import { DrizzleManagedConnectionRepo } from "@scarn/core/connections/managed-mcp-connection/infra/drizzle-managed-connection-repo";
import { DrizzleManagedOAuthAttemptRepo } from "@scarn/core/connections/managed-mcp-connection/infra/drizzle-managed-oauth-attempt-repo";
import { DrizzleManagedOAuthGrantRepo } from "@scarn/core/connections/managed-mcp-connection/infra/drizzle-managed-oauth-grant-repo";
import { DrizzleManagedConnectionEventRepo } from "@scarn/core/connections/managed-mcp-connection/infra/drizzle-managed-connection-event-repo";
import type { ManagedLaunchRepo } from "@scarn/core/connections/managed-mcp-connection/application/managed-launch-repo";
import { DrizzleManagedLaunchRepo } from "@scarn/core/connections/managed-mcp-connection/infra/drizzle-managed-launch-repo";
import type { ManagedOAuthProviders } from "@scarn/core/connections/managed-mcp-connection/application/managed-oauth-providers";
import type { ManagedOAuthClientRegistry } from "@scarn/core/connections/managed-mcp-connection/application/managed-oauth-client-registry";
import { managedOAuthClientRegistry as createManagedOAuthClientRegistry } from "@scarn/core/connections/managed-mcp-connection/infra/managed-oauth-client-registries";
import type { ManagedConnectionPresets } from "@scarn/core/connections/managed-mcp-connection/application/managed-connection-preset";
import { ManagedGrantCrypto } from "@scarn/core/connections/managed-mcp-connection/application/managed-grant-crypto";
import type { ManagedMcpToolLister } from "@scarn/core/connections/managed-mcp-connection/application/managed-mcp-tool-lister";
import { ManagedMcpToolCache } from "@scarn/core/connections/managed-mcp-connection/application/managed-mcp-tool-cache";
import { SdkManagedMcpToolLister } from "@scarn/core/connections/managed-mcp-connection/infra/sdk-managed-mcp-tool-lister";
import type { ManagedMcpPassthrough } from "@scarn/core/connections/managed-mcp-connection/application/managed-mcp-passthrough";
import { GuardedMcpPassthrough } from "@scarn/core/connections/managed-mcp-connection/infra/guarded-mcp-passthrough";
import { scheduleBackgroundTask } from "@scarn/core/lib/background-tasks";
import { McpOAuthProviders } from "@scarn/core/connections/managed-mcp-connection/infra/mcp-oauth-providers";
import { ManagedConnectionGuards } from "@scarn/core/connections/managed-mcp-connection/infra/managed-connection-guards";
import { GuardedMcpServerProber } from "@scarn/core/connections/managed-mcp-connection/infra/guarded-mcp-server-prober";
import type { ManagedMcpServerProber } from "@scarn/core/connections/managed-mcp-connection/application/managed-mcp-server-prober";
import {
  GuardedAuthorizeProbe,
  MANAGED_OAUTH_AUTHORIZE_PROBE_TIMEOUT_MS,
} from "@scarn/core/connections/managed-mcp-connection/infra/guarded-authorize-probe";
import type { ManagedOAuthAuthorizeProbe } from "@scarn/core/connections/managed-mcp-connection/application/managed-oauth-authorize-probe";
import { managedConnectionPresetCatalog } from "@scarn/core/connections/managed-mcp-connection/infra/managed-connection-presets";
import type {
  WorkSignal,
  WorkSignalConnectionConfig,
} from "@scarn/core/tasks/task-run/application/work-signal";
import {
  createWorkSignalFromEnv,
  resolveWorkSignalConnectionFromEnv,
} from "@scarn/core/tasks/task-run/infra/http-work-signal";
import {
  AsyncLocalWorkNotifier,
  type WorkNotifier,
} from "@scarn/core/tasks/task-run/application/work-notifier";

export type CreateAppContextOverrides = {
  timeProvider?: TimeProvider;
  projectRepo?: ProjectRepo;
  workItemRepo?: WorkItemRepo;
  workItemTitleReader?: WorkItemTitleReader;
  childWorkItemReader?: ChildWorkItemReader;
  workItemCommentRepo?: WorkItemCommentRepo;
  workItemBlockRepo?: WorkItemBlockRepo;
  githubRelationshipPendingRefRepo?: GithubRelationshipPendingRefRepo;
  stepDefinitionRepo?: StepDefinitionRepo;
  environmentRepo?: EnvironmentRepo;
  taskRepo?: TaskRepo;
  taskSummaryReader?: TaskSummaryReader;
  taskRunRepo?: TaskRunRepo;
  artifactRepo?: ArtifactRepo;
  artifactFailureRepo?: ArtifactFailureRepo;
  pipelineGraphRepo?: PipelineGraphRepo;
  pipelineGraphVersionRepo?: PipelineGraphVersionRepo;
  automationRepo?: AutomationRepo;
  automationScheduleRepo?: AutomationScheduleRepo;
  workItemAutomationRepo?: WorkItemAutomationRepo;
  workItemActivityRepo?: WorkItemActivityRepo;
  /** Wraps (or replaces) the `AutomationRunner` behind `WorkItemEventsPort`. */
  workItemEvents?: (runner: WorkItemEventsPort) => WorkItemEventsPort;
  pipelineRunRepo?: PipelineRunRepo;
  nodeVisitQuestionRepo?: NodeVisitQuestionRepo;
  projectInboxWaitReader?: ProjectInboxWaitReader;
  projectRunsReader?: ProjectRunsReader;
  taskRunStepKeyReader?: TaskRunStepKeyReader;
  taskArtifactResolutionRepo?: TaskArtifactResolutionRepo;
  taskExecutionConfigRepo?: TaskExecutionConfigRepo;
  agentSessionRepo?: AgentSessionRepo;
  taskMessageRepo?: TaskMessageRepo;
  conversationRepo?: ConversationRepo;
  repoConversationReader?: RepoConversationReader;
  taskRunHistoryReader?: TaskRunHistoryReader;
  domainEventDispatcher?: InMemoryDomainEventDispatcher;
  userNotificationRepo?: UserNotificationRepo;
  notificationDeliveryRepo?: NotificationDeliveryRepo;
  notificationRuleRepo?: NotificationRuleRepo;
  notificationProvenanceReader?: NotificationProvenanceReader;
  commentArtifactReader?: CommentArtifactReader;
  notificationChannelAdapterRegistry?: NotificationChannelAdapterRegistry;
  githubInstallationRepo?: GitHubInstallationRepo;
  projectIntegrationRepo?: ProjectIntegrationRepo;
  projectInviteRepo?: ProjectInviteRepo;
  orgRepo?: OrgRepo;
  usernameReader?: UsernameReader;
  commentTaskNameReader?: CommentTaskNameReader;
  usageMeterRepo?: UsageMeterRepo;
  storageUsageReader?: StorageUsageReader;
  logFeedStore?: LogFeedStore;
  storageSweepRepo?: StorageSweepRepo;
  objectStore?: ObjectStore | null;
  objectStorageBucket?: string | null;
  secretCipher?: SecretCipher;
  secretRepo?: SecretRepo;
  managedConnectionRepo?: ManagedConnectionRepo;
  managedOAuthAttemptRepo?: ManagedOAuthAttemptRepo;
  managedOAuthGrantRepo?: ManagedOAuthGrantRepo;
  managedConnectionEventRepo?: ManagedConnectionEventRepo;
  managedLaunchRepo?: ManagedLaunchRepo;
  managedOAuthProviders?: ManagedOAuthProviders;
  managedOAuthClientRegistry?: ManagedOAuthClientRegistry;
  managedOAuthAuthorizeProbe?: ManagedOAuthAuthorizeProbe;
  managedMcpServerProber?: ManagedMcpServerProber;
  managedConnectionPresets?: ManagedConnectionPresets;
  managedMcpToolLister?: ManagedMcpToolLister;
  managedMcpToolCache?: ManagedMcpToolCache;
  managedMcpPassthrough?: ManagedMcpPassthrough;
  /** The app's public URL; defaults to `APP_URL`. */
  appUrl?: string | null;
  /** The API's own public URL (`${apiUrl}/api`); defaults to `API_URL`, then to `appUrl`. */
  apiUrl?: string | null;
  /** Test-only: loopback origins every connection's outbound guard may reach over HTTP. */
  managedOAuthLoopbackOrigins?: string[];
  createUserAuthorizationService?: (
    actorId: UuidV7,
  ) => UserAuthorizationService;
  logger?: Logger;
  analytics?: AnalyticsPort;
  workSignal?: WorkSignal;
  workNotifier?: WorkNotifier;
  workSignalConnection?: WorkSignalConnectionConfig | null;
  logFeedConnection?: LogFeedConnectionConfig | null;
};

/**
 * Resolve the durable object store from the environment, or null when object
 * storage is not configured (log archival then degrades gracefully).
 *
 * This is import-safe: it only checks whether `S3_BUCKET` is set (which never
 * throws) and defers reading credentials + constructing the S3 client until the
 * store is first used. That way evaluating this module during `next build`
 * (page-data collection) does not fail when credentials are absent in the build
 * environment; a genuine misconfiguration surfaces at request time instead.
 */
const resolveObjectStore = (): ObjectStore | null =>
  isS3ObjectStoreConfigured() ? new LazyS3ObjectStore() : null;

/**
 * The configured object-storage bucket, used to build canonical
 * `s3://<bucket>/<key>` store references for artifacts. Read import-safely (a
 * plain env lookup that never throws); null when object storage is unconfigured.
 */
const resolveObjectStorageBucket = (): string | null =>
  process.env["S3_BUCKET"] ?? null;

export function createAppContext(overrides?: CreateAppContextOverrides) {
  const logger = overrides?.logger ?? noopLogger;
  const analytics = overrides?.analytics ?? new PostHogAnalytics(logger);
  const timeProvider = overrides?.timeProvider ?? systemTimeProvider;
  const domainEventDispatcher =
    overrides?.domainEventDispatcher ?? new InMemoryDomainEventDispatcher();
  const projectRepo = overrides?.projectRepo ?? new DrizzleProjectRepo();
  const workItemRepo =
    overrides?.workItemRepo ?? new DrizzleWorkItemRepo(logger);
  const workItemTitleReader =
    overrides?.workItemTitleReader ?? new DrizzleWorkItemTitleReader();
  const childWorkItemReader =
    overrides?.childWorkItemReader ?? new DrizzleChildWorkItemReader();
  const workItemCommentRepo =
    overrides?.workItemCommentRepo ?? new DrizzleWorkItemCommentRepo();
  const workItemBlockRepo =
    overrides?.workItemBlockRepo ?? new DrizzleWorkItemBlockRepo();
  const githubRelationshipPendingRefRepo =
    overrides?.githubRelationshipPendingRefRepo ??
    new DrizzleGithubRelationshipPendingRefRepo();
  const stepDefinitionRepo =
    overrides?.stepDefinitionRepo ?? new DrizzleStepDefinitionRepo(logger);
  const environmentRepo =
    overrides?.environmentRepo ?? new DrizzleEnvironmentRepo();
  const taskRepo = overrides?.taskRepo ?? new DrizzleTaskRepo(logger);
  const taskSummaryReader =
    overrides?.taskSummaryReader ?? new DrizzleTaskSummaryReader();
  const taskRunRepo =
    overrides?.taskRunRepo ?? new DrizzleTaskRunRepo(timeProvider, logger);
  const artifactRepo = overrides?.artifactRepo ?? new DrizzleArtifactRepo();
  const artifactFailureRepo =
    overrides?.artifactFailureRepo ?? new DrizzleArtifactFailureRepo();
  const pipelineGraphRepo =
    overrides?.pipelineGraphRepo ?? new DrizzlePipelineGraphRepo(logger);
  const pipelineGraphVersionRepo =
    overrides?.pipelineGraphVersionRepo ??
    new DrizzlePipelineGraphVersionRepo(logger);
  const automationRepo =
    overrides?.automationRepo ?? new DrizzleAutomationRepo(logger);
  const automationScheduleRepo =
    overrides?.automationScheduleRepo ?? new DrizzleAutomationScheduleRepo();
  const workItemAutomationRepo =
    overrides?.workItemAutomationRepo ??
    new DrizzleWorkItemAutomationRepo(logger);
  const workItemActivityRepo =
    overrides?.workItemActivityRepo ?? new DrizzleWorkItemActivityRepo();
  const pipelineRunRepo =
    overrides?.pipelineRunRepo ?? new DrizzlePipelineRunRepo(logger);
  const nodeVisitQuestionRepo =
    overrides?.nodeVisitQuestionRepo ?? new DrizzleNodeVisitQuestionRepo();
  const projectInboxWaitReader =
    overrides?.projectInboxWaitReader ?? new DrizzleProjectInboxWaitReader();
  const projectRunsReader =
    overrides?.projectRunsReader ?? new DrizzleProjectRunsReader();
  const taskRunStepKeyReader =
    overrides?.taskRunStepKeyReader ?? new DrizzleTaskRunStepKeyReader();
  const taskArtifactResolutionRepo =
    overrides?.taskArtifactResolutionRepo ??
    new DrizzleTaskArtifactResolutionRepo();
  const taskExecutionConfigRepo =
    overrides?.taskExecutionConfigRepo ?? new DrizzleTaskExecutionConfigRepo();
  const agentSessionRepo =
    overrides?.agentSessionRepo ?? new DrizzleAgentSessionRepo();
  const taskMessageRepo =
    overrides?.taskMessageRepo ?? new DrizzleTaskMessageRepo();
  const conversationRepo =
    overrides?.conversationRepo ?? new DrizzleConversationRepo();
  const repoConversationReader =
    overrides?.repoConversationReader ?? new DrizzleRepoConversationReader();
  const taskRunHistoryReader =
    overrides?.taskRunHistoryReader ?? new DrizzleTaskRunHistoryReader();
  const userNotificationRepo =
    overrides?.userNotificationRepo ?? new DrizzleUserNotificationRepo(logger);
  const notificationDeliveryRepo =
    overrides?.notificationDeliveryRepo ??
    new DrizzleNotificationDeliveryRepo(logger);
  const notificationRuleRepo =
    overrides?.notificationRuleRepo ?? new DrizzleNotificationRuleRepo(logger);
  const notificationProvenanceReader =
    overrides?.notificationProvenanceReader ??
    new DrizzleNotificationProvenanceReader();
  const commentArtifactReader =
    overrides?.commentArtifactReader ?? new DrizzleCommentArtifactReader();
  const notificationChannelAdapterRegistry =
    overrides?.notificationChannelAdapterRegistry ??
    new DefaultNotificationChannelAdapterRegistry();
  const githubInstallationRepo =
    overrides?.githubInstallationRepo ?? new DrizzleGitHubInstallationRepo();
  const projectIntegrationRepo =
    overrides?.projectIntegrationRepo ??
    new DrizzleProjectIntegrationRepo(logger);
  const projectInviteRepo =
    overrides?.projectInviteRepo ?? new DrizzleProjectInviteRepo();
  const orgRepo = overrides?.orgRepo ?? new DrizzleOrgRepo();
  const usernameReader =
    overrides?.usernameReader ?? new DrizzleUsernameReader();
  const commentTaskNameReader =
    overrides?.commentTaskNameReader ?? new DrizzleCommentTaskNameReader();
  const usageMeterRepo =
    overrides?.usageMeterRepo ?? new DrizzleUsageMeterRepo();
  const storageUsageReader =
    overrides?.storageUsageReader ?? new DrizzleStorageUsageReader();
  const logFeedStore =
    overrides?.logFeedStore ?? createLogFeedStoreFromEnv(logger);
  const logFeedConnection =
    overrides?.logFeedConnection !== undefined
      ? overrides.logFeedConnection
      : resolveLogFeedConnectionFromEnv();
  const storageSweepRepo =
    overrides?.storageSweepRepo ?? new DrizzleStorageSweepRepo();
  const objectStore =
    overrides?.objectStore !== undefined
      ? overrides.objectStore
      : resolveObjectStore();
  const objectStorageBucket =
    overrides?.objectStorageBucket !== undefined
      ? overrides.objectStorageBucket
      : resolveObjectStorageBucket();
  const secretCipher: SecretCipher =
    overrides?.secretCipher ?? new LazySecretCipher();
  const secretRepo = overrides?.secretRepo ?? new DrizzleSecretRepo(logger);
  const managedConnectionRepo =
    overrides?.managedConnectionRepo ??
    new DrizzleManagedConnectionRepo(logger);
  const managedLaunchRepo =
    overrides?.managedLaunchRepo ?? new DrizzleManagedLaunchRepo();
  const managedOAuthAttemptRepo =
    overrides?.managedOAuthAttemptRepo ?? new DrizzleManagedOAuthAttemptRepo();
  const managedOAuthGrantRepo =
    overrides?.managedOAuthGrantRepo ?? new DrizzleManagedOAuthGrantRepo();
  const managedConnectionEventRepo =
    overrides?.managedConnectionEventRepo ??
    new DrizzleManagedConnectionEventRepo();
  const managedGrantCrypto = new ManagedGrantCrypto(secretCipher);
  const { appUrl, apiBaseUrl } = resolvePublicUrls({
    appUrl:
      overrides?.appUrl !== undefined
        ? overrides.appUrl
        : process.env["APP_URL"],
    apiUrl:
      overrides?.apiUrl !== undefined
        ? overrides.apiUrl
        : process.env["API_URL"],
  });
  const managedConnectionGuards = new ManagedConnectionGuards({
    loopbackOrigins: overrides?.managedOAuthLoopbackOrigins ?? [],
  });
  const managedOAuthAuthorizeProbe =
    overrides?.managedOAuthAuthorizeProbe ??
    new GuardedAuthorizeProbe(
      new ManagedConnectionGuards({
        loopbackOrigins: overrides?.managedOAuthLoopbackOrigins ?? [],
        timeoutMs: MANAGED_OAUTH_AUTHORIZE_PROBE_TIMEOUT_MS,
      }),
    );
  const managedConnectionPresets =
    overrides?.managedConnectionPresets ?? managedConnectionPresetCatalog;
  const managedOAuthProviders =
    overrides?.managedOAuthProviders ??
    new McpOAuthProviders({
      timeProvider,
      guards: managedConnectionGuards,
      presets: managedConnectionPresets,
    });
  const managedOAuthClientRegistry =
    overrides?.managedOAuthClientRegistry ??
    createManagedOAuthClientRegistry({
      apiBaseUrl,
      guards: managedConnectionGuards,
      authorizeProbe: managedOAuthAuthorizeProbe,
      timeProvider,
    });
  const managedMcpServerProber =
    overrides?.managedMcpServerProber ??
    new GuardedMcpServerProber(managedConnectionGuards);
  const managedMcpToolLister =
    overrides?.managedMcpToolLister ??
    new SdkManagedMcpToolLister({ guards: managedConnectionGuards });
  const managedMcpToolCache =
    overrides?.managedMcpToolCache ?? new ManagedMcpToolCache();
  const managedMcpPassthrough =
    overrides?.managedMcpPassthrough ??
    new GuardedMcpPassthrough({ guards: managedConnectionGuards });
  const runAfterResponse = (task: Promise<unknown>) => {
    scheduleBackgroundTask(task, logger);
  };
  const workSignal = overrides?.workSignal ?? createWorkSignalFromEnv(logger);
  const workNotifier: WorkNotifier =
    overrides?.workNotifier ?? new AsyncLocalWorkNotifier(logger);
  const workSignalConnection =
    overrides?.workSignalConnection !== undefined
      ? overrides.workSignalConnection
      : resolveWorkSignalConnectionFromEnv();
  const createUserAuthorizationService =
    overrides?.createUserAuthorizationService ??
    ((actorId: UuidV7) =>
      new ProjectAuthorizationService(actorId, projectRepo));

  const taskPipelineRun = pipelineTaskPipelineRunPort({
    pipelineRunRepo,
    pipelineGraphVersionRepo,
    workItemRepo,
    nodeVisitQuestionRepo,
    taskRunRepo,
  });

  const taskGroup = new TaskGroup({
    taskRepo,
    taskRunRepo,
    stepDefinitionRepo,
    automationScheduleRepo,
    workItemBlockRepo,
    taskPipelineRun,
    timeProvider,
    workNotifier,
  });

  const notifications: CreateUserNotificationsDeps = {
    notificationRepo: userNotificationRepo,
    deliveryRepo: notificationDeliveryRepo,
    notificationRuleRepo,
    adapterRegistry: notificationChannelAdapterRegistry,
    provenanceReader: notificationProvenanceReader,
    commentArtifactReader,
  };

  const automationRunner = new AutomationRunner({
    taskRepo,
    taskRunRepo,
    workItemRepo,
    workItemBlockRepo,
    workItemActivityRepo,
    stepDefinitionRepo,
    pipelineGraphRepo,
    automationRepo,
    workItemAutomationRepo,
    taskGroup,
    workNotifier,
    systemAuthz: new SystemAuthorizationService(projectRepo),
    pipelineRuns: {
      workItemCommentRepo,
      nodeVisitQuestionRepo,
      pipelineRunRepo,
      pipelineGraphVersionRepo,
      stepDefinitionRepo,
      taskRepo,
      taskRunRepo,
      taskMessageRepo,
      conversationRepo,
      workItemRepo,
      workItemBlockRepo,
      workItemTitleReader,
      usernameReader,
      automationRepo,
      taskGroup,
      notifications,
      analytics,
      projectRepo,
      objectStore,
      logger,
      timeProvider,
      workNotifier,
      managedLaunchRepo,
    },
    logger,
    timeProvider,
  });
  const workItemEvents: WorkItemEventsPort =
    overrides?.workItemEvents?.(automationRunner) ?? automationRunner;

  domainEventDispatcher.register(
    LOG_ARCHIVED_DOMAIN_EVENT_TYPE,
    new RecordUsageOnLogArchived({
      usageMeterRepo,
      timeProvider,
      domainEventDispatcher,
      logger,
    }),
  );

  domainEventDispatcher.register(
    LOG_ARCHIVE_RETRIEVED_DOMAIN_EVENT_TYPE,
    new RecordUsageOnLogArchiveRetrieved({
      usageMeterRepo,
      timeProvider,
      domainEventDispatcher,
    }),
  );

  domainEventDispatcher.register(
    ARTIFACT_STORED_DOMAIN_EVENT_TYPE,
    new RecordUsageOnArtifactStored({
      usageMeterRepo,
      timeProvider,
      domainEventDispatcher,
      logger,
    }),
  );

  domainEventDispatcher.register(
    ARTIFACT_DELETED_DOMAIN_EVENT_TYPE,
    new RecordUsageOnArtifactDeleted({ usageMeterRepo, timeProvider }),
  );

  domainEventDispatcher.register(
    SESSION_SAVED_DOMAIN_EVENT_TYPE,
    new RecordUsageOnSessionSaved({
      usageMeterRepo,
      timeProvider,
      domainEventDispatcher,
      logger,
    }),
  );

  domainEventDispatcher.register(
    SESSIONS_RELEASED_DOMAIN_EVENT_TYPE,
    new RecordUsageOnSessionsReleased({ usageMeterRepo, timeProvider }),
  );

  return {
    logger,
    analytics,
    projectRepo,
    workItemRepo,
    workItemTitleReader,
    childWorkItemReader,
    workItemCommentRepo,
    workItemBlockRepo,
    workItemEvents,
    githubRelationshipPendingRefRepo,
    stepDefinitionRepo,
    environmentRepo,
    taskRepo,
    taskGroup,
    taskSummaryReader,
    taskRunRepo,
    artifactRepo,
    artifactFailureRepo,
    pipelineGraphRepo,
    pipelineGraphVersionRepo,
    automationRepo,
    automationScheduleRepo,
    workItemAutomationRepo,
    workItemActivityRepo,
    automationRunner,
    pipelineRunRepo,
    taskPipelineRun,
    nodeVisitQuestionRepo,
    projectInboxWaitReader,
    projectRunsReader,
    taskRunStepKeyReader,
    taskArtifactResolutionRepo,
    notifications,
    taskExecutionConfigRepo,
    agentSessionRepo,
    taskMessageRepo,
    conversationRepo,
    repoConversationReader,
    taskRunHistoryReader,
    userNotificationRepo,
    notificationDeliveryRepo,
    notificationRuleRepo,
    notificationProvenanceReader,
    commentArtifactReader,
    notificationChannelAdapterRegistry,
    githubInstallationRepo,
    projectIntegrationRepo,
    projectInviteRepo,
    orgRepo,
    usernameReader,
    commentTaskNameReader,
    usageMeterRepo,
    storageUsageReader,
    logFeedStore,
    storageSweepRepo,
    objectStore,
    objectStorageBucket,
    secretCipher,
    secretRepo,
    managedConnectionRepo,
    managedOAuthAttemptRepo,
    managedOAuthGrantRepo,
    managedConnectionEventRepo,
    managedLaunchRepo,
    /** The app's public URL without a trailing slash; null when `APP_URL` is unset. */
    appUrl,
    /** The API's public base URL, including the `/api` mount; null when neither `API_URL` nor `APP_URL` is set. */
    apiBaseUrl,
    managedGrantCrypto,
    managedConnectionPresets,
    managedOAuthProviders,
    managedOAuthClientRegistry,
    managedMcpServerProber,
    managedMcpToolLister,
    managedMcpToolCache,
    managedMcpPassthrough,
    /**
     * Keeps the host alive for work that settles after the response is sent;
     * the entry point binds the host with `runWithBackgroundTaskHost`.
     */
    runAfterResponse,
    workSignal,
    workNotifier,
    workSignalConnection,
    logFeedConnection,
    createUserAuthorizationService,
    domainEventDispatcher,
    timeProvider,
  };
}

export type AppContext = ReturnType<typeof createAppContext>;

export const DefaultAppContext = createAppContext();
