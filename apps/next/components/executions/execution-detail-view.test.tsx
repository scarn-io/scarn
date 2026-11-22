/* eslint max-lines: off */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  parseUuidV7,
  type PipelineExecutionContract,
  type PipelineVersionContract,
} from "@scarn/api/frontend-contracts";
import {
  buildRunExecution,
  buildRunVersion,
  buildTask,
  buildVisit,
  buildVisitTask,
} from "./execution-detail-view.test-helpers";
import { installDom } from "@/tests/support/install-dom";

const projectId = "019e709b-574f-742c-8fda-00a1bcc71b9d";
const executionId = "019e9a92-b432-73e8-9341-3519156fa696";
const reviewVisitId = "019e9a92-b432-73e8-9341-3519156fa698";
const approveVisitId = "019e9a92-b432-73e8-9341-3519156fa711";
const doneVisitId = "019e9a92-b432-73e8-9341-3519156fa712";
const taskId = "019e9a92-b432-73e8-9341-3519156fa699";
const followUpTaskId = "019e9a92-b432-73e8-9341-3519156fa710";
const userId = "019e9a92-b432-73e8-9341-3519156fa701";
const questionId = "019e9a92-b432-73e8-9341-3519156fa720";
const questionCommentId = "019e9a92-b432-73e8-9341-3519156fa721";
const conversationId = "019e9a92-b432-73e8-9341-3519156fa730";

type RunShape = "succeeded" | "waiting" | "running" | "cancelled";

function buildExecution(
  shape: RunShape = "succeeded",
  {
    reviewTaskStatus,
    workBranch = null,
  }: {
    reviewTaskStatus?: "queued" | "running" | "succeeded";
    workBranch?: string | null;
  } = {},
): PipelineExecutionContract {
  const taskStatus =
    reviewTaskStatus ?? (shape === "running" ? "running" : "succeeded");
  const review = buildVisit({
    id: reviewVisitId,
    nodeId: "review",
    status: taskStatus === "succeeded" ? "succeeded" : "active",
    tasks: [buildVisitTask({ taskId, status: taskStatus, workBranch })],
    result: taskStatus === "succeeded" ? { ok: true } : null,
    resultTaskId: taskStatus === "succeeded" ? parseUuidV7(taskId) : null,
    completedAt: taskStatus === "succeeded" ? "2026-06-05T12:00:10.000Z" : null,
  });
  const approve = buildVisit({
    id: approveVisitId,
    nodeId: "approve",
    nodeKind: "wait",
    waitFor: "decision",
    actions: [
      { key: "approve", label: "Approve", body: "optional" },
      { key: "reject", label: "Reject", body: "optional" },
    ],
    fromVisitId: review.id,
    transition: { kind: "route", index: 0 },
    status: shape === "waiting" ? "waiting" : "succeeded",
    result:
      shape === "waiting" ? null : { action: "approve", body: "Looks right" },
    resolvedByUserId: shape === "waiting" ? null : parseUuidV7(userId),
    resolvedAt: shape === "waiting" ? null : "2026-06-05T12:00:20.000Z",
    createdAt: "2026-06-05T12:00:11.000Z",
    completedAt: shape === "waiting" ? null : "2026-06-05T12:00:20.000Z",
  });
  const done = buildVisit({
    id: doneVisitId,
    nodeId: "done",
    nodeKind: "succeed",
    fromVisitId: approve.id,
    transition: { kind: "route", index: 0 },
    createdAt: "2026-06-05T12:00:21.000Z",
    completedAt: "2026-06-05T12:00:21.000Z",
  });
  const visits =
    shape === "running"
      ? [review]
      : shape === "waiting"
        ? [review, approve]
        : [review, approve, done];
  return buildRunExecution({
    id: executionId,
    runStatus:
      shape === "running"
        ? "active"
        : shape === "cancelled"
          ? "cancelled"
          : shape,
    status: shape,
    visits,
  });
}

let currentExecution = buildExecution();
const getExecutionMock = mock(() =>
  Promise.resolve({ data: currentExecution, error: null }),
);
let rerunVisitIds: string[] = [];
const rerunMock = mock((visitId: string) => {
  rerunVisitIds.push(visitId);
  return Promise.resolve({ data: currentExecution, error: null });
});
let decideCalls: { visitId: string; body: Record<string, unknown> }[] = [];
const decideMock = mock((visitId: string, body: Record<string, unknown>) => {
  decideCalls.push({ visitId, body });
  return Promise.resolve({ data: currentExecution, error: null });
});
let continueCalls: { pipelineExecutionId: string; questionId: string }[] = [];
const continueMock = mock((pipelineExecutionId: string, questionId: string) => {
  continueCalls.push({ pipelineExecutionId, questionId });
  return Promise.resolve({ data: currentExecution, error: null });
});
let answerCalls: { questionId: string; body: Record<string, unknown> }[] = [];
const answerMock = mock((questionId: string, body: Record<string, unknown>) => {
  answerCalls.push({ questionId, body });
  return Promise.resolve({ data: currentExecution, error: null });
});
const listCommentsMock = mock(() =>
  Promise.resolve({
    data: [{ id: questionCommentId, body: "Which browser was it?" }],
    error: null,
  }),
);
const postCommentMock = mock(() =>
  Promise.resolve({ data: { id: "c1" }, error: null }),
);
const buildConversation = (status = "waiting_for_person") => ({
  id: conversationId,
  projectId,
  workItemId: currentExecution.workItemId,
  status,
  messages: [
    {
      id: "019e9a92-b432-73e8-9341-3519156fa731",
      authorKind: "agent",
      authorName: null,
      taskRunId: taskId,
      body: "SAML only, or SAML and OIDC?",
      createdAt: "2026-06-05T12:00:10.000Z",
    },
  ],
  visit: {
    pipelineExecutionId: executionId,
    visitId: reviewVisitId,
    nodeId: "review",
  },
  endsWith: "findings",
  createdAt: "2026-06-05T12:00:10.000Z",
  closedAt: null,
});
let conversationStatus = "waiting_for_person";
const getConversationMock = mock(() =>
  Promise.resolve({ data: buildConversation(conversationStatus), error: null }),
);
let conversationMessageBodies: Record<string, unknown>[] = [];
const postConversationMessageMock = mock((body: Record<string, unknown>) => {
  conversationMessageBodies.push(body);
  conversationStatus = "reply_pending";
  return Promise.resolve({
    data: buildConversation("reply_pending"),
    error: null,
  });
});
let messageVisitId: string | null = null;
let messageBody: Record<string, unknown> | null = null;
const defaultMessageResponse = () => ({
  data: { pipelineExecution: currentExecution } as unknown,
  error: null as unknown,
});
let messageResponse = defaultMessageResponse;
const postMessageMock = mock(
  (visitId: string, body: Record<string, unknown>) => {
    messageVisitId = visitId;
    messageBody = body;
    return Promise.resolve(messageResponse());
  },
);
let routeCalls: { visitId: string; body: Record<string, unknown> }[] = [];
let routeResponse: (body: Record<string, unknown>) => {
  data: unknown;
  error: unknown;
} = () => ({ data: currentExecution, error: null });
const routeMock = mock((visitId: string, body: Record<string, unknown>) => {
  routeCalls.push({ visitId, body });
  return Promise.resolve(routeResponse(body));
});
let currentVersion: () => PipelineVersionContract = buildRunVersion;
const buildDefinition = () => {
  const version = currentVersion();
  return {
    id: version.pipelineDefinitionId,
    projectId,
    key: "quality-gate-pipeline",
    name: "Quality gate pipeline",
    archivedAt: null,
    currentVersion: version,
    createdAt: "2026-06-05T12:00:00.000Z",
    updatedAt: "2026-06-05T12:00:00.000Z",
  };
};
const getDefinitionMock = mock(() =>
  Promise.resolve({ data: buildDefinition(), error: null }),
);
const listVersionsMock = mock(() => Promise.resolve({ data: [], error: null }));

