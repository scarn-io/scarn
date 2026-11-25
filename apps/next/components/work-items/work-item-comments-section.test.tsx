import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import type {
  PendingCommentDraftContract,
  WorkItemCommentContract,
  WorkItemContract,
  WorkItemQuestionContract,
} from "@scarn/api/frontend-contracts";
import { installDom } from "@/tests/support/install-dom";

let mockSession: {
  user: {
    id: string;
    image: string | null;
    username: string | null;
    name: string | null;
  };
} | null = null;

type ApiResult = { data: unknown; error: unknown };

// Mutable per-test response bodies for the two list endpoints
// `WorkItemCommentsSection` reads (`use-work-item-comments.ts`,
// `use-pending-comment-drafts.ts`), reset in `beforeEach`.
let commentsListResult: ApiResult = { data: [], error: null };
let draftsListResult: ApiResult = { data: [], error: null };
let postCommentResult: ApiResult = { data: null, error: null };
const postCommentMock = mock((body: Record<string, unknown>) => {
  void body;
  return Promise.resolve(postCommentResult);
});

void mock.module("@/app/_lib/auth-client", () => ({
  authClient: { useSession: () => ({ data: mockSession }) },
}));

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      "work-item-comments": {
        get: () => Promise.resolve(commentsListResult),
        post: postCommentMock,
      },
      "work-item-comment-drafts": {
        get: () => Promise.resolve(draftsListResult),
      },
    },
  }),
}));

const { WorkItemCommentsSection } =
  await import("./work-item-comments-section");
const { ProjectRouteProvider } =
  await import("@/components/project-route-context");

const workItem = {
  id: "01966a2c-9494-7db5-aa46-0f8f5cbbe001",
  title: "Investigate flaky test",
  description: "Repro steps go here.",
  platform: "github",
  createdByUserId: null,
  fields: {},
} as WorkItemContract;

const buildPendingDraft = (
  overrides: Partial<PendingCommentDraftContract> = {},
): PendingCommentDraftContract =>
  ({
    notification: {
      id: "01966a2c-9494-7db5-aa46-0f8f5cbbe801",
      projectId: "01966a2c-9494-7db5-aa46-0f8f5cbbe000",
      workItemId: workItem.id,
      pipelineExecutionId: null,
      taskId: null,
      agentSessionId: "01966a2c-9494-7db5-aa46-0f8f5cbbe701",
      kind: "status_update",
      audience: "assignee",
      title: "Draft reply",
      body: "Pending draft body text",
      priority: "normal",
      source: "agent",
      status: "pending",
      payloadJson: null,
      createdAt: "2026-04-26T12:00:00.000Z",
      updatedAt: "2026-04-26T12:00:00.000Z",
    },
    lastError: null,
    ...overrides,
  }) as PendingCommentDraftContract;

const buildSettledComment = (
  overrides: Partial<Record<keyof WorkItemCommentContract, unknown>> = {},
): WorkItemCommentContract =>
  ({
    id: "01966a2c-9494-7db5-aa46-0f8f5cbbe902",
    authoredByTaskId: null,
    authorName: null,
    projectId: "01966a2c-9494-7db5-aa46-0f8f5cbbe000",
    workItemId: workItem.id,
    authorUserId: "01966a2c-9494-7db5-aa46-0f8f5cbbe101",
    authorKind: "user",
    agentSessionId: null,
    sourceNotificationId: null,
    externalCommentId: null,
    externalCommentUrl: null,
    authorUsername: "pam-beesly",
    authorImage: null,
    body: "Settled comment text",
    parentCommentId: null,
    isPinned: false,
    createdAt: "2026-04-26T12:10:00.000Z",
    updatedAt: "2026-04-26T12:10:00.000Z",
    ...overrides,
  }) as WorkItemCommentContract;

const member = {
  user: {
    id: "user-1",
    image: null,
    username: "pam-beesly",
    name: "Pam Beesly",
  },
};

const noQuestions: ReadonlyMap<string, WorkItemQuestionContract> = new Map();

