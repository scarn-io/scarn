/**
 * Shared jsdom setup, API client fake and fixtures for the conversation
 * panel tests. The DOM globals are installed before React DOM and Testing
 * Library load: React DOM decides at import time whether the DOM can emit
 * `input` events.
 */
import { mock } from "bun:test";
import { installDom } from "@/tests/support/install-dom";

export const conversationId = "019e9a92-b432-73e8-9341-3519156fa730";
export const agentTaskId = "019e9a92-b432-73e8-9341-3519156fa699";

export type Status =
  "agent_turn" | "waiting_for_person" | "reply_pending" | "closed";
export type EndsWith = "findings" | "conversation" | null;

type ApiResponse = { data: unknown; error: unknown };

export const buildConversation = (status: Status, endsWith: EndsWith) => ({
  id: conversationId,
  projectId: "019e709b-574f-742c-8fda-00a1bcc71b9d",
  workItemId: "019e9a92-b432-73e8-9341-3519156fa707",
  status,
  messages: [
    {
      id: "019e9a92-b432-73e8-9341-3519156fa731",
      authorKind: "agent",
      authorName: null,
      taskRunId: agentTaskId,
      body: "SAML only, or SAML and OIDC?",
      createdAt: "2026-06-05T12:00:10.000Z",
    },
    {
      id: "019e9a92-b432-73e8-9341-3519156fa732",
      authorKind: "person",
      authorName: "alex",
      taskRunId: null,
      body: "What's the cost of OIDC later?",
      createdAt: "2026-06-05T12:01:00.000Z",
    },
    {
      id: "019e9a92-b432-73e8-9341-3519156fa733",
      authorKind: "system",
      authorName: "alex",
      taskRunId: null,
      body: "alex chose to continue without a reply",
      createdAt: "2026-06-05T12:02:00.000Z",
    },
  ],
  visit: {
    pipelineExecutionId: "019e9a92-b432-73e8-9341-3519156fa696",
    visitId: "019e9a92-b432-73e8-9341-3519156fa698",
    nodeId: "grill",
  },
  endsWith,
  createdAt: "2026-06-05T12:00:10.000Z",
  closedAt: null,
});

/** What the fake API answers; tests set it before rendering. */
export const api = {
  status: "waiting_for_person" as Status,
  endsWith: "findings" as EndsWith,
  messageResponse: (): ApiResponse => ({
    data: buildConversation("reply_pending", api.endsWith),
    error: null,
  }),
  requestedIds: [] as string[],
};

export const getMock = mock(() =>
  Promise.resolve({
    data: buildConversation(api.status, api.endsWith),
    error: null,
  }),
);
export const postMessageMock = mock(
  (body: { body: string }): Promise<ApiResponse> => {
    void body;
    return Promise.resolve(api.messageResponse());
  },
);
export const continueMock = mock(() =>
  Promise.resolve({
    data: buildConversation("reply_pending", api.endsWith),
    error: null,
  }),
);
export const doneMock = mock(() =>
  Promise.resolve({
    data: buildConversation("closed", api.endsWith),
    error: null,
  }),
);

export const cancelTaskMock = mock((taskId: string) => {
  void taskId;
  return Promise.resolve({ data: { ok: true }, error: null });
});

/** The Task's grant requests the fake lists, and the decisions it received. */
export const grantRequests = {
  list: [] as unknown[],
  decisions: [] as { id: string; body: Record<string, unknown> }[],
};

export function resetApi() {
  grantRequests.list = [];
  grantRequests.decisions = [];
  api.status = "waiting_for_person";
  api.endsWith = "findings";
  api.requestedIds = [];
  api.messageResponse = () => ({
    data: buildConversation("reply_pending", api.endsWith),
    error: null,
  });
  for (const fn of [
    getMock,
    postMessageMock,
    continueMock,
    doneMock,
    cancelTaskMock,
  ]) {
    fn.mockClear();
  }
}

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      conversations: ({ conversationId: id }: { conversationId: string }) => {
        api.requestedIds.push(id);
        return {
          get: getMock,
          messages: { post: postMessageMock },
          continue: { post: continueMock },
          done: { post: doneMock },
        };
      },
      tasks: ({ taskId }: { taskId: string }) => ({
        cancel: { post: () => cancelTaskMock(taskId) },
        "grant-requests": {
          get: () => Promise.resolve({ data: grantRequests.list, error: null }),
        },
      }),
      "task-runs": ({ taskRunId }: { taskRunId: string }) => ({
        get: () =>
          Promise.resolve({
            data: { id: taskRunId, taskId: agentTaskId },
            error: null,
          }),
      }),
      "task-grant-requests": ({
        grantRequestId,
      }: {
        grantRequestId: string;
      }) => ({
        decision: {
          post: (body: Record<string, unknown>) => {
            grantRequests.decisions.push({ id: grantRequestId, body });
            return Promise.resolve({
              data: buildConversation("reply_pending", api.endsWith),
              error: null,
            });
          },
        },
      }),
    },
  }),
}));

installDom({ pretendToBeVisual: true });
Object.assign(globalThis, {
  requestAnimationFrame: (cb: FrameRequestCallback) =>
    setTimeout(() => {
      cb(Date.now());
    }, 0),
  cancelAnimationFrame: (id: number) => {
    clearTimeout(id);
  },
});
