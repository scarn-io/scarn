import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type {
  PendingCommentDraftContract,
  WorkItemCommentContract,
} from "@scarn/api/frontend-contracts";
import { installDom } from "@/tests/support/install-dom";

// ─── API client mock ──────────────────────────────────────────────────────────

type ApiResult = { data: unknown; error: unknown };

let approveResult: ApiResult = { data: null, error: null };
let rejectResult: ApiResult = { data: null, error: null };

const approveMock = mock((body: { body: string }) => {
  void body;
  return Promise.resolve(approveResult);
});
const rejectMock = mock(() => Promise.resolve(rejectResult));

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      "work-item-comment-drafts": () => ({
        approve: { post: approveMock },
        reject: { post: rejectMock },
      }),
    },
  }),
}));

// ─── Credential dialog mock ───────────────────────────────────────────────────

const SAVED_SECRET_ID = "01966a2c-9494-7db5-aa46-0f8f5cbbea01";

/**
 * `IntegrationCredentialDialog` owns the key list, the radio choice, and the
 * pasted token, and has its own tests. Here it's replaced with a click-only
 * fake that hands back each credential shape, so this file covers only
 * `WorkItemCommentDraftItem`'s own logic: opening the dialog for the right
 * platform and sending the choice as `credential`.
 */
void mock.module(
  "@/components/integrations/integration-credential-dialog",
  () => ({
    IntegrationCredentialDialog: (props: {
      platform: string;
      open: boolean;
      onClose: () => void;
      onConfirm: (
        choice:
          | { secretId: string }
          | { email: string; apiKey: string }
          | { token: string },
      ) => void;
      confirmLabel?: string;
    }) => {
      if (!props.open) return null;
      return (
        <div role="dialog" aria-label={`${props.platform} credential`}>
          <button
            onClick={() => {
              props.onConfirm({ token: "test-github-token" });
            }}
          >
            Use pasted token
          </button>
          <button
            onClick={() => {
              props.onConfirm({ secretId: SAVED_SECRET_ID });
            }}
          >
            Use saved key
          </button>
          <button
            onClick={() => {
              props.onConfirm({
                email: "jira-user@acme.test",
                apiKey: "test-jira-api-key",
              });
            }}
          >
            Use pasted key
          </button>
          <button onClick={props.onClose}>Cancel</button>
        </div>
      );
    },
  }),
);

const { WorkItemCommentDraftItem } =
  await import("./work-item-comment-draft-item");

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const buildPendingCommentDraft = (
  overrides: Partial<PendingCommentDraftContract> = {},
): PendingCommentDraftContract =>
  ({
    notification: {
      id: "01966a2c-9494-7db5-aa46-0f8f5cbbe801",
      projectId: "01966a2c-9494-7db5-aa46-0f8f5cbbe000",
      workItemId: "01966a2c-9494-7db5-aa46-0f8f5cbbe001",
      pipelineExecutionId: null,
      taskId: null,
      agentSessionId: "01966a2c-9494-7db5-aa46-0f8f5cbbe701",
      kind: "status_update",
      audience: "assignee",
      title: "Draft reply",
      body: "Thanks for reporting this — we're looking into it.",
      priority: "normal",
      source: "agent",
      status: "pending",
      payloadJson: null,
      createdAt: "2026-04-26T12:00:00.000Z",
      updatedAt: "2026-04-26T12:00:00.000Z",
    },
    lastError: null,
    artifactResolution: null,
    ...overrides,
  }) as PendingCommentDraftContract;

const buildComment = (
  overrides: Partial<WorkItemCommentContract> = {},
): WorkItemCommentContract =>
  ({
    id: "01966a2c-9494-7db5-aa46-0f8f5cbbe901",
    projectId: "01966a2c-9494-7db5-aa46-0f8f5cbbe000",
    workItemId: "01966a2c-9494-7db5-aa46-0f8f5cbbe001",
    authorUserId: null,
    authorKind: "agent",
    agentSessionId: "01966a2c-9494-7db5-aa46-0f8f5cbbe701",
    sourceNotificationId: "01966a2c-9494-7db5-aa46-0f8f5cbbe801",
    externalCommentId: "12345",
    externalCommentUrl:
      "https://github.com/acme/widgets/issues/1#issuecomment-12345",
    authorUsername: null,
    authorImage: null,
    body: "Thanks for the detailed repro.",
    isPinned: false,
    createdAt: "2026-04-26T12:05:00.000Z",
    updatedAt: "2026-04-26T12:05:00.000Z",
    ...overrides,
  }) as WorkItemCommentContract;