const renderSection = (
  isMember: boolean,
  permissions: string[] = [],
  {
    questionsByCommentId = noQuestions,
    onPinnedCountChange,
  }: {
    questionsByCommentId?: ReadonlyMap<string, WorkItemQuestionContract>;
    onPinnedCountChange?: (count: number) => void;
  } = {},
) =>
  render(
    <ProjectRouteProvider
      username="tester"
      projectSlug="demo"
      projectId="01966a2c-9494-7db5-aa46-0f8f5cbbe000"
      isMember={isMember}
      permissions={permissions}
    >
      <WorkItemCommentsSection
        workItem={workItem}
        questionsByCommentId={questionsByCommentId}
        onPinnedCountChange={onPinnedCountChange}
      />
    </ProjectRouteProvider>,
  );

describe("WorkItemCommentsSection", () => {
  beforeEach(() => {
    installDom({ url: "https://app.scarn.io/" });

    Object.assign(globalThis, {
      // jsdom implements neither; MUI's multiline TextField (TextareaAutosize)
      // needs both to mount/unmount without throwing.
      requestAnimationFrame: (cb: FrameRequestCallback) =>
        setTimeout(() => {
          cb(Date.now());
        }, 0) as unknown as number,
      cancelAnimationFrame: (id: number) => {
        clearTimeout(id);
      },
    });

    mockSession = null;
    commentsListResult = { data: [], error: null };
    draftsListResult = { data: [], error: null };
    postCommentResult = { data: null, error: null };
    postCommentMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  test("hides the reply composer for a non-member viewer (issue #150)", async () => {
    const view = renderSection(false);

    await waitFor(() => {
      expect(
        view.getByText(
          "No replies yet. Add one below to start building context for the agent.",
        ),
      ).toBeTruthy();
    });

    expect(view.queryByPlaceholderText("Add a reply…")).toBeNull();
    expect(view.queryByRole("button", { name: "Reply" })).toBeNull();
  });

  test("shows the reply composer for a member viewer", async () => {
    mockSession = member;
    const view = renderSection(true);

    await waitFor(() => {
      expect(view.getByPlaceholderText("Add a reply…")).toBeTruthy();
    });

    expect(view.getByRole("button", { name: "Reply" })).toBeTruthy();
  });

  test("the composer says comments don't answer agents or questions", async () => {
    mockSession = member;
    const view = renderSection(true);

    await waitFor(() => {
      expect(
        view.getByText(
          "Comments don't answer agents or questions — reply in the panel above.",
        ),
      ).toBeTruthy();
    });
  });

  test("reports how many comments are pinned", async () => {
    commentsListResult = {
      data: [
        buildSettledComment({ isPinned: true }),
        buildSettledComment({
          id: "01966a2c-9494-7db5-aa46-0f8f5cbbe903",
          body: "Not pinned",
        }),
      ],
      error: null,
    };
    const onPinned = mock((count: number) => {
      void count;
    });

    renderSection(false, [], { onPinnedCountChange: onPinned });

    await waitFor(() => {
      expect(onPinned).toHaveBeenLastCalledWith(1);
    });
  });

  test("renders a pending draft card when the viewer has work-item-platform-comment:write", async () => {
    mockSession = member;
    draftsListResult = { data: [buildPendingDraft()], error: null };

    const view = renderSection(true, ["work-item-platform-comment:write"]);

    await waitFor(() => {
      expect(view.getByText("Awaiting approval")).toBeTruthy();
    });
  });

  test("does not render a pending draft card without the permission, even though the drafts endpoint would return data", async () => {
    mockSession = member;
    draftsListResult = { data: [buildPendingDraft()], error: null };

    const view = renderSection(true, []);

    await waitFor(() => {
      expect(
        view.getByText(
          "No replies yet. Add one below to start building context for the agent.",
        ),
      ).toBeTruthy();
    });

    expect(view.queryByText("Awaiting approval")).toBeNull();
  });

  test("renders a pending draft above the chronological comment thread (Decision 13)", async () => {
    mockSession = member;
    draftsListResult = { data: [buildPendingDraft()], error: null };
    commentsListResult = { data: [buildSettledComment()], error: null };

    const view = renderSection(true, ["work-item-platform-comment:write"]);

    await waitFor(() => {
      expect(view.getByText("Settled comment text")).toBeTruthy();
    });

    // The draft's body renders inside a live, editable TextField (a
    // `<textarea>`), so its text lives in the DOM as a form value rather
    // than a text node — `getByDisplayValue` is the correct query, unlike
    // the settled comment's body which renders as plain `Typography` text.
    const draftBody = view.getByDisplayValue("Pending draft body text");
    const threadText = view.getByText("Settled comment text");

    expect(
      Boolean(
        draftBody.compareDocumentPosition(threadText) &
        Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
  });

  describe("questions and replies", () => {
    const questionComment = buildSettledComment({
      id: "01966a2c-9494-7db5-aa46-0f8f5cbbe910",
      authorUserId: null,
      authorKind: "agent",
      authorUsername: null,
      body: "Which environment did this fail in?",
      createdAt: "2026-04-26T12:00:00.000Z",
    });
    const laterComment = buildSettledComment({
      id: "01966a2c-9494-7db5-aa46-0f8f5cbbe911",
      body: "Unrelated later comment",
      createdAt: "2026-04-26T12:20:00.000Z",
    });
    const questionsFor = (status: "open" | "answered" | "not_needed") =>
      new Map([
        [
          questionComment.id,
          {
            questionId: "01966a2c-9494-7db5-aa46-0f8f5cbbe920",
            commentId: questionComment.id,
            visitId: "01966a2c-9494-7db5-aa46-0f8f5cbbe921",
            pipelineExecutionId: "01966a2c-9494-7db5-aa46-0f8f5cbbe922",
            status,
            body: questionComment.body,
            askedAt: questionComment.createdAt,
            waitingOnYou: false,
            waitingOn: [],
          } as unknown as WorkItemQuestionContract,
        ],
      ]);

    test("a reply renders under its parent, before later top-level comments", async () => {
      const reply = buildSettledComment({
        id: "01966a2c-9494-7db5-aa46-0f8f5cbbe912",
        body: "Staging",
        parentCommentId: questionComment.id,
        createdAt: "2026-04-26T12:30:00.000Z",
      });
      commentsListResult = {
        data: [questionComment, laterComment, reply],
        error: null,
      };

      const view = renderSection(true);

      await waitFor(() => {
        expect(view.getByText("Staging")).toBeTruthy();
      });
      const replies = view.getByTestId("comment-replies");
      expect(replies.textContent).toContain("Staging");
      const later = view.getByText("Unrelated later comment");
      expect(
        Boolean(
          view.getByText("Staging").compareDocumentPosition(later) &
          Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      ).toBe(true);
    });

    test("an open question shows Waiting for reply, authored by Scarn", async () => {
      mockSession = member;
      commentsListResult = { data: [questionComment], error: null };

      const view = renderSection(true, [], {
        questionsByCommentId: questionsFor("open"),
      });

      await waitFor(() => {
        expect(view.getByText("Waiting for reply")).toBeTruthy();
      });
      expect(view.getByText("Scarn")).toBeTruthy();
      expect(view.getByLabelText("Reply to question")).toBeTruthy();
    });

    test("only a question comment gets a reply box", async () => {
      mockSession = member;
      commentsListResult = {
        data: [questionComment, laterComment],
        error: null,
      };

      const view = renderSection(true, [], {
        questionsByCommentId: questionsFor("answered"),
      });

      await waitFor(() => {
        expect(view.getByText("Answered")).toBeTruthy();
      });
      expect(view.getAllByLabelText("Reply to question")).toHaveLength(1);
      expect(view.getAllByRole("button", { name: "Send reply" })).toHaveLength(
        1,
      );
    });

    test("a non-member sees the question status but no reply box", async () => {
      commentsListResult = { data: [questionComment], error: null };

      const view = renderSection(false, [], {
        questionsByCommentId: questionsFor("open"),
      });

      await waitFor(() => {
        expect(view.getByText("Waiting for reply")).toBeTruthy();
      });
      expect(view.queryByLabelText("Reply to question")).toBeNull();
    });

    test("a question no longer needed still takes a late reply", async () => {
      mockSession = member;
      commentsListResult = { data: [questionComment], error: null };

      const view = renderSection(true, [], {
        questionsByCommentId: questionsFor("not_needed"),
      });

      await waitFor(() => {
        expect(view.getByText("No longer needed")).toBeTruthy();
      });
      expect(view.getByLabelText("Reply to question")).toBeTruthy();
    });
  });
});
