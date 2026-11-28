// Runtime values
export {
  managedConnectionUsageSchema,
  type ManagedConnectionUsageContract,
} from "@scarn/core/connections/managed-mcp-connection/contracts/managed-connection-contracts";
export { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
export {
  createWorkItemId,
  parseWorkItemId,
} from "@scarn/core/work-items/work-item/domain/work-item-id";
export { parseWorkItemCommentId } from "@scarn/core/work-items/work-item-comment/domain/work-item-comment-id";
export { stepDefinitionSchema } from "@scarn/core/pipeline-definitions/step-definition/contracts/step-definition-contracts";
export {
  pipelineDefinitionSchema,
  pipelineVersionSchema,
  pipelineVersionSummarySchema,
} from "@scarn/core/pipeline-definitions/pipeline-graph/contracts/pipeline-graph-contracts";
export {
  DEFAULT_PIPELINE_EXECUTIONS_PAGE_SIZE,
  MAX_PIPELINE_EXECUTIONS_PAGE_SIZE,
  pipelineExecutionSchema,
  pipelineExecutionSortValues,
  pipelineExecutionSummarySchema,
  paginatedPipelineExecutionSummariesSchema,
  pipelineExecutionDisplayStatusValues,
  nodeVisitSchema,
  laneGroupSchema,
  laneSchema,
  visitThreadSchema,
} from "@scarn/core/pipeline-executions/pipeline-run/contracts/pipeline-run-contracts";
export {
  artifactSchema,
  artifactDownloadUrlSchema,
  projectArtifactSchema,
  projectArtifactDetailSchema,
  listProjectArtifactsResponseSchema,
  deleteProjectArtifactsInputSchema,
  artifactBundleSchema,
  artifactBundleStatusSchema,
  listArtifactBundlesResponseSchema,
  projectArtifactBundleDetailSchema,
} from "@scarn/core/tasks/task-artifact/contracts/task-artifact-contracts";
export {
  artifactShareSchema,
  artifactShareStatusSchema,
  artifactShareCreatedViaSchema,
  artifactShareUnavailableReasonSchema,
  artifactPreviewSchema,
  projectArtifactShareSchema,
  listProjectArtifactSharesResponseSchema,
} from "@scarn/core/tasks/artifact-share/contracts/artifact-share-contracts";
export { artifactFailureSchema } from "@scarn/core/tasks/task-artifact/contracts/task-artifact-failure-contracts";
export { taskRunSchema } from "@scarn/core/tasks/task-run/contracts/task-run-contracts";
export {
  TASK_MESSAGE_BODY_MAX_LENGTH,
  TASK_MESSAGE_QUOTE_TEXT_MAX_LENGTH,
} from "@scarn/core/tasks/task-message/domain/task-message-entity";
export {
  conversationSchema,
  workItemConversationSchema,
  projectConversationsPageSchema,
  DEFAULT_PROJECT_CONVERSATIONS_LIMIT,
  MAX_PROJECT_CONVERSATIONS_LIMIT,
} from "@scarn/core/conversations/conversation/contracts/conversation-contracts";
export {
  repoConversationStateValues,
  REPO_CONVERSATION_PREVIEW_LENGTH,
  SHORT_COMMIT_LENGTH,
} from "@scarn/core/conversations/conversation/domain/repo-conversation-state";
export { CONVERSATION_MESSAGE_BODY_MAX_LENGTH } from "@scarn/core/conversations/conversation/domain/conversation-message-entity";
export { CHILD_WORK_ITEM_STATUSES } from "@scarn/core/work-items/work-item/domain/child-work-item-status";
export { MAX_WORK_ITEM_STATUS_IDS } from "@scarn/core/work-items/work-item/contracts/child-work-item-contracts";
export { WORK_ITEM_FIELD_FILTER_PREFIX } from "@scarn/core/work-items/work-item/contracts/work-item-contracts";
export { formatProjectPermission } from "@scarn/core/projects/project/domain/project-permission-labels";
export { PROJECT_ROLES } from "@scarn/core/projects/project/domain/project-role";

// Types only — erased at compile time, never bundled by webpack
export type {
  ProjectRole,
  ProjectRoleDefinition,
} from "@scarn/core/projects/project/domain/project-role";
export type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
export type {
  AnyJsonObject,
  AnyJsonValue,
} from "@scarn/core/common/contracts/json";
export type { OpenCodeMcpServers } from "@scarn/core/common/contracts/opencode-mcp";
export type {
  HealthCheck,
  HealthChecks,
} from "@scarn/core/common/contracts/health-checks";
export type {
  ProjectContract,
  ProjectMemberContract,
  ProjectMembershipContract,
} from "@scarn/core/projects/project/contracts/project-contracts";
export type {
  WorkItemContract,
  WorkItemListItemContract,
  WorkItemAgentFilter,
  WorkItemAssigneeContract,
  WorkItemTaskStatusCounts,
  PaginatedWorkItemsContract,
  WorkItemFieldOptionContract,
} from "@scarn/core/work-items/work-item/contracts/work-item-contracts";
export type {
  ChildWorkItemContract,
  ChildWorkItemLatestTaskContract,
  WorkItemStatusSummaryContract,
} from "@scarn/core/work-items/work-item/contracts/child-work-item-contracts";
export type { ChildWorkItemStatus } from "@scarn/core/work-items/work-item/domain/child-work-item-status";
export type { WorkItemCommentContract } from "@scarn/core/work-items/work-item-comment/contracts/work-item-comment-contracts";
export type {
  PipelineDefinitionContract,
  PipelineVersionContract,
  PipelineVersionSummaryContract,
  PinnedStepContract,
} from "@scarn/core/pipeline-definitions/pipeline-graph/contracts/pipeline-graph-contracts";
export type { PipelineRunStatus } from "@scarn/core/pipeline-executions/pipeline-run/domain/pipeline-run-entity";
export type {
  PipelineExecutionContract,
  PipelineExecutionDisplayStatus,
  PipelineExecutionSort,
  PipelineExecutionSummaryContract,
  PaginatedPipelineExecutionSummariesContract,
  NodeVisitContract,
  VisitTaskContract,
  LaneGroupContract,
  LaneContract,
  VisitThreadContract,
  VisitQuestionContract,
  WaitFor,
  WorkItemQuestionContract,
} from "@scarn/core/pipeline-executions/pipeline-run/contracts/pipeline-run-contracts";
export type { TaskRunContract } from "@scarn/core/tasks/task-run/contracts/task-run-contracts";
export type {
  DisconnectManagedConnectionResponse,
  ManagedConnectionAccountContract,
  ManagedConnectionCandidateContract,
  ManagedConnectionContract,
  ManagedConnectionPresetContract,
  ManagedConnectionToolsContract,
  ManagedOAuthCallbackError,
} from "@scarn/core/connections/managed-mcp-connection/contracts/managed-connection-contracts";
export type {
  RetryTaskInput,
  RetriedTaskContract,
} from "@scarn/core/tasks/task/contracts/task-contracts";
export type {
  ArtifactContract,
  ArtifactDownloadUrlContract,
  ProjectArtifactContract,
  ProjectArtifactDetailContract,
  ProjectArtifactStatus,
  ListProjectArtifactsResponse,
  ArtifactBundleContract,
  ProjectArtifactBundleDetailContract,
} from "@scarn/core/tasks/task-artifact/contracts/task-artifact-contracts";
export type {
  ArtifactShareContract,
  ArtifactPreviewContract,
  ProjectArtifactShareContract,
  ListProjectArtifactSharesResponse,
} from "@scarn/core/tasks/artifact-share/contracts/artifact-share-contracts";
export type {
  ArtifactShareStatus,
  ArtifactShareCreatedVia,
} from "@scarn/core/tasks/artifact-share/domain/artifact-share";
export type { ArtifactBundleStatus } from "@scarn/core/tasks/task-artifact/domain/artifact-bundle";
export type { TaskMessageContract } from "@scarn/core/tasks/task-message/contracts/task-message-contracts";
export type { ArtifactFailureContract } from "@scarn/core/tasks/task-artifact/contracts/task-artifact-failure-contracts";
export type { StepDefinitionContract } from "@scarn/core/pipeline-definitions/step-definition/contracts/step-definition-contracts";
export type {
  AutomationContract,
  AutomationListItemContract,
  AutomationScheduleSummaryContract,
  RunAutomationScheduleResult,
  WorkItemAutomationContract,
} from "@scarn/core/pipeline-definitions/automation/contracts/automation-contracts";
export type {
  UserNotificationContract,
  UserNotificationWithDeliveriesContract,
  UserNotificationKind,
  NotificationPriority,
  NotificationAudience,
  NotificationSource,
  UserNotificationStatus,
  PendingCommentDraftContract,
  CommentDraftArtifactResolutionContract,
} from "@scarn/core/notifications/user-notification/contracts/user-notification-contracts";
export type {
  NotificationDeliveryContract,
  NotificationChannel,
  NotificationDeliveryStatus,
} from "@scarn/core/notifications/notification-delivery/contracts/notification-delivery-contracts";
export type {
  NotificationRuleContract,
  UpsertNotificationRuleInput,
} from "@scarn/core/notifications/notification-policy/contracts/notification-rule-contracts";
export {
  userNotificationKindSchema,
  notificationPrioritySchema,
} from "@scarn/core/notifications/user-notification/contracts/user-notification-contracts";
export { notificationChannelSchema } from "@scarn/core/notifications/notification-delivery/contracts/notification-delivery-contracts";
export type {
  ConversationCapabilities,
  ConversationContextContract,
  ConversationContract,
  ConversationCreatorContract,
  ConversationErrorContract,
  ConversationLatestRunContract,
  ConversationMessageContract,
  CreateRepoConversationBody,
  ProjectConversationSummaryContract,
  ProjectConversationsPageContract,
  RetryRepoConversationBody,
  WorkItemConversationContract,
} from "@scarn/core/conversations/conversation/contracts/conversation-contracts";
export type { RepoConversationState } from "@scarn/core/conversations/conversation/domain/repo-conversation-state";
export type {
  LogLineContract,
  TaskLogStream,
  ReadTaskLogsResult,
  TaskLogArchiveContract,
  ConversationEvent,
  ConversationRole,
  ConversationToolStatus,
} from "@scarn/core/tasks/task-log/contracts/task-log-contracts";
export { conversationEventSchema } from "@scarn/core/tasks/task-log/contracts/task-log-contracts";
export type {
  UsageMeterContract,
  UsageLimitsContract,
} from "@scarn/core/billing/usage-meter/contracts/usage-meter-contracts";