function buildThreadRun(
  overrides: Partial<{
    taskRunId: string;
    previousTaskRunId: string | null;
    status: string;
    messages: Record<string, unknown>[];
    sessionRestored: boolean | null;
  }> = {},
) {
  return {
    taskRunId: taskId,
    previousTaskRunId: null,
    status: "succeeded",
    createdAt: "2026-06-05T12:00:05.000Z",
    messages: [],
    sessionRestored: null,
    ...overrides,
  };
}
let threadResponse: () => unknown = () => ({
  visitId: reviewVisitId,
  nodeId: "review",
  runs: [buildThreadRun()],
});
const getThreadMock = mock((visitId: string) => {
  void visitId;
  return Promise.resolve({ data: threadResponse(), error: null });
});
let logLines: Record<string, unknown>[] = [];
const getLogsMock = mock((requestedTaskId: string) => {
  void requestedTaskId;
  return Promise.resolve({
    data: { lines: logLines, nextOffset: logLines.length, complete: true },
    error: null,
  });
});
const getWorkItemMock = mock(() =>
  Promise.resolve({
    data: null,
    error: { value: new Error("work item unavailable") },
  }),
);
const getTaskMock = mock((requestedTaskId: string) =>
  Promise.resolve({
    data: buildTask({ id: requestedTaskId, projectId }),
    error: null,
  }),
);

// The URL is the source of truth for the selection
// (`execution-detail-params.ts`), so the mock re-parses a settable string on
// every `useSearchParams()` call, the way Next.js re-reads the real URL.
let currentSearchParamsString = "";
let currentPathname = "/";
const replaceMock = mock(() => {});
const pushMock = mock(() => {});
void mock.module("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock, prefetch() {} }),
  usePathname: () => currentPathname,
  useSearchParams: () => new URLSearchParams(currentSearchParamsString),
}));
// React Flow needs DOM APIs jsdom lacks; the stub renders one button per node
// so graph selection is still exercised.
void mock.module("@/components/pipeline-graph/pipeline-graph-view", () => ({
  PipelineGraphView: ({
    nodes,
    onSelectNode,
  }: {
    nodes: { id: string }[];
    onSelectNode?: (nodeId: string) => void;
  }) => (
    <div>
      {nodes.map((node) => (
        <button
          key={node.id}
          type="button"
          data-testid={`pipeline-graph-node-${node.id}`}
          onClick={() => {
            onSelectNode?.(node.id);
          }}
        >
          Graph node
        </button>
      ))}
    </div>
  ),
}));
// The header's Runs-list row polls on its own clock; a static row keeps the
// run's polling tests counting only the execution's timers.
let currentRunRow: Record<string, unknown> | null = null;
void mock.module("@/components/runs/use-project-run", () => ({
  useProjectRun: () => ({
    run: currentRunRow,
    notFound: false,
    error: "",
    refresh() {},
  }),
}));
void mock.module("@/app/_lib/auth-client", () => ({
  authClient: {
    useSession: () => ({
      data: {
        user: {
          id: userId,
          email: "test@example.com",
          name: "Test User",
          image: null,
        },
      },
    }),
  },
}));
void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      "pipeline-executions": ({
        pipelineExecutionId,
      }: {
        pipelineExecutionId: string;
      }) => ({
        get: getExecutionMock,
        visits: ({ visitId }: { visitId: string }) => {
          expect(pipelineExecutionId).toBe(executionId);
          return {
            rerun: { post: () => rerunMock(visitId) },
            decision: {
              post: (body: Record<string, unknown>) =>
                decideMock(visitId, body),
            },
            messages: {
              post: (body: Record<string, unknown>) =>
                postMessageMock(visitId, body),
            },
            thread: { get: () => getThreadMock(visitId) },
            route: {
              post: (body: Record<string, unknown>) => routeMock(visitId, body),
            },
          };
        },
        questions: ({ questionId }: { questionId: string }) => ({
          continue: {
            post: () => continueMock(pipelineExecutionId, questionId),
          },
          answer: {
            post: (body: Record<string, unknown>) =>
              answerMock(questionId, body),
          },
        }),
      }),
      "work-item-comments": { get: listCommentsMock, post: postCommentMock },
      conversations: () => ({
        get: getConversationMock,
        messages: { post: postConversationMessageMock },
        continue: { post: getConversationMock },
        done: { post: getConversationMock },
      }),
      "pipeline-definitions": () => {
        const versions = Object.assign(
          () => ({
            get: () => Promise.resolve({ data: null, error: null }),
          }),
          { get: listVersionsMock },
        );
        return { get: getDefinitionMock, versions };
      },
      "work-items": () => ({
        get: getWorkItemMock,
      }),
      projects: () => ({
        members: {
          get: () => Promise.resolve({ data: [], error: null }),
        },
      }),
      "task-runs": ({ taskRunId }: { taskRunId: string }) => ({
        get: () => getTaskMock(taskRunId),
        artifacts: {
          get: () => Promise.resolve({ data: [], error: null }),
        },
        "artifact-failures": {
          get: () => Promise.resolve({ data: [], error: null }),
        },
        logs: {
          get: () => getLogsMock(taskRunId),
          archive: {
            get: () =>
              Promise.resolve({
                data: { url: null, sizeBytes: 0 },
                error: null,
              }),
          },
        },
      }),
    },
  }),
}));

// One JSDOM for the whole file, installed before React DOM loads: React DOM
// decides at import time whether the DOM can emit `input` events, and
// emotion's style cache binds to the document it first sees.
const dom = installDom({ pretendToBeVisual: true });
Object.assign(globalThis, {
  Event: dom.window.Event,
  requestAnimationFrame: (cb: FrameRequestCallback) =>
    setTimeout(() => {
      cb(Date.now());
    }, 0),
  cancelAnimationFrame: (id: number) => {
    clearTimeout(id);
  },
});
const { act, cleanup, fireEvent, render, waitFor, within } =
  await import("@testing-library/react");
const { ExecutionDetailView } = await import("./execution-detail-view");
const { __resetPipelineGraphSpecCacheForTests } =
  await import("@/components/pipeline-graph/use-pipeline-graph-spec");
const { ProjectRouteProvider } =
  await import("@/components/project-route-context");

const WRITER = ["executions:write"];

const detailViewTree = (permissions: string[]) => (
  <ProjectRouteProvider
    username="tester"
    projectSlug="demo"
    projectId={projectId}
    isMember
    permissions={permissions}
  >
    <ExecutionDetailView projectId={projectId} executionId={executionId} />
  </ProjectRouteProvider>
);

const renderDetailView = (permissions: string[] = []) =>
  render(detailViewTree(permissions));

const rerenderDetailView = (
  view: ReturnType<typeof render>,
  permissions: string[] = [],
) => {
  view.rerender(detailViewTree(permissions));
};

function conversationLines(events: Record<string, unknown>[]) {
  return events.map((event, index) => ({
    seq: index + 1,
    stream: "conversation",
    ts: "2026-06-05T12:00:06.000Z",
    content: JSON.stringify(event),
    level: "info",
  }));
}

async function flushAsyncWork() {
  await act(async () => {
    for (let index = 0; index < 5; index += 1) {
      await Promise.resolve();
    }
  });
}

