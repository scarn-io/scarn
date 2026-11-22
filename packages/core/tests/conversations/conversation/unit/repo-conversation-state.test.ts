import { describe, expect } from "bun:test";
import {
  conversationPreview,
  displayRepository,
  REPO_CONVERSATION_PREVIEW_LENGTH,
  repoConversationError,
  repoConversationState,
  shortCommit,
} from "@/conversations/conversation/domain/repo-conversation-state";
import { concurrentTest } from "tests/utils";

describe("repoConversationState", () => {
  const open = "reply_pending" as const;

  concurrentTest.each([
    ["queued", "queued", "initial", "queued"],
    ["queued", "queued", null, "queued"],
    [
      "a continuation waiting for a slot",
      "waiting_for_concurrency_slot",
      "continuation",
      "queued",
    ],
    ["a queued retry", "queued", "retry", "retry_queued"],
    ["a retry waiting for work", "waiting_for_work", "retry", "retry_queued"],
    ["running", "running", "initial", "running"],
    ["waiting for a reply", "waiting_for_person", "initial", "waiting"],
    ["failed", "failed", "retry", "failed"],
    ["cancelled", "cancelled", "initial", "ended"],
    ["succeeded", "succeeded", "initial", "ended"],
  ] as const)(
    "%s reads as %s",
    (_label, taskStatus, latestRunReason, state) => {
      expect(
        repoConversationState({
          conversationStatus: open,
          taskStatus,
          latestRunReason,
        }),
      ).toBe(state);
    },
  );

  concurrentTest("a closed conversation is ended whatever its Task", () => {
    for (const taskStatus of ["failed", "running", "queued"] as const) {
      expect(
        repoConversationState({
          conversationStatus: "closed",
          taskStatus,
          latestRunReason: "retry",
        }),
      ).toBe("ended");
    }
  });
});

describe("conversationPreview", () => {
  concurrentTest("collapses whitespace onto one line", () => {
    expect(conversationPreview("  How does\n\ncheckout\twork?  ")).toBe(
      "How does checkout work?",
    );
  });

  concurrentTest("keeps a question of exactly the limit whole", () => {
    const body = "a".repeat(REPO_CONVERSATION_PREVIEW_LENGTH);
    expect(conversationPreview(body)).toBe(body);
  });

  concurrentTest("cuts a longer question with an ellipsis", () => {
    const preview = conversationPreview(
      "b".repeat(REPO_CONVERSATION_PREVIEW_LENGTH + 20),
    );
    expect(preview).toHaveLength(REPO_CONVERSATION_PREVIEW_LENGTH);
    expect(preview.endsWith("…")).toBe(true);
  });

  concurrentTest("is empty without a question", () => {
    expect(conversationPreview(null)).toBe("");
  });
});

describe("shortCommit", () => {
  concurrentTest("is the commit's first 12 characters", () => {
    expect(shortCommit("0123456789abcdef0123456789abcdef01234567")).toBe(
      "0123456789ab",
    );
  });

  concurrentTest("is null before the pin", () => {
    expect(shortCommit(null)).toBeNull();
  });
});

describe("displayRepository", () => {
  concurrentTest("strips userinfo from an https URL", () => {
    expect(
      displayRepository(
        "https://x-access-token:secret@github.com/acme/app.git",
      ),
    ).toBe("https://github.com/acme/app.git");
    expect(displayRepository("https://token@github.com/acme/app.git")).toBe(
      "https://github.com/acme/app.git",
    );
  });

  concurrentTest("leaves a URL without userinfo alone", () => {
    expect(displayRepository("https://github.com/acme/app.git")).toBe(
      "https://github.com/acme/app.git",
    );
  });

  concurrentTest("leaves an scp-style URL alone", () => {
    expect(displayRepository("git@github.com:acme/app.git")).toBe(
      "git@github.com:acme/app.git",
    );
  });
});

describe("repoConversationError", () => {
  concurrentTest("a known code gets its fixed message", () => {
    expect(
      repoConversationError({
        status: "failed",
        errorJson: {
          name: "Error",
          code: "REPO_CONTEXT_COMMIT_UNAVAILABLE",
          message: "fatal: reference is not a tree: deadbeef (/home/worker/x)",
        },
      }),
    ).toEqual({
      code: "REPO_CONTEXT_COMMIT_UNAVAILABLE",
      message: "The pinned commit is no longer available",
    });
  });

  concurrentTest("a known error name gets its fixed message", () => {
    expect(
      repoConversationError({ status: "timeout", errorJson: null }),
    ).toEqual({ code: "Scarn.Timeout", message: "The turn timed out" });
    expect(
      repoConversationError({ status: "abandoned", errorJson: null }),
    ).toEqual({
      code: "Scarn.HeartbeatTimeout",
      message: "The worker stopped responding",
    });
  });

  concurrentTest("an unknown code gets the generic message", () => {
    expect(
      repoConversationError({
        status: "failed",
        errorJson: { name: "Scarn.StepFailed", message: "the agent crashed" },
      }),
    ).toEqual({ code: "Scarn.StepFailed", message: "The turn failed" });
    expect(
      repoConversationError({
        status: "failed",
        errorJson: { code: "SOMETHING_NEW", message: "secret details" },
      }),
    ).toEqual({ code: "SOMETHING_NEW", message: "The turn failed" });
  });

  concurrentTest("never leaks the raw message, even through the code", () => {
    const raw = "token ghp_secret leaked at /srv/app";
    const error = repoConversationError({
      status: "failed",
      errorJson: { name: raw, code: raw, message: raw },
    });
    expect(error).toEqual({
      code: "Scarn.StepFailed",
      message: "The turn failed",
    });
    expect(JSON.stringify(error)).not.toContain("secret");
  });

  concurrentTest("a run without a stored error is generic", () => {
    expect(repoConversationError(null)).toEqual({
      code: "Scarn.StepFailed",
      message: "The turn failed",
    });
    expect(
      repoConversationError({ status: "failed", errorJson: "plain text" }),
    ).toEqual({ code: "Scarn.StepFailed", message: "The turn failed" });
  });
});
