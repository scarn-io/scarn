import type {
  ProjectTaskListItem,
  WorkItemActivityEntry,
  WorkItemChild,
  WorkItemComment,
  WorkItemCommentDraft,
  WorkItemDetail,
  WorkItemRunListItem,
  WorkItemListItem,
  WorkItemQuestion,
} from "../src/lib/work-item-api-types";

export const WORK_ITEM_ID = "0196a000-0000-7000-8000-0000000000aa";
export const PROJECT_ID = "0196a000-0000-7000-8000-000000000001";

export function makeWorkItemDetail(
  overrides: Partial<WorkItemDetail> = {},
): WorkItemDetail {
  return {
    id: WORK_ITEM_ID,
    projectId: PROJECT_ID,
    platform: "github",
    platformKey: "acme/app#7",
    url: "https://github.com/acme/app/issues/7",
    title: "Fix the flaky login test",
    description: "The login test fails on CI about once a day.",
    fields: null,
    labels: ["bug"],
    createdByUsername: "ada",
    assigneeUserId: null,
    parentWorkItemId: null,
    state: "open",
    closeReason: null,
    resolution: null,
    closedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

export function makeWorkItemListItem(
  overrides: Partial<WorkItemListItem> = {},
): WorkItemListItem {
  return {
    ...makeWorkItemDetail(),
    latestExecutionStatus: "failed",
    assignee: { userId: "user-1", username: "ada" },
    ...overrides,
  };
}

export function makeWorkItemChild(
  overrides: Partial<WorkItemChild> = {},
): WorkItemChild {
  return {
    ...makeWorkItemDetail({
      id: "0196a000-0000-7000-8000-0000000000cc",
      platformKey: "acme/app#8",
      title: "Stabilise the session fixture",
      parentWorkItemId: WORK_ITEM_ID,
    }),
    status: "running",
    assignee: null,
    ...overrides,
  };
}

export function makeQuestion(
  overrides: Partial<WorkItemQuestion> = {},
): WorkItemQuestion {
  return {
    questionId: "0196a000-0000-7000-8000-0000000000dd",
    status: "open",
    pipelineExecutionId: "0196a000-0000-7000-8000-0000000000bb",
    body: "Should the retry live in the fixture or the test?",
    askedAt: "2026-01-02T01:00:00.000Z",
    waitingOn: [],
    ...overrides,
  };
}

export function makeRunListItem(
  overrides: Partial<WorkItemRunListItem> = {},
): WorkItemRunListItem {
  return {
    id: "0196a000-0000-7000-8000-0000000000bb",
    pipelineDefinitionId: "pipeline-def-1",
    status: "waiting",
    waitingFor: "reply",
    startedAt: "2026-01-02T00:30:00.000Z",
    completedAt: null,
    createdAt: "2026-01-02T00:30:00.000Z",
    ...overrides,
  };
}

export function makeProjectTask(
  overrides: Partial<ProjectTaskListItem> = {},
): ProjectTaskListItem {
  return {
    id: "0196a000-0000-7000-8000-0000000000ee",
    kind: "agent",
    name: "Investigate",
    status: "waiting_for_person",
    createdAt: "2026-01-02T00:31:00.000Z",
    pipelineRun: { name: "triage", number: 3 },
    pipelineRunId: "0196a000-0000-7000-8000-0000000000bb",
    latest: { kind: "message", text: "Asked where the retry should live." },
    ...overrides,
  };
}

export function makeComment(
  overrides: Partial<WorkItemComment> = {},
): WorkItemComment {
  return {
    id: "0196a000-0000-7000-8000-0000000000f1",
    authorKind: "user",
    authorName: "Ada Lovelace",
    authorUsername: "ada",
    authoredByTaskId: null,
    parentCommentId: null,
    externalCommentUrl: null,
    body: "Seen again on main.",
    isPinned: false,
    createdAt: "2026-01-02T02:00:00.000Z",
    ...overrides,
  };
}

export function makeCommentDraft(
  overrides: Partial<WorkItemCommentDraft["notification"]> = {},
): WorkItemCommentDraft {
  return {
    notification: {
      id: "0196a000-0000-7000-8000-0000000000f9",
      pipelineExecutionId: "0196a000-0000-7000-8000-0000000000bb",
      taskId: "0196a000-0000-7000-8000-0000000000ee",
      title: "Investigation summary",
      body: "The fixture leaks a session between tests.",
      status: "pending",
      createdAt: "2026-01-02T03:00:00.000Z",
      ...overrides,
    },
    lastError: null,
  };
}

export function makeActivityEntry(
  overrides: Partial<WorkItemActivityEntry> = {},
): WorkItemActivityEntry {
  return {
    id: "0196a000-0000-7000-8000-0000000000a1",
    kind: "automation",
    message: "Started triage on this work item.",
    createdAt: "2026-01-02T00:29:00.000Z",
    ...overrides,
  };
}