describe("ExecutionDetailView", () => {
  beforeEach(() => {
    for (const fn of [
      getExecutionMock,
      rerunMock,
      decideMock,
      continueMock,
      answerMock,
      listCommentsMock,
      postMessageMock,
      postCommentMock,
      getDefinitionMock,
      listVersionsMock,
      getWorkItemMock,
      getTaskMock,
      getThreadMock,
      getLogsMock,
      getConversationMock,
      postConversationMessageMock,
      routeMock,
      replaceMock,
      pushMock,
    ]) {
      fn.mockClear();
    }
    __resetPipelineGraphSpecCacheForTests();
    routeCalls = [];
    routeResponse = () => ({ data: currentExecution, error: null });
    currentVersion = buildRunVersion;
    rerunVisitIds = [];
    decideCalls = [];
    continueCalls = [];
    answerCalls = [];
    messageVisitId = null;
    messageBody = null;
    conversationStatus = "waiting_for_person";
    conversationMessageBodies = [];
    messageResponse = defaultMessageResponse;
    threadResponse = () => ({
      visitId: reviewVisitId,
      nodeId: "review",
      runs: [buildThreadRun()],
    });
    logLines = [];
    currentExecution = buildExecution();
    currentSearchParamsString = "";
    currentPathname = "/";
    currentRunRow = null;

    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string): MediaQueryList =>
        ({
          addEventListener() {},
          addListener() {},
          dispatchEvent() {
            return false;
          },
          matches: false,
          media: query,
          onchange: null,
          removeEventListener() {},
          removeListener() {},
        }) as MediaQueryList,
      writable: true,
    });
  });

  afterEach(() => {
    cleanup();
  });

  test("loads the pinned version from the definition without listing versions", async () => {
    currentSearchParamsString = "details=run";
    const view = renderDetailView();

    await waitFor(() => {
      expect(view.getByTestId("pipeline-graph-node-review")).toBeTruthy();
    });
    expect(getDefinitionMock).toHaveBeenCalledTimes(1);
    expect(listVersionsMock).not.toHaveBeenCalled();
    await flushAsyncWork();
  });

  describe("rerun", () => {
    test("Rerun from this step posts to the visit's rerun route and reloads", async () => {
      currentSearchParamsString = "step=review";
      const view = renderDetailView(WRITER);

      await waitFor(() => {
        expect(view.getByRole("button", { name: "Run actions" })).toBeTruthy();
      });
      fireEvent.click(view.getByRole("button", { name: "Run actions" }));
      fireEvent.click(
        within(document.body).getByRole("menuitem", {
          name: "Rerun from this step",
        }),
      );

      await waitFor(() => {
        expect(rerunMock).toHaveBeenCalledTimes(1);
      });
      expect(rerunVisitIds).toEqual([reviewVisitId]);
      await waitFor(() => {
        expect(getExecutionMock).toHaveBeenCalledTimes(2);
      });
      await flushAsyncWork();
    });

    test("keeps the page rendered (no loading spinner) while reloading after a rerun", async () => {
      currentSearchParamsString = "step=review";
      const view = renderDetailView(WRITER);

      await waitFor(() => {
        expect(view.getByRole("button", { name: "Run actions" })).toBeTruthy();
      });
      getExecutionMock.mockImplementationOnce(() => new Promise(() => {}));
      fireEvent.click(view.getByRole("button", { name: "Run actions" }));
      fireEvent.click(
        within(document.body).getByRole("menuitem", {
          name: "Rerun from this step",
        }),
      );

      await waitFor(() => {
        expect(getExecutionMock).toHaveBeenCalledTimes(2);
      });
      await flushAsyncWork();

      expect(view.queryByRole("progressbar")).toBeNull();
      expect(view.getAllByText("Review").length).toBeGreaterThan(0);
    });

    test("is hidden for a cancelled run", async () => {
      currentExecution = buildExecution("cancelled");

      const view = renderDetailView(WRITER);

      await waitFor(() => {
        expect(view.getAllByText("Review").length).toBeGreaterThan(0);
      });
      expect(view.queryByRole("button", { name: "Run actions" })).toBeNull();
      await flushAsyncWork();
    });

    test("is hidden without executions:write", async () => {
      const view = renderDetailView();

      await waitFor(() => {
        expect(view.getAllByText("Review").length).toBeGreaterThan(0);
      });
      expect(view.queryByRole("button", { name: "Run actions" })).toBeNull();
      await flushAsyncWork();
    });
  });

  describe("decision", () => {
    const actions = [
      { key: "approve", label: "Approve", body: "optional" as const },
      { key: "revise", label: "Request changes", body: "required" as const },
      { key: "reject", label: "Reject", body: "optional" as const },
    ];
    const buildDecisionWait = (
      resolved: { action: string; body: string | null } | null,
    ): PipelineExecutionContract => {
      const base = buildExecution(resolved ? "succeeded" : "waiting");
      return {
        ...base,
        visits: base.visits.map((visit) =>
          visit.id === approveVisitId
            ? {
                ...visit,
                waitFor: "decision" as const,
                actions,
                input: { plan: "Bump the timeout to 30s" },
                result: resolved,
              }
            : visit,
        ),
      };
    };

    beforeEach(() => {
      currentExecution = buildDecisionWait(null);
      currentSearchParamsString = "step=approve";
    });

    test("shows one button per action, in order, with its label", async () => {
      const view = renderDetailView(WRITER);

      await waitFor(() => {
        expect(view.getByText("Waiting for a decision")).toBeTruthy();
      });
      const names = actions.map((action) => `${action.label} → done`);
      const buttons = view
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label"))
        .filter((name) => name !== null && names.includes(name));
      expect(buttons).toEqual(names);
      expect(
        view.getByLabelText("Add a note (needed to Request changes)"),
      ).toBeTruthy();
      await flushAsyncWork();
    });

    test("shows the wait's input", async () => {
      const view = renderDetailView(WRITER);

      await waitFor(() => {
        expect(view.getByText("Waiting for a decision")).toBeTruthy();
      });
      expect(
        within(view.getByTestId("decision-input")).getByText(
          /Bump the timeout to 30s/,
        ),
      ).toBeTruthy();
      await flushAsyncWork();
    });

    test("a required-body action is disabled until there are notes", async () => {
      const view = renderDetailView(WRITER);

      await waitFor(() => {
        expect(
          view.getByRole("button", { name: /^Request changes/ }),
        ).toBeTruthy();
      });
      const revise = view.getByRole("button", { name: /^Request changes/ });
      expect(revise.hasAttribute("disabled")).toBe(true);
      expect(
        view.getByRole("button", { name: /^Approve/ }).hasAttribute("disabled"),
      ).toBe(false);

      const notes = view.getByLabelText(
        "Add a note (needed to Request changes)",
      );
      fireEvent.change(notes, { target: { value: "   " } });
      expect(revise.hasAttribute("disabled")).toBe(true);
      fireEvent.change(notes, { target: { value: "Handle retries" } });
      expect(revise.hasAttribute("disabled")).toBe(false);
      await flushAsyncWork();
    });

    test("clicking an action posts { action, body } to the visit's decision route", async () => {
      const view = renderDetailView(WRITER);

      await waitFor(() => {
        expect(view.getByText("Waiting for a decision")).toBeTruthy();
      });
      fireEvent.change(
        view.getByLabelText("Add a note (needed to Request changes)"),
        { target: { value: "  Handle retries  " } },
      );
      fireEvent.click(view.getByRole("button", { name: /^Request changes/ }));

      await waitFor(() => {
        expect(decideMock).toHaveBeenCalledTimes(1);
      });
      expect(decideCalls).toEqual([
        {
          visitId: approveVisitId,
          body: { action: "revise", body: "Handle retries" },
        },
      ]);
      await flushAsyncWork();
    });

    test("an optional action without notes posts only the action", async () => {
      const view = renderDetailView(WRITER);

      await waitFor(() => {
        expect(view.getByRole("button", { name: /^Reject/ })).toBeTruthy();
      });
      fireEvent.click(view.getByRole("button", { name: /^Reject/ }));

      await waitFor(() => {
        expect(decideMock).toHaveBeenCalledTimes(1);
      });
      expect(decideCalls[0]?.body).toEqual({ action: "reject" });
      await flushAsyncWork();
    });

    test("a recorded decision is confirmed and tells the inbox", async () => {
      const inboxChanged = mock(() => {});
      window.addEventListener("scarn:inbox-changed", inboxChanged);
      try {
        const view = renderDetailView(WRITER);

        await waitFor(() => {
          expect(view.getByRole("button", { name: /^Approve/ })).toBeTruthy();
        });
        fireEvent.click(view.getByRole("button", { name: /^Approve/ }));

        await waitFor(() => {
          expect(
            view.getByText("Approve — the run goes on to done"),
          ).toBeTruthy();
        });
        expect(inboxChanged).toHaveBeenCalledTimes(1);
        await flushAsyncWork();
      } finally {
        window.removeEventListener("scarn:inbox-changed", inboxChanged);
      }
    });

    test("an answer posts to the question's answer route", async () => {
      currentExecution = {
        ...currentExecution,
        visits: currentExecution.visits.map((visit) =>
          visit.id === approveVisitId
            ? {
                ...visit,
                waitFor: "reply" as const,
                actions: null,
                questions: [
                  {
                    questionId: parseUuidV7(questionId),
                    commentId: parseUuidV7(questionCommentId),
                    taskId: null,
                    status: "open" as const,
                  },
                ],
              }
            : visit,
        ),
      };
      const view = renderDetailView([...WRITER, "comments:create"]);

      await waitFor(() => {
        expect(view.getByText("Which browser was it?")).toBeTruthy();
      });
      fireEvent.change(
        view.getByLabelText(
          "Answer here, or leave it for a reply on the work item",
        ),
        { target: { value: "Firefox" } },
      );
      fireEvent.click(view.getByRole("button", { name: "Send answer" }));

      await waitFor(() => {
        expect(answerMock).toHaveBeenCalledTimes(1);
      });
      expect(answerCalls).toEqual([{ questionId, body: { body: "Firefox" } }]);
      await flushAsyncWork();
    });

    test("without executions:write the panel shows no buttons", async () => {
      const view = renderDetailView();

      await waitFor(() => {
        expect(view.getByText("Waiting for a decision")).toBeTruthy();
      });
      for (const action of actions) {
        expect(
          view.queryByRole("button", { name: new RegExp(`^${action.label}`) }),
        ).toBeNull();
      }
      expect(view.getByText(/permission to decide/)).toBeTruthy();
      expect(view.getByText(/Bump the timeout to 30s/)).toBeTruthy();
      await flushAsyncWork();
    });

    test("a resolved decision shows the action's label and body", async () => {
      currentExecution = buildDecisionWait({
        action: "revise",
        body: "Handle retries",
      });

      const view = renderDetailView(WRITER);

      await waitFor(() => {
        expect(view.getByText("Request changes")).toBeTruthy();
      });
      expect(view.getByText("Handle retries")).toBeTruthy();
      expect(
        view.queryByRole("button", { name: /^Request changes/ }),
      ).toBeNull();
      await flushAsyncWork();
    });
  });

  describe("reply wait", () => {
    const buildReplyWait = (
      resolved: { replied: boolean; body: string | null } | null,
    ): PipelineExecutionContract => {
      const base = buildExecution(resolved ? "succeeded" : "waiting");
      return {
        ...base,
        visits: base.visits.map((visit) =>
          visit.id === approveVisitId
            ? {
                ...visit,
                waitFor: "reply" as const,
                actions: null,
                status: resolved
                  ? ("succeeded" as const)
                  : ("waiting" as const),
                result: resolved ? { ...resolved, commentId: null } : null,
                resolvedAt: resolved ? "2026-06-05T12:00:20.000Z" : null,
                questions: [
                  {
                    questionId: parseUuidV7(questionId),
                    commentId: parseUuidV7(questionCommentId),
                    taskId: null,
                    status: resolved
                      ? resolved.replied
                        ? ("answered" as const)
                        : ("not_needed" as const)
                      : ("open" as const),
                  },
                ],
              }
            : visit,
        ),
      };
    };

    beforeEach(() => {
      currentExecution = buildReplyWait(null);
      currentSearchParamsString = "step=approve";
    });

    test("shows the question with a link to its comment, and no decision controls", async () => {
      const view = renderDetailView(WRITER);

      await waitFor(() => {
        expect(view.getByText("Which browser was it?")).toBeTruthy();
      });
      expect(view.getByText("Waiting for reply")).toBeTruthy();
      expect(
        view
          .getByRole("link", { name: "View on the work item" })
          .getAttribute("href"),
      ).toEndWith(`#comment-${questionCommentId}`);
      expect(view.queryByRole("button", { name: /^Approve/ })).toBeNull();
      expect(view.queryByRole("button", { name: /^Reject/ })).toBeNull();
      await flushAsyncWork();
    });

    test("Continue without reply posts to the question's continue route and reloads", async () => {
      const view = renderDetailView(WRITER);

      await waitFor(() => {
        expect(
          view.getByRole("button", { name: "Continue without reply" }),
        ).toBeTruthy();
      });
      const loadsBefore = getExecutionMock.mock.calls.length;
      fireEvent.click(
        view.getByRole("button", { name: "Continue without reply" }),
      );

      await waitFor(() => {
        expect(continueMock).toHaveBeenCalledTimes(1);
      });
      expect(continueCalls).toEqual([
        { pipelineExecutionId: executionId, questionId },
      ]);
      await waitFor(() => {
        expect(getExecutionMock.mock.calls.length).toBeGreaterThan(loadsBefore);
      });
      expect(decideMock).not.toHaveBeenCalled();
      await flushAsyncWork();
    });

    test("is not offered without executions:write", async () => {
      const view = renderDetailView();

      await waitFor(() => {
        expect(view.getByText("Waiting for reply")).toBeTruthy();
      });
      expect(
        view.queryByRole("button", { name: "Continue without reply" }),
      ).toBeNull();
      await flushAsyncWork();
    });

    test("a wait continued without a reply says so", async () => {
      currentExecution = buildReplyWait({ replied: false, body: null });

      const view = renderDetailView(WRITER);

      await waitFor(() => {
        expect(view.getByText("Continued without a reply")).toBeTruthy();
      });
      expect(
        view.queryByRole("button", { name: "Continue without reply" }),
      ).toBeNull();
      await flushAsyncWork();
    });

    test("an answered wait shows the reply", async () => {
      currentExecution = buildReplyWait({ replied: true, body: "Firefox" });

      const view = renderDetailView(WRITER);

      await waitFor(() => {
        expect(view.getByText("Replied")).toBeTruthy();
      });
      expect(view.getByText("Firefox")).toBeTruthy();
      await flushAsyncWork();
    });
  });

  describe("Details drawer", () => {
    test("the Details button writes ?details=<visitId> and the drawer shows the visit", async () => {
      currentSearchParamsString = "step=review";

      const view = renderDetailView();

      await waitFor(() => {
        expect(view.getByRole("button", { name: "Details" })).toBeTruthy();
      });
      expect(view.queryByRole("dialog")).toBeNull();
      fireEvent.click(view.getByRole("button", { name: "Details" }));
      expect(replaceMock).toHaveBeenLastCalledWith(
        `/?step=review&details=${reviewVisitId}`,
        { scroll: false },
      );

      currentSearchParamsString = `step=review&details=${reviewVisitId}`;
      rerenderDetailView(view);
      await waitFor(() => {
        expect(view.getByRole("dialog")).toBeTruthy();
      });
      const drawer = within(view.getByRole("dialog"));
      expect(drawer.getByRole("heading", { name: "Result" })).toBeTruthy();
      expect(drawer.getByText(/"ok": true/)).toBeTruthy();

      fireEvent.click(view.getByRole("button", { name: "Close details" }));
      expect(replaceMock).toHaveBeenLastCalledWith("/?step=review", {
        scroll: false,
      });
      await flushAsyncWork();
    });

    test("shows the visit's Tasks and work branch", async () => {
      currentExecution = buildExecution("succeeded", {
        workBranch: "scarn/review-abc123",
      });
      currentSearchParamsString = `step=review&details=${reviewVisitId}`;

      const view = renderDetailView();

      await waitFor(() => {
        expect(view.getByRole("dialog")).toBeTruthy();
      });
      const drawer = within(view.getByRole("dialog"));
      expect(drawer.getByText("scarn/review-abc123")).toBeTruthy();
      expect(drawer.getByText("Attempt 1")).toBeTruthy();
      expect(drawer.getByText("Done")).toBeTruthy();
      await flushAsyncWork();
    });

    test("a routing record that took no route says the path ended", async () => {
      const execution = buildExecution();
      currentExecution = {
        ...execution,
        visits: execution.visits.map((visit) =>
          visit.id === reviewVisitId
            ? { ...visit, routing: { checked: [], taken: [], notes: [] } }
            : visit,
        ),
      };
      currentSearchParamsString = `step=review&details=${reviewVisitId}`;

      const view = renderDetailView();

      await waitFor(() => {
        expect(view.getByRole("dialog")).toBeTruthy();
      });
      const drawer = within(view.getByRole("dialog"));
      expect(drawer.getByText("No route matched, path ended")).toBeTruthy();
      await flushAsyncWork();
    });

    test("a routing record that took a route doesn't say the path ended", async () => {
      const execution = buildExecution();
      currentExecution = {
        ...execution,
        visits: execution.visits.map((visit) =>
          visit.id === reviewVisitId
            ? {
                ...visit,
                routing: {
                  checked: [],
                  taken: [{ kind: "route", index: 0 }],
                  notes: [],
                },
              }
            : visit,
        ),
      };
      currentSearchParamsString = `step=review&details=${reviewVisitId}`;

      const view = renderDetailView();

      await waitFor(() => {
        expect(view.getByRole("dialog")).toBeTruthy();
      });
      const drawer = within(view.getByRole("dialog"));
      expect(drawer.getByRole("heading", { name: "Routing" })).toBeTruthy();
      expect(drawer.queryByText("No route matched, path ended")).toBeNull();
      await flushAsyncWork();
    });

    test("summarises the visit's logs and Open logs switches to Logs on that run", async () => {
      currentSearchParamsString = `step=review&details=${reviewVisitId}`;
      logLines = [
        {
          seq: 1,
          stream: "worker",
          ts: "2026-06-05T12:00:06.000Z",
          content: "starting",
          level: "info",
        },
        {
          seq: 2,
          stream: "worker",
          ts: "2026-06-05T12:00:07.000Z",
          content: "slow disk",
          level: "warn",
        },
      ];

      const view = renderDetailView();

      await waitFor(() => {
        expect(view.getByText(/2 lines/)).toBeTruthy();
      });
      expect(view.getByText(/1 warning/)).toBeTruthy();
      fireEvent.click(
        within(view.getByRole("dialog")).getByRole("button", {
          name: "Open logs",
        }),
      );
      expect(replaceMock).toHaveBeenLastCalledWith(
        "/?step=review&view=logs&run=1",
        { scroll: false },
      );
      await flushAsyncWork();
    });
  });

  describe("Logs view", () => {
    const workerLines = [
      {
        seq: 1,
        stream: "worker",
        ts: "2026-06-05T12:00:06.000Z",
        content: "worker says hi",
        level: "info",
      },
      {
        seq: 2,
        stream: "ai-server",
        ts: "2026-06-05T12:00:07.000Z",
        content: "ai server says hi",
        level: "warn",
      },
    ];

    test("the toggle writes ?view=logs, and Logs shows the latest run's lines", async () => {
      currentSearchParamsString = "step=review";
      logLines = workerLines;

      const view = renderDetailView();

      await waitFor(() => {
        expect(view.getByText(/No conversation captured/)).toBeTruthy();
      });
      fireEvent.click(view.getByRole("tab", { name: "Logs" }));
      expect(replaceMock).toHaveBeenLastCalledWith("/?step=review&view=logs", {
        scroll: false,
      });

      currentSearchParamsString = "step=review&view=logs";
      rerenderDetailView(view);
      await waitFor(() => {
        expect(view.getByText("worker says hi")).toBeTruthy();
      });
      expect(view.getByText("ai server says hi")).toBeTruthy();
      expect(view.getByText(/2 lines · 1 warning/)).toBeTruthy();
      await flushAsyncWork();
    });

    test("?run= picks the run, ?filter= the stream, and the filter writes ?filter=", async () => {
      currentSearchParamsString = "step=review&view=logs&run=1&filter=worker";
      threadResponse = () => ({
        visitId: reviewVisitId,
        nodeId: "review",
        runs: [
          buildThreadRun(),
          buildThreadRun({
            taskRunId: followUpTaskId,
            previousTaskRunId: taskId,
          }),
        ],
      });
      logLines = workerLines;

      const view = renderDetailView();

      await waitFor(() => {
        expect(view.getByText("worker says hi")).toBeTruthy();
      });
      expect(view.queryByText("ai server says hi")).toBeNull();
      expect(getLogsMock.mock.calls.map(([id]) => id)).toEqual([taskId]);
      expect(
        view.getByRole("combobox", { name: "Logs run" }).textContent,
      ).toContain("Run 1");
      fireEvent.click(view.getByRole("button", { name: "AI server" }));
      expect(replaceMock).toHaveBeenLastCalledWith(
        "/?step=review&view=logs&run=1&filter=ai-server",
        { scroll: false },
      );
      await flushAsyncWork();
    });

    test("hides the message box", async () => {
      currentSearchParamsString = "step=review";

      const view = renderDetailView(WRITER);

      await waitFor(() => {
        expect(view.getByLabelText("Message to this step")).toBeTruthy();
      });
      currentSearchParamsString = "step=review&view=logs";
      rerenderDetailView(view, WRITER);
      await waitFor(() => {
        expect(view.getByRole("combobox", { name: "Logs run" })).toBeTruthy();
      });
      expect(view.queryByLabelText("Message to this step")).toBeNull();
      await flushAsyncWork();
    });
  });

  test("a selected step renders its visit's thread", async () => {
    currentSearchParamsString = "step=review";
    threadResponse = () => ({
      visitId: reviewVisitId,
      nodeId: "review",
      runs: [
        buildThreadRun(),
        buildThreadRun({
          taskRunId: followUpTaskId,
          previousTaskRunId: taskId,
          messages: [
            {
              id: "019e9a92-b432-73e8-9341-3519156fa720",
              taskId: followUpTaskId,
              authorUserId: userId,
              body: "Use the v2 API",
              quoteText: "the v1 client is deprecated",
              createdAt: "2026-06-05T12:01:00.000Z",
            },
          ],
        }),
      ],
    });
    logLines = conversationLines([
      { kind: "message", id: "m2", role: "assistant", createdMs: 2 },
      {
        kind: "text",
        messageId: "m2",
        partId: "p2",
        role: "assistant",
        text: "Switched to the **v2** client.",
      },
    ]);

    const view = renderDetailView();

    await waitFor(() => {
      expect(view.getByText(/Switched to the/)).toBeTruthy();
    });
    expect(getThreadMock).toHaveBeenCalledWith(reviewVisitId);
    expect(getLogsMock.mock.calls.map(([id]) => id)).toEqual([followUpTaskId]);
    expect(view.getByText("v2").tagName).toBe("STRONG");
    expect(view.getByText("Use the v2 API")).toBeTruthy();
    expect(view.getByText("the v1 client is deprecated")).toBeTruthy();
    expect(view.getAllByText(/Started by pipeline/).length).toBeGreaterThan(0);
    expect(view.getAllByText(/From your message/).length).toBeGreaterThan(0);
    await flushAsyncWork();
  });

  test("a wait node reads no thread", async () => {
    currentSearchParamsString = "step=approve";

    const view = renderDetailView();

    await waitFor(() => {
      expect(view.getByText("Approve")).toBeTruthy();
    });
    expect(getThreadMock).not.toHaveBeenCalled();
    await flushAsyncWork();
  });

  test("selecting a step in the nav writes ?step=", async () => {
    const view = renderDetailView();

    await waitFor(() => {
      expect(view.getByRole("button", { name: /Review/ })).toBeTruthy();
    });
    fireEvent.click(view.getByRole("button", { name: /Review/ }));

    expect(replaceMock).toHaveBeenLastCalledWith("/?step=review", {
      scroll: false,
    });
    await flushAsyncWork();
  });

  test("clicking a graph node in the run's details writes that node's ?step=", async () => {
    currentSearchParamsString = "details=run";
    const view = renderDetailView();

    fireEvent.click(await view.findByTestId("pipeline-graph-node-approve"));

    expect(replaceMock).toHaveBeenLastCalledWith("/?step=approve", {
      scroll: false,
    });
    await flushAsyncWork();
  });

  describe("landing", () => {
    test("with no ?step lands on what's waiting, not on the overview", async () => {
      currentExecution = buildExecution("waiting");
      const view = renderDetailView(WRITER);

      await waitFor(() => {
        expect(
          view.getByRole("heading", { level: 2, name: "approve" }),
        ).toBeTruthy();
      });
      expect(view.getByRole("button", { name: /^Approve/ })).toBeTruthy();
      expect(view.queryByText("Run overview")).toBeNull();
      await flushAsyncWork();
    });

    test("a finished run lands on its end", async () => {
      const view = renderDetailView();

      await waitFor(() => {
        expect(
          view.getByRole("heading", { level: 2, name: "done" }),
        ).toBeTruthy();
      });
      await flushAsyncWork();
    });

    test("a running run lands on the running step", async () => {
      currentExecution = buildExecution("running");
      const view = renderDetailView();

      await waitFor(() => {
        expect(
          view.getByRole("heading", { level: 2, name: "Review" }),
        ).toBeTruthy();
      });
      await flushAsyncWork();
    });

    test("?step= still wins over the landing visit", async () => {
      currentExecution = buildExecution("waiting");
      currentSearchParamsString = "step=review";
      const view = renderDetailView();

      await waitFor(() => {
        expect(
          view.getByRole("heading", { level: 2, name: "Review" }),
        ).toBeTruthy();
      });
      await flushAsyncWork();
    });

    test("a step-page change on the landed visit pins it into the URL", async () => {
      currentExecution = buildExecution("running");
      const view = renderDetailView();

      fireEvent.click(await view.findByRole("tab", { name: "Logs" }));
      expect(replaceMock).toHaveBeenLastCalledWith("/?step=review&view=logs", {
        scroll: false,
      });
      await flushAsyncWork();
    });
  });

  describe("run details", () => {
    test("?details=run shows the run's overview in the drawer", async () => {
      currentSearchParamsString = "details=run";
      const view = renderDetailView();

      const drawer = await within(document.body).findByRole("dialog");
      await waitFor(() => {
        expect(within(drawer).getByText("Run overview")).toBeTruthy();
      });
      expect(
        within(drawer).getByRole("tab", { name: "Run", selected: true }),
      ).toBeTruthy();
      void view;
      await flushAsyncWork();
    });

    test("the rail lists every visit and selecting one opens it", async () => {
      const view = renderDetailView();

      const rail = within(await view.findByRole("complementary"));
      await waitFor(() => {
        expect(rail.getByText("3 steps, oldest first")).toBeTruthy();
      });
      fireEvent.click(rail.getByRole("button", { name: /Review/ }));
      expect(replaceMock).toHaveBeenLastCalledWith("/?step=review", {
        scroll: false,
      });
      await flushAsyncWork();
    });

    test("the rail's Graph mode is kept in the URL and a node opens its visit", async () => {
      const view = renderDetailView();

      const rail = within(await view.findByRole("complementary"));
      fireEvent.click(await rail.findByRole("radio", { name: "Graph" }));
      expect(replaceMock).toHaveBeenLastCalledWith("/?rail=graph", {
        scroll: false,
      });
      cleanup();

      currentSearchParamsString = "rail=graph";
      const graphView = renderDetailView();
      const graphRail = within(await graphView.findByRole("complementary"));
      expect(
        graphRail.getByRole("radio", { name: "Graph", checked: true }),
      ).toBeTruthy();
      fireEvent.click(
        await graphRail.findByTestId("pipeline-graph-node-review"),
      );
      expect(replaceMock).toHaveBeenLastCalledWith("/?rail=graph&step=review", {
        scroll: false,
      });
      await flushAsyncWork();
    });

    test("the header reads the run's Runs-list row", async () => {
      currentRunRow = {
        type: "pipeline",
        id: executionId,
        href: `runs/${executionId}`,
        title: "Checkout crashes when applying a coupon",
        whatRan: { kind: "pipeline", id: executionId, name: "Quality gate" },
        workItem: null,
        status: "done",
        statusLine: "done",
        outcome: null,
        openNodeIds: [],
        waitingOnYou: false,
        waitingOn: [],
        startedBy: { kind: "user", userId, username: "tester" },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const view = renderDetailView();

      await waitFor(() => {
        expect(view.getByTestId("run-header-caption").textContent).toContain(
          "3 steps so far · started by you",
        );
      });
      expect(
        view.getByRole("link", { name: /^← Runs/ }).getAttribute("href"),
      ).toBe("/tester/demo/runs");
      await flushAsyncWork();
    });
  });

  describe("polling", () => {
    const withManualTimers = async (
      body: (
        tick: () => Promise<void>,
        hasTick: () => boolean,
      ) => Promise<void>,
    ) => {
      const originalSetTimeout = globalThis.setTimeout;
      const originalClearTimeout = globalThis.clearTimeout;
      const scheduled: Array<() => void | Promise<void>> = [];
      globalThis.setTimeout = ((callback: TimerHandler) => {
        if (typeof callback === "function") {
          scheduled.push(callback as () => void | Promise<void>);
        }
        return scheduled.length as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof globalThis.setTimeout;
      globalThis.clearTimeout = () => undefined;
      const tick = async () => {
        const pending = scheduled.splice(0, scheduled.length);
        expect(pending.length).toBeGreaterThan(0);
        await act(async () => {
          for (const callback of pending) {
            await callback();
          }
        });
        await flushAsyncWork();
      };
      try {
        await body(tick, () => scheduled.length > 0);
      } finally {
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
      }
    };

    test("polls while the run is live and stops once it and every visit task are terminal", async () => {
      currentExecution = buildExecution("running");

      await withManualTimers(async (tick, hasTick) => {
        renderDetailView();
        await flushAsyncWork();
        expect(getExecutionMock).toHaveBeenCalledTimes(1);
        expect(getDefinitionMock).toHaveBeenCalledTimes(1);

        await tick();
        expect(getExecutionMock).toHaveBeenCalledTimes(2);
        expect(hasTick()).toBe(true);

        currentExecution = buildExecution("succeeded");
        await tick();
        expect(getExecutionMock).toHaveBeenCalledTimes(3);
        expect(hasTick()).toBe(false);
        expect(getDefinitionMock).toHaveBeenCalledTimes(1);
      });
    });

    test("keeps polling when the run reports terminal before a visit's task does", async () => {
      currentExecution = buildExecution("running");

      await withManualTimers(async (tick, hasTick) => {
        renderDetailView();
        await flushAsyncWork();

        currentExecution = buildExecution("succeeded", {
          reviewTaskStatus: "running",
        });
        await tick();
        expect(getExecutionMock).toHaveBeenCalledTimes(2);
        expect(hasTick()).toBe(true);

        currentExecution = buildExecution("succeeded");
        await tick();
        expect(getExecutionMock).toHaveBeenCalledTimes(3);
        expect(hasTick()).toBe(false);
      });
    });
  });

  describe("step message box", () => {
    const messageInput = (view: ReturnType<typeof render>) =>
      view.getByLabelText("Message to this step") as HTMLTextAreaElement;
    const sendButton = (view: ReturnType<typeof render>) =>
      view.getByRole("button", {
        name: "Send & re-run from here",
      }) as HTMLButtonElement;

    beforeEach(() => {
      currentSearchParamsString = "step=review";
      currentPathname = `/tester/demo/runs/${executionId}`;
    });

    test("posts the message to the selected visit and clears the box", async () => {
      const view = renderDetailView(WRITER);

      await waitFor(() => {
        expect(messageInput(view).disabled).toBe(false);
      });
      fireEvent.change(messageInput(view), {
        target: { value: "Use the v2 API" },
      });
      fireEvent.click(sendButton(view));

      await waitFor(() => {
        expect(postMessageMock).toHaveBeenCalledTimes(1);
      });
      expect(messageVisitId).toBe(reviewVisitId);
      expect(messageBody).toEqual({ body: "Use the v2 API" });
      await waitFor(() => {
        expect(messageInput(view).value).toBe("");
      });
      await flushAsyncWork();
    });

    test("is hidden without executions:write", async () => {
      const view = renderDetailView();

      await waitFor(() => {
        expect(getTaskMock).toHaveBeenCalled();
      });
      await flushAsyncWork();

      expect(view.queryByLabelText("Message to this step")).toBeNull();
    });

    test("is disabled while the visit's task is running", async () => {
      currentExecution = buildExecution("running");

      const view = renderDetailView(WRITER);

      await waitFor(() => {
        expect(view.getByText("Waiting for this step to finish")).toBeTruthy();
      });
      expect(messageInput(view).disabled).toBe(true);
      expect(sendButton(view).disabled).toBe(true);
      await flushAsyncWork();
    });

    test("shows the server's 422 detail and keeps the text", async () => {
      messageResponse = () => ({
        data: null,
        error: {
          value: {
            status: 422,
            detail: "Cannot message this visit: the run still has live work",
          },
        },
      });

      const view = renderDetailView(WRITER);

      await waitFor(() => {
        expect(messageInput(view).disabled).toBe(false);
      });
      fireEvent.change(messageInput(view), {
        target: { value: "Use the v2 API" },
      });
      fireEvent.click(sendButton(view));

      await waitFor(() => {
        expect(
          view.getByText(
            "Cannot message this visit: the run still has live work",
          ),
        ).toBeTruthy();
      });
      expect(messageInput(view).value).toBe("Use the v2 API");
      await flushAsyncWork();
    });

    test("quoting selected agent text sends it as quoteText and clears the quote", async () => {
      logLines = conversationLines([
        { kind: "message", id: "m2", role: "assistant", createdMs: 2 },
        {
          kind: "text",
          messageId: "m2",
          partId: "p2",
          role: "assistant",
          text: "The v1 client is deprecated.",
        },
      ]);
      const rangePrototype = dom.window.Range.prototype as unknown as {
        getBoundingClientRect?: () => DOMRect;
      };
      const originalRect = rangePrototype.getBoundingClientRect;
      rangePrototype.getBoundingClientRect = () =>
        ({ top: 100, left: 100, width: 50, height: 16 }) as DOMRect;
      try {
        const view = renderDetailView(WRITER);

        const narration = await waitFor(() =>
          view.getByText("The v1 client is deprecated."),
        );
        await waitFor(() => {
          expect(messageInput(view).disabled).toBe(false);
        });
        const textNode = narration.firstChild;
        if (!textNode) throw new Error("Expected narration text");
        const range = document.createRange();
        range.setStart(textNode, 4);
        range.setEnd(textNode, 13);
        act(() => {
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
          document.dispatchEvent(new window.Event("selectionchange"));
        });
        fireEvent.click(view.getByRole("button", { name: "Quote" }));

        await waitFor(() => {
          expect(
            view.getByRole("button", { name: "Remove quote" }),
          ).toBeTruthy();
        });
        expect(view.getByTestId("composer-quote").textContent).toBe(
          "v1 client",
        );

        fireEvent.change(messageInput(view), {
          target: { value: "Use the v2 API" },
        });
        fireEvent.keyDown(messageInput(view), { key: "Enter", metaKey: true });

        await waitFor(() => {
          expect(postMessageMock).toHaveBeenCalledTimes(1);
        });
        expect(messageBody).toEqual({
          body: "Use the v2 API",
          quoteText: "v1 client",
        });
        await waitFor(() => {
          expect(
            view.queryByRole("button", { name: "Remove quote" }),
          ).toBeNull();
        });
        await flushAsyncWork();
      } finally {
        rangePrototype.getBoundingClientRect = originalRect;
        window.getSelection()?.removeAllRanges();
      }
    });

    test("the consequence line names the steps the send re-runs", async () => {
      const view = renderDetailView(WRITER);

      await waitFor(() => {
        expect(messageInput(view).disabled).toBe(false);
      });
      fireEvent.change(messageInput(view), { target: { value: "Go" } });
      expect(view.getByText("Re-runs Review")).toBeTruthy();
      await flushAsyncWork();
    });
  });

  describe("step conversation", () => {
    const COMMENTER = ["comments:create"];
    const replyInput = (view: ReturnType<typeof render>) =>
      view.getByLabelText("Message Review") as HTMLTextAreaElement;

    beforeEach(() => {
      currentExecution = buildRunExecution({
        id: executionId,
        runStatus: "waiting",
        status: "waiting",
        visits: [
          buildVisit({
            id: reviewVisitId,
            nodeId: "review",
            status: "waiting",
            tasks: [buildVisitTask({ taskId, status: "yielded" })],
            conversationId: parseUuidV7(conversationId),
          }),
        ],
      });
      threadResponse = () => ({
        visitId: reviewVisitId,
        nodeId: "review",
        runs: [buildThreadRun({ status: "yielded" })],
      });
      currentSearchParamsString = "step=review";
      currentPathname = `/tester/demo/runs/${executionId}`;
    });

    test("shows the conversation with its attempts collapsed under it", async () => {
      const view = renderDetailView(COMMENTER);

      await waitFor(() => {
        expect(view.getByText("SAML only, or SAML and OIDC?")).toBeTruthy();
      });
      expect(view.getByText("Attempts")).toBeTruthy();
      expect(view.getByText("Run 1")).toBeTruthy();
      expect(getLogsMock).not.toHaveBeenCalled();
      await flushAsyncWork();
    });

    test("Show work opens that attempt's transcript", async () => {
      const view = renderDetailView(COMMENTER);

      await waitFor(() => {
        expect(view.getByRole("button", { name: "Show work" })).toBeTruthy();
      });
      fireEvent.click(view.getByRole("button", { name: "Show work" }));

      await waitFor(() => {
        expect(getLogsMock).toHaveBeenCalledWith(taskId);
      });
      await flushAsyncWork();
    });

    test("a reply goes to the conversation with only comments:create", async () => {
      const view = renderDetailView(COMMENTER);

      await waitFor(() => {
        expect(replyInput(view).disabled).toBe(false);
      });
      expect(view.queryByLabelText("Message to this step")).toBeNull();
      fireEvent.change(replyInput(view), { target: { value: "Both, please" } });
      fireEvent.click(view.getByRole("button", { name: "Send reply" }));

      await waitFor(() => {
        expect(postConversationMessageMock).toHaveBeenCalledTimes(1);
      });
      expect(conversationMessageBodies).toEqual([{ body: "Both, please" }]);
      expect(postMessageMock).not.toHaveBeenCalled();
      expect(postCommentMock).not.toHaveBeenCalled();
      await waitFor(() => {
        expect(replyInput(view).value).toBe("");
      });
      await flushAsyncWork();
    });

    test("without comments:create there's no reply box", async () => {
      const view = renderDetailView(WRITER);

      await waitFor(() => {
        expect(view.getByText("SAML only, or SAML and OIDC?")).toBeTruthy();
      });
      expect(view.queryByLabelText("Message Review")).toBeNull();
      await flushAsyncWork();
    });
  });

  describe("overrule", () => {
    const when = { path: "result.ok", op: "equal", value: true };
    const shipOrFix = (): PipelineVersionContract => {
      const version = buildRunVersion();
      return {
        ...version,
        definition: {
          ...version.definition,
          nodes: {
            ...(version.definition["nodes"] as Record<string, unknown>),
            review: {
              kind: "step",
              step: "review",
              title: "Review",
              next: {
                routes: [{ when, to: "approve", label: "Ship it" }],
                otherwise: { to: "stop", label: "Fix it" },
                overridable: true,
              },
            },
            stop: { kind: "fail", title: "Stopped" },
          },
        },
      };
    };
    const fanOut = (): PipelineVersionContract => {
      const version = shipOrFix();
      return {
        ...version,
        definition: {
          ...version.definition,
          nodes: {
            ...(version.definition["nodes"] as Record<string, unknown>),
            review: {
              kind: "step",
              step: "review",
              title: "Review",
              next: {
                match: "all",
                routes: [
                  { to: "approve" },
                  { when, to: "approve", label: "Audit" },
                  { when, to: "approve", label: "Notify" },
                ],
                overridable: true,
              },
            },
          },
        },
      };
    };
    const withReviewRouting = (
      execution: PipelineExecutionContract,
      taken: { kind: "route" | "otherwise"; index: number }[],
    ): PipelineExecutionContract => ({
      ...execution,
      visits: execution.visits.map((visit) =>
        visit.id === reviewVisitId
          ? {
              ...visit,
              routing: {
                checked: [
                  {
                    index: 0,
                    when: {
                      kind: "compare",
                      result: true,
                      left: { path: "result.ok", value: true },
                      op: "equal",
                      right: { value: true },
                    },
                    matched: true,
                  },
                ],
                taken,
                overrules: [],
              },
            }
          : visit,
      ),
    });
    const previewOf = (started: string[]) => ({
      data: {
        preview: {
          superseded: [
            { visitId: approveVisitId, nodeId: "approve", status: "succeeded" },
          ],
          cancelledTasks: 0,
          lanesAdded: [],
          lanesRemoved: [],
          mergesRerun: [],
          started,
          reopensRun: false,
          missing: [],
        },
      },
      error: null,
    });
    const body = () => within(document.body);
    const overruleDialog = () =>
      within(body().getByRole("dialog", { name: /Overrule the route/ }));

    async function openDialogFromDrawer(view: ReturnType<typeof render>) {
      await waitFor(() => {
        expect(view.getByRole("button", { name: "Overrule…" })).toBeTruthy();
      });
      fireEvent.click(view.getByRole("button", { name: "Overrule…" }));
      await waitFor(() => {
        expect(
          body().getByRole("dialog", { name: /Overrule the route/ }),
        ).toBeTruthy();
      });
    }

    beforeEach(() => {
      currentVersion = shipOrFix;
      currentExecution = withReviewRouting(buildExecution(), [
        { kind: "route", index: 0 },
      ]);
      currentSearchParamsString = `step=review&details=${reviewVisitId}`;
      routeResponse = (request) =>
        request["preview"] === true
          ? previewOf(["stop"])
          : { data: currentExecution, error: null };
    });

    test("the Route section shows the route taken and the condition checked", async () => {
      const view = renderDetailView(WRITER);

      await waitFor(() => {
        expect(view.getByRole("heading", { name: "Route" })).toBeTruthy();
      });
      expect(view.getByText("Took Ship it")).toBeTruthy();
      expect(view.getByText(/Ship it: result\.ok/)).toBeTruthy();
      await flushAsyncWork();
    });

    test("under match first, previews the chosen route and posts the overrule with the reason", async () => {
      const view = renderDetailView(WRITER);
      await openDialogFromDrawer(view);

      expect(routeMock).not.toHaveBeenCalled();
      fireEvent.click(overruleDialog().getByRole("radio", { name: /Fix it/ }));
      await waitFor(() => {
        expect(
          overruleDialog().getByTestId("overrule-preview").textContent,
        ).toBe("Supersedes 1 visit, starts Stopped");
      });
      expect(routeCalls).toEqual([
        {
          visitId: reviewVisitId,
          body: {
            routes: [{ kind: "otherwise" }],
            reason: "Preview",
            acceptMissing: false,
            preview: true,
          },
        },
      ]);
      const confirm = overruleDialog().getByRole("button", {
        name: "Overrule",
      });
      expect((confirm as HTMLButtonElement).disabled).toBe(true);
      fireEvent.change(overruleDialog().getByLabelText(/Reason/), {
        target: { value: "  The tests were flaky  " },
      });
      fireEvent.click(confirm);

      await waitFor(() => {
        expect(routeCalls).toHaveLength(2);
      });
      expect(routeCalls[1]?.body).toEqual({
        routes: [{ kind: "otherwise" }],
        reason: "The tests were flaky",
        acceptMissing: false,
        preview: false,
      });
      await waitFor(() => {
        expect(getExecutionMock).toHaveBeenCalledTimes(2);
      });
      await waitFor(() => {
        expect(
          body().queryByRole("dialog", { name: /Overrule the route/ }),
        ).toBeNull();
      });
      await flushAsyncWork();
    });

    test("under match all, ticks routes, updates the preview and posts the full set", async () => {
      currentVersion = fanOut;
      currentExecution = withReviewRouting(buildExecution(), [
        { kind: "route", index: 0 },
        { kind: "route", index: 1 },
      ]);
      routeResponse = (request) => {
        if (request["preview"] !== true) {
          return { data: currentExecution, error: null };
        }
        const routes = request["routes"] as unknown[];
        return previewOf(routes.length === 3 ? ["approve"] : []);
      };
      const view = renderDetailView(WRITER);
      await openDialogFromDrawer(view);

      const always = overruleDialog().getByRole("checkbox", {
        name: /Always taken/,
      });
      expect((always as HTMLInputElement).checked).toBe(true);
      expect((always as HTMLInputElement).disabled).toBe(true);
      fireEvent.click(
        overruleDialog().getByRole("checkbox", { name: /Notify/ }),
      );
      await waitFor(() => {
        expect(
          overruleDialog().getByTestId("overrule-preview").textContent,
        ).toBe("Supersedes 1 visit, starts approve");
      });
      fireEvent.click(
        overruleDialog().getByRole("checkbox", { name: /Audit/ }),
      );
      await waitFor(() => {
        expect(
          overruleDialog().getByTestId("overrule-preview").textContent,
        ).toBe("Supersedes 1 visit");
      });
      fireEvent.change(overruleDialog().getByLabelText(/Reason/), {
        target: { value: "Notify instead" },
      });
      fireEvent.click(
        overruleDialog().getByRole("button", { name: "Overrule" }),
      );

      await waitFor(() => {
        expect(routeCalls.at(-1)?.body["preview"]).toBe(false);
      });
      expect(routeCalls.at(-1)?.body).toEqual({
        routes: [
          { kind: "route", index: 0 },
          { kind: "route", index: 2 },
        ],
        reason: "Notify instead",
        acceptMissing: false,
        preview: false,
      });
      await flushAsyncWork();
    });

    test("lists missing args and posts acceptMissing once the person continues without them", async () => {
      routeResponse = (request) => {
        if (request["acceptMissing"] !== true) {
          const problem = {
            status: 422,
            detail: "The new route is missing args",
            code: "PIPELINE_RUN_ROUTE_ARGS_MISSING",
            meta: {
              missing: [{ arg: "plan", reference: "steps.review.result.plan" }],
            },
          };
          return { data: null, error: { status: 422, value: problem } };
        }
        return request["preview"] === true
          ? previewOf(["stop"])
          : { data: currentExecution, error: null };
      };
      const view = renderDetailView(WRITER);
      await openDialogFromDrawer(view);

      fireEvent.click(overruleDialog().getByRole("radio", { name: /Fix it/ }));
      await waitFor(() => {
        expect(overruleDialog().getByText("plan")).toBeTruthy();
      });
      expect(
        overruleDialog().getByText("The new route is missing args"),
      ).toBeTruthy();
      fireEvent.click(
        overruleDialog().getByRole("checkbox", {
          name: "Continue without them",
        }),
      );
      await waitFor(() => {
        expect(overruleDialog().getByTestId("overrule-preview")).toBeTruthy();
      });
      fireEvent.change(overruleDialog().getByLabelText(/Reason/), {
        target: { value: "Plan isn't needed" },
      });
      fireEvent.click(
        overruleDialog().getByRole("button", { name: "Overrule" }),
      );

      await waitFor(() => {
        expect(routeCalls.at(-1)?.body["preview"]).toBe(false);
      });
      expect(routeCalls.at(-1)?.body["acceptMissing"]).toBe(true);
      await flushAsyncWork();
    });

    test("has no Overrule button when no route is overridable", async () => {
      currentVersion = buildRunVersion;
      const view = renderDetailView(WRITER);

      await waitFor(() => {
        expect(view.getByRole("heading", { name: "Route" })).toBeTruthy();
      });
      expect(view.queryByRole("button", { name: "Overrule…" })).toBeNull();
      await flushAsyncWork();
    });

    test("has no Overrule button without executions:write", async () => {
      const view = renderDetailView();

      await waitFor(() => {
        expect(view.getByRole("heading", { name: "Route" })).toBeTruthy();
      });
      expect(view.queryByRole("button", { name: "Overrule…" })).toBeNull();
      await flushAsyncWork();
    });

    test("a run that ended at a fail node by an overridable rule offers to overrule it", async () => {
      const stopVisitId = "019e9a92-b432-73e8-9341-3519156fa713";
      const base = withReviewRouting(buildExecution(), [
        { kind: "otherwise", index: 0 },
      ]);
      const review = base.visits.find((visit) => visit.id === reviewVisitId);
      if (!review) throw new Error("review visit missing");
      currentExecution = {
        ...base,
        runStatus: "failed",
        status: "failed",
        endNodeId: "stop",
        visits: [
          review,
          buildVisit({
            id: stopVisitId,
            nodeId: "stop",
            nodeKind: "fail",
            fromVisitId: review.id,
            transition: { kind: "otherwise", index: 0 },
            status: "failed",
            createdAt: "2026-06-05T12:00:11.000Z",
          }),
        ],
      };
      currentSearchParamsString = "";
      const view = renderDetailView(WRITER);

      await waitFor(() => {
        expect(view.getByText("Ended at Stopped by rule.")).toBeTruthy();
      });
      fireEvent.click(view.getByRole("button", { name: "Overrule…" }));
      await waitFor(() => {
        expect(
          body().getByRole("dialog", { name: "Overrule the route of Review" }),
        ).toBeTruthy();
      });
      await flushAsyncWork();
    });
  });
});