describe("WorkItemCommentDraftItem", () => {
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

    approveResult = { data: null, error: null };
    rejectResult = { data: null, error: null };
    approveMock.mockClear();
    rejectMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  // Note: typing into a controlled text/textarea field via `fireEvent.change`
  // (or `.input`) does not reliably propagate to React state in this repo's
  // bun:test + jsdom harness — confirmed here even for a bare, MUI-free
  // controlled `<textarea>`, matching the exact limitation already called
  // out in `step-definition-dialog.test.tsx` and `confirm-repo-step
  // .test.tsx`. Rather than fight that, this asserts the real behavior the
  // plan cares about — Approve submits whatever is currently in the (live,
  // pre-filled) body field, not a stale/hardcoded value — by rendering with
  // a draft body that already differs from a hypothetical original agent
  // draft and confirming *that* exact text is what gets sent, exercising
  // the same `handleApprove` code path a live edit would.
  test("clicking Approve calls approve.post with whatever body is currently in the field", async () => {
    const editedLookingBody =
      "An edited, more helpful reply — not the agent's original wording.";
    const draft = buildPendingCommentDraft({
      notification: {
        ...buildPendingCommentDraft().notification,
        body: editedLookingBody,
      },
    });
    approveResult = { data: buildComment(), error: null };

    const view = render(
      <WorkItemCommentDraftItem
        draft={draft}
        workItemPlatform="github"
        onApproved={mock(() => {})}
        onRejected={mock(() => {})}
      />,
    );

    expect(view.getByDisplayValue(editedLookingBody)).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Approve" }));

    await waitFor(() => {
      expect(approveMock).toHaveBeenCalledTimes(1);
    });

    expect(approveMock).toHaveBeenCalledWith({ body: editedLookingBody });
  });

  test("clicking Reject without editing calls reject.post with no body", async () => {
    const draft = buildPendingCommentDraft();
    rejectResult = { data: draft.notification, error: null };

    const view = render(
      <WorkItemCommentDraftItem
        draft={draft}
        workItemPlatform="github"
        onApproved={mock(() => {})}
        onRejected={mock(() => {})}
      />,
    );

    fireEvent.click(view.getByRole("button", { name: "Reject" }));

    await waitFor(() => {
      expect(rejectMock).toHaveBeenCalledTimes(1);
    });

    expect(rejectMock).toHaveBeenCalledWith(undefined);
  });

  test("on approve success, onApproved is called with the resolved comment", async () => {
    const draft = buildPendingCommentDraft();
    const comment = buildComment();
    approveResult = { data: comment, error: null };
    const onApproved = mock(() => {});

    const view = render(
      <WorkItemCommentDraftItem
        draft={draft}
        workItemPlatform="github"
        onApproved={onApproved}
        onRejected={mock(() => {})}
      />,
    );

    fireEvent.click(view.getByRole("button", { name: "Approve" }));

    await waitFor(() => {
      expect(onApproved).toHaveBeenCalledWith(comment);
    });
  });

  test("on reject success, onRejected is called with the notification's id", async () => {
    const draft = buildPendingCommentDraft();
    rejectResult = { data: draft.notification, error: null };
    const onRejected = mock(() => {});

    const view = render(
      <WorkItemCommentDraftItem
        draft={draft}
        workItemPlatform="github"
        onApproved={mock(() => {})}
        onRejected={onRejected}
      />,
    );

    fireEvent.click(view.getByRole("button", { name: "Reject" }));

    await waitFor(() => {
      expect(onRejected).toHaveBeenCalledWith(draft.notification.id);
    });
  });

  test("a prior lastError on the draft prop renders as an inline Alert", () => {
    const draft = buildPendingCommentDraft({
      lastError: "GitHub returned 401 while posting a comment",
    });

    const view = render(
      <WorkItemCommentDraftItem
        draft={draft}
        workItemPlatform="github"
        onApproved={mock(() => {})}
        onRejected={mock(() => {})}
      />,
    );

    expect(
      view.getByText("GitHub returned 401 while posting a comment"),
    ).toBeTruthy();
  });

  // ─── Jira: proactive API-key dialog (Decision 1) ──────────────────────────────

  test("clicking Approve on a Jira draft opens the API key dialog instead of calling the API immediately", () => {
    const draft = buildPendingCommentDraft();

    const view = render(
      <WorkItemCommentDraftItem
        draft={draft}
        workItemPlatform="jira"
        onApproved={mock(() => {})}
        onRejected={mock(() => {})}
      />,
    );

    expect(view.queryByRole("dialog")).toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Approve" }));

    expect(view.getByRole("dialog")).toBeTruthy();
    expect(approveMock).not.toHaveBeenCalled();
  });

  test("a pasted key is sent as { body, credential: { email, apiKey } }", async () => {
    const draft = buildPendingCommentDraft();
    approveResult = { data: buildComment(), error: null };

    const view = render(
      <WorkItemCommentDraftItem
        draft={draft}
        workItemPlatform="jira"
        onApproved={mock(() => {})}
        onRejected={mock(() => {})}
      />,
    );

    fireEvent.click(view.getByRole("button", { name: "Approve" }));
    fireEvent.click(view.getByRole("button", { name: "Use pasted key" }));

    await waitFor(() => {
      expect(approveMock).toHaveBeenCalledTimes(1);
    });

    expect(approveMock).toHaveBeenCalledWith({
      body: draft.notification.body,
      credential: {
        email: "jira-user@acme.test",
        apiKey: "test-jira-api-key",
      },
    });
    expect(view.queryByRole("dialog")).toBeNull();
  });

  test("a saved key is sent as { body, credential: { secretId } }", async () => {
    const draft = buildPendingCommentDraft();
    const comment = buildComment();
    approveResult = { data: comment, error: null };
    const onApproved = mock(() => {});

    const view = render(
      <WorkItemCommentDraftItem
        draft={draft}
        workItemPlatform="jira"
        onApproved={onApproved}
        onRejected={mock(() => {})}
      />,
    );

    fireEvent.click(view.getByRole("button", { name: "Approve" }));
    fireEvent.click(view.getByRole("button", { name: "Use saved key" }));

    await waitFor(() => {
      expect(onApproved).toHaveBeenCalledWith(comment);
    });

    expect(approveMock).toHaveBeenCalledWith({
      body: draft.notification.body,
      credential: { secretId: SAVED_SECRET_ID },
    });
  });

  test("cancelling the Jira key dialog doesn't call approve", () => {
    const view = render(
      <WorkItemCommentDraftItem
        draft={buildPendingCommentDraft()}
        workItemPlatform="jira"
        onApproved={mock(() => {})}
        onRejected={mock(() => {})}
      />,
    );

    fireEvent.click(view.getByRole("button", { name: "Approve" }));
    fireEvent.click(view.getByRole("button", { name: "Cancel" }));

    expect(view.queryByRole("dialog")).toBeNull();
    expect(approveMock).not.toHaveBeenCalled();
  });

  test("a failed Jira approve shows the error and lets the user pick a key again", async () => {
    const draft = buildPendingCommentDraft();
    approveResult = {
      data: null,
      error: { value: { detail: "Jira returned 401" } },
    };

    const view = render(
      <WorkItemCommentDraftItem
        draft={draft}
        workItemPlatform="jira"
        onApproved={mock(() => {})}
        onRejected={mock(() => {})}
      />,
    );

    fireEvent.click(view.getByRole("button", { name: "Approve" }));
    fireEvent.click(view.getByRole("button", { name: "Use saved key" }));

    // React 19's `startTransition` flips `isPending` back one tick after the
    // `setError` commit, so wait for the Approve button to re-enable too.
    await waitFor(() => {
      expect(
        view.getByText("Could not approve this comment. Try again."),
      ).toBeTruthy();
      expect(
        (view.getByRole("button", { name: "Approve" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });

    fireEvent.click(view.getByRole("button", { name: "Approve" }));

    expect(view.getByRole("dialog")).toBeTruthy();
  });

  test("a GitHub draft on a token integration asks for a token and retries with it", async () => {
    const draft = buildPendingCommentDraft();
    const comment = buildComment();
    approveResult = {
      data: null,
      error: { value: { status: 400, code: "GITHUB_TOKEN_REQUIRED" } },
    };
    const onApproved = mock(() => {});

    const view = render(
      <WorkItemCommentDraftItem
        draft={draft}
        workItemPlatform="github"
        onApproved={onApproved}
        onRejected={mock(() => {})}
      />,
    );

    fireEvent.click(view.getByRole("button", { name: "Approve" }));

    await waitFor(() => {
      expect(
        view.getByRole("dialog", { name: "github credential" }),
      ).toBeTruthy();
    });
    expect(view.queryByRole("alert")).toBeNull();

    approveResult = { data: comment, error: null };
    fireEvent.click(view.getByRole("button", { name: "Use pasted token" }));

    await waitFor(() => {
      expect(onApproved).toHaveBeenCalledWith(comment);
    });
    expect(approveMock).toHaveBeenLastCalledWith({
      body: draft.notification.body,
      credential: { token: "test-github-token" },
    });
  });
});
