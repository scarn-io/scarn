import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  WorkItemCommentContract,
  WorkItemQuestionContract,
} from "@scarn/api/frontend-contracts";
import { installDom } from "@/tests/support/install-dom";

type ApiResult = { data: unknown; error: unknown };

let postCommentResult: ApiResult = { data: null, error: null };
const postCommentMock = mock((body: Record<string, unknown>) => {
  void body;
  return Promise.resolve(postCommentResult);
});

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: { "work-item-comments": { post: postCommentMock } },
  }),
}));

// One JSDOM for the whole file, installed before React DOM loads: React DOM
// decides at import time whether the DOM can emit `input` events, so typing
// into the reply box only reaches React state this way.
const dom = installDom({ url: "https://app.scarn.io/" });
Object.assign(globalThis, {
  location: dom.window.location,
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
const { WorkItemCommentItem } = await import("./work-item-comment-item");

const buildComment = (
  overrides: Partial<Record<keyof WorkItemCommentContract, unknown>> = {},
): WorkItemCommentContract =>
  ({
    id: "01966a2c-9494-7db5-aa46-0f8f5cbbe801",
    workItemId: "01966a2c-9494-7db5-aa46-0f8f5cbbe001",
    authorUserId: "01966a2c-9494-7db5-aa46-0f8f5cbbe101",
    authorKind: "user",
    authoredByTaskId: null,
    authorName: null,
    authorUsername: "pam-beesly",
    authorImage: null,
    body: "A publicly readable comment",
    parentCommentId: null,
    isPinned: false,
    createdAt: "2026-04-26T12:00:00.000Z",
    updatedAt: "2026-04-26T12:00:00.000Z",
    ...overrides,
  }) as WorkItemCommentContract;

describe("WorkItemCommentItem", () => {
  beforeEach(() => {
    postCommentResult = { data: null, error: null };
    postCommentMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  test("a member author sees the pin toggle and the manage menu", () => {
    const view = render(
      <WorkItemCommentItem
        comment={buildComment()}
        canManage
        canPin
        onChanged={mock(() => {})}
        onDeleted={mock(() => {})}
      />,
    );

    expect(view.getByRole("button", { name: "Pin comment" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Comment actions" })).toBeTruthy();
  });

  test("a non-member viewer (issue #150) sees neither the pin toggle nor the manage menu", () => {
    const view = render(
      <WorkItemCommentItem
        comment={buildComment()}
        canManage={false}
        canPin={false}
        onChanged={mock(() => {})}
        onDeleted={mock(() => {})}
      />,
    );

    expect(view.queryByRole("button", { name: "Pin comment" })).toBeNull();
    expect(view.queryByRole("button", { name: "Unpin comment" })).toBeNull();
    expect(view.queryByRole("button", { name: "Comment actions" })).toBeNull();
  });

  test("a member non-author sees the pin toggle but not the manage menu", () => {
    const view = render(
      <WorkItemCommentItem
        comment={buildComment()}
        canManage={false}
        canPin
        onChanged={mock(() => {})}
        onDeleted={mock(() => {})}
      />,
    );

    expect(view.getByRole("button", { name: "Pin comment" })).toBeTruthy();
    expect(view.queryByRole("button", { name: "Comment actions" })).toBeNull();
  });

  test("an agent summary comment shows its author name and an agent chip", () => {
    const view = render(
      <WorkItemCommentItem
        comment={buildComment({
          authorKind: "agent",
          authorUserId: null,
          authorUsername: null,
          authorName: "Triage agent",
        })}
        canManage={false}
        canPin
        onChanged={mock(() => {})}
        onDeleted={mock(() => {})}
      />,
    );

    expect(view.getByText("Triage agent")).toBeTruthy();
    expect(view.getByText("agent")).toBeTruthy();
  });

  test("an agent Task's comment links its author name to the Task", () => {
    const view = render(
      <WorkItemCommentItem
        comment={buildComment({
          authorKind: "agent",
          authorUserId: null,
          authorUsername: null,
          authoredByTaskId: "01966a2c-9494-7db5-aa46-0f8f5cbbe701",
          authorName: "Triage agent",
        })}
        authorHref="/alice/demo/runs/tasks/01966a2c-9494-7db5-aa46-0f8f5cbbe701"
        canManage={false}
        canPin
        onChanged={mock(() => {})}
        onDeleted={mock(() => {})}
      />,
    );

    expect(
      view.getByRole("link", { name: "Triage agent" }).getAttribute("href"),
    ).toBe("/alice/demo/runs/tasks/01966a2c-9494-7db5-aa46-0f8f5cbbe701");
  });

  test("an agent comment whose Task is gone falls back to Scarn, unlinked", () => {
    const view = render(
      <WorkItemCommentItem
        comment={buildComment({
          authorKind: "agent",
          authorUserId: null,
          authorUsername: null,
        })}
        canManage={false}
        canPin
        onChanged={mock(() => {})}
        onDeleted={mock(() => {})}
      />,
    );

    expect(view.getByText("Scarn")).toBeTruthy();
    expect(view.queryByRole("link")).toBeNull();
  });

  test("a person's comment has no agent chip", () => {
    const view = render(
      <WorkItemCommentItem
        comment={buildComment()}
        canManage={false}
        canPin
        onChanged={mock(() => {})}
        onDeleted={mock(() => {})}
      />,
    );

    expect(view.queryByText("agent")).toBeNull();
  });

  describe("a question comment", () => {
    const buildQuestion = (
      status: WorkItemQuestionContract["status"],
    ): WorkItemQuestionContract =>
      ({
        questionId: "01966a2c-9494-7db5-aa46-0f8f5cbbe920",
        commentId: "01966a2c-9494-7db5-aa46-0f8f5cbbe801",
        visitId: "01966a2c-9494-7db5-aa46-0f8f5cbbe921",
        pipelineExecutionId: "01966a2c-9494-7db5-aa46-0f8f5cbbe922",
        status,
      }) as WorkItemQuestionContract;

    test.each([
      ["open", "Waiting for reply"],
      ["answered", "Answered"],
      ["not_needed", "No longer needed"],
    ] as const)("status %s reads %s", (status, label) => {
      const view = render(
        <WorkItemCommentItem
          comment={buildComment({ authorKind: "agent" })}
          canManage={false}
          canPin
          question={buildQuestion(status)}
          onChanged={mock(() => {})}
          onDeleted={mock(() => {})}
        />,
      );

      expect(view.getByText(label)).toBeTruthy();
      expect(view.getByText("Scarn")).toBeTruthy();
    });

    test("an open question hides edit and delete, even for its manager", () => {
      const view = render(
        <WorkItemCommentItem
          comment={buildComment({ authorKind: "agent" })}
          canManage
          canPin
          question={buildQuestion("open")}
          onChanged={mock(() => {})}
          onDeleted={mock(() => {})}
        />,
      );

      expect(
        view.queryByRole("button", { name: "Comment actions" }),
      ).toBeNull();
    });

    test("a settled question gets the manage menu back", () => {
      const view = render(
        <WorkItemCommentItem
          comment={buildComment({ authorKind: "agent" })}
          canManage
          canPin
          question={buildQuestion("answered")}
          onChanged={mock(() => {})}
          onDeleted={mock(() => {})}
        />,
      );

      expect(
        view.getByRole("button", { name: "Comment actions" }),
      ).toBeTruthy();
    });

    test("Send reply posts the trimmed reply with parentCommentId and hands it back", async () => {
      const reply = buildComment({
        id: "01966a2c-9494-7db5-aa46-0f8f5cbbe913",
        body: "Production, on Tuesday",
        parentCommentId: "01966a2c-9494-7db5-aa46-0f8f5cbbe801",
      });
      postCommentResult = { data: reply, error: null };
      const onReplied = mock((posted: WorkItemCommentContract) => {
        void posted;
      });
      const view = render(
        <WorkItemCommentItem
          comment={buildComment({ authorKind: "agent" })}
          canManage={false}
          canPin
          question={buildQuestion("open")}
          onReplied={onReplied}
          onChanged={mock(() => {})}
          onDeleted={mock(() => {})}
        />,
      );

      const replyBox = view.getByLabelText("Reply to question");
      expect(replyBox.getAttribute("placeholder")).toBe(
        "Reply to this comment…",
      );
      fireEvent.change(replyBox, {
        target: { value: "  Production, on Tuesday  " },
      });
      fireEvent.click(view.getByRole("button", { name: "Send reply" }));

      await waitFor(() => {
        expect(onReplied).toHaveBeenCalledWith(reply);
      });
      expect(postCommentMock).toHaveBeenCalledWith({
        workItemId: "01966a2c-9494-7db5-aa46-0f8f5cbbe001",
        body: "Production, on Tuesday",
        parentCommentId: "01966a2c-9494-7db5-aa46-0f8f5cbbe801",
      });
    });

    test("a failed reply shows the error and keeps the text", async () => {
      postCommentResult = {
        data: null,
        error: { status: 422, value: { message: "Nope" } },
      };
      const onReplied = mock(() => {});
      const view = render(
        <WorkItemCommentItem
          comment={buildComment({ authorKind: "agent" })}
          canManage={false}
          canPin
          question={buildQuestion("open")}
          onReplied={onReplied}
          onChanged={mock(() => {})}
          onDeleted={mock(() => {})}
        />,
      );

      fireEvent.change(view.getByLabelText("Reply to question"), {
        target: { value: "Staging" },
      });
      fireEvent.click(view.getByRole("button", { name: "Send reply" }));

      await waitFor(() => {
        expect(view.getByRole("alert")).toBeTruthy();
      });
      expect(onReplied).not.toHaveBeenCalled();
      expect(
        (view.getByLabelText("Reply to question") as HTMLTextAreaElement).value,
      ).toBe("Staging");
    });

    test("only an agent comment gets a reply box", () => {
      const view = render(
        <WorkItemCommentItem
          comment={buildComment({ authorKind: "user" })}
          canManage={false}
          canPin
          question={buildQuestion("open")}
          onReplied={mock(() => {})}
          onChanged={mock(() => {})}
          onDeleted={mock(() => {})}
        />,
      );

      expect(view.queryByRole("button", { name: "Send reply" })).toBeNull();
    });
  });
});
