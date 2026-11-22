import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import type { NodeVisitContract } from "@scarn/api/frontend-contracts";
import {
  buildRunVersion,
  buildVisit,
} from "./execution-detail-view.test-helpers";
import type { WaitControls } from "./use-wait-controls";
import { installDom } from "@/tests/support/install-dom";

const VISIT_ID = "019e0000-0000-7000-8000-000000000a01";
const QUESTION_ID = "019e0000-0000-7000-8000-000000000a02";
const COMMENT_ID = "019e0000-0000-7000-8000-000000000a03";
const WORK_ITEM_ID = "019e0000-0000-7000-8000-000000000a04";
const PROJECT_ID = "019e0000-0000-7000-8000-000000000a05";

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      "work-item-comments": {
        get: () =>
          Promise.resolve({
            data: [{ id: COMMENT_ID, body: "Which browser was it?" }],
            error: null,
          }),
      },
    },
  }),
}));

const dom = installDom();
Object.assign(globalThis, {
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: (cb: FrameRequestCallback) =>
    setTimeout(() => {
      cb(Date.now());
    }, 0),
  cancelAnimationFrame: (id: number) => {
    clearTimeout(id);
  },
});

const { cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { ProjectRouteProvider } =
  await import("@/components/project-route-context");
const { WaitVisitPanel } = await import("./wait-visit-panel");

const decideMock = mock(() => Promise.resolve(true));
const answerMock = mock(() => Promise.resolve(true));
const continueMock = mock(() => Promise.resolve(true));

const definition = (): Record<string, unknown> => {
  const document = buildRunVersion().definition;
  return {
    ...document,
    nodes: {
      ...(document["nodes"] as Record<string, unknown>),
      approve: {
        kind: "wait",
        for: "decision",
        title: "Ship the fix?",
        actions: [
          { key: "approve", label: "Approve", body: "optional" },
          { key: "revise", label: "Request changes", body: "required" },
        ],
        next: {
          routes: [
            {
              when: { path: "result.action", op: "equal", value: "approve" },
              to: "deploy",
            },
            {
              when: { path: "result.action", op: "equal", value: "revise" },
              to: "review",
            },
          ],
        },
      },
      ask: { kind: "wait", for: "reply", next: { routes: [{ to: "triage" }] } },
    },
  };
};

const controls = (overrides: Partial<WaitControls> = {}): WaitControls => ({
  waiters: { waitingOnYou: true, names: ["tester"] },
  definition: definition(),
  pending: false,
  decide: decideMock,
  answer: answerMock,
  continueWithoutReply: continueMock,
  ...overrides,
});

const decisionVisit = buildVisit({
  id: VISIT_ID,
  nodeId: "approve",
  nodeKind: "wait",
  status: "waiting",
  waitFor: "decision",
  actions: [
    { key: "approve", label: "Approve", body: "optional" },
    { key: "revise", label: "Request changes", body: "required" },
  ],
});

const replyVisit = buildVisit({
  id: VISIT_ID,
  nodeId: "ask",
  nodeKind: "wait",
  status: "waiting",
  waitFor: "reply",
  questions: [
    {
      questionId: parseUuidV7(QUESTION_ID),
      commentId: parseUuidV7(COMMENT_ID),
      status: "open",
    },
  ],
});

const renderPane = (visit: NodeVisitContract, waitControls: WaitControls) =>
  render(
    <ProjectRouteProvider
      username="tester"
      projectSlug="demo"
      projectId={PROJECT_ID}
      isMember
      permissions={[]}
    >
      <WaitVisitPanel
        visit={visit}
        workItemId={WORK_ITEM_ID}
        controls={waitControls}
        onOpenDetails={() => {}}
      />
    </ProjectRouteProvider>,
  );

describe("WaitVisitPanel", () => {
  beforeEach(() => {
    decideMock.mockClear();
    answerMock.mockClear();
    continueMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  test("a decision quotes the node and offers one button per action naming where it goes", async () => {
    const view = renderPane(decisionVisit, controls());

    expect(view.getByText("Your decision")).toBeTruthy();
    expect(view.getByText("Ship the fix?")).toBeTruthy();
    expect(view.getByRole("button", { name: "Approve → deploy" })).toBeTruthy();
    const revise = view.getByRole("button", {
      name: "Request changes → review",
    });
    expect(revise.hasAttribute("disabled")).toBe(true);

    fireEvent.change(
      view.getByLabelText("Add a note (needed to Request changes)"),
      { target: { value: " Handle retries " } },
    );
    fireEvent.click(revise);
    await waitFor(() => {
      expect(decideMock).toHaveBeenCalledTimes(1);
    });
    expect(decideMock.mock.calls[0]).toEqual([
      VISIT_ID,
      "revise",
      "Handle retries",
      "Request changes — the run goes on to review",
    ] as never);
  });

  test("a reply wait quotes the question, answers it, or continues without a reply", async () => {
    const view = renderPane(replyVisit, controls());

    await waitFor(() => {
      expect(view.getByText("Which browser was it?")).toBeTruthy();
    });
    expect(view.getByText("Your reply")).toBeTruthy();
    const send = view.getByRole("button", { name: "Send answer" });
    expect(send.hasAttribute("disabled")).toBe(true);

    fireEvent.change(
      view.getByLabelText(
        "Answer here, or leave it for a reply on the work item",
      ),
      { target: { value: "Firefox" } },
    );
    fireEvent.click(send);
    await waitFor(() => {
      expect(answerMock).toHaveBeenCalledTimes(1);
    });
    expect(answerMock.mock.calls[0]).toEqual([
      QUESTION_ID,
      "Firefox",
      "Answer sent — the run goes on to triage",
    ] as never);

    fireEvent.click(
      view.getByRole("button", { name: "Continue without reply" }),
    );
    await waitFor(() => {
      expect(continueMock).toHaveBeenCalledTimes(1);
    });
    expect(continueMock.mock.calls[0]).toEqual([
      QUESTION_ID,
      "Continued without a reply",
    ] as never);
  });

  test("when the run waits on someone else it names them and still offers the answer", () => {
    const view = renderPane(
      decisionVisit,
      controls({ waiters: { waitingOnYou: false, names: ["bob"] } }),
    );

    expect(view.getByText("Waiting for a decision")).toBeTruthy();
    expect(
      view.getByText("Waiting on bob — you can still answer"),
    ).toBeTruthy();
    expect(view.getByRole("button", { name: "Approve → deploy" })).toBeTruthy();
  });

  test("without the permission there is nothing to answer with", () => {
    const view = renderPane(
      replyVisit,
      controls({
        waiters: { waitingOnYou: false, names: ["bob"] },
        answer: null,
        continueWithoutReply: null,
      }),
    );

    expect(view.queryByRole("button", { name: "Send answer" })).toBeNull();
    expect(view.queryByText(/you can still answer/)).toBeNull();
    expect(view.getByText(/permission to answer/)).toBeTruthy();
  });
});
