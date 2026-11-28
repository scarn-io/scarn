import { describe, expect } from "bun:test";
import {
  buildGrantRequestDecisionText,
  buildGrantsAddedPromptLines,
  GRANTS_ADDED_HEADING,
  UNANSWERED_GRANT_REQUEST_TEXT,
} from "@/tasks/task-run/application/task-run-worker-context-grant-requests";
import {
  buildRestoredSessionMessage,
  NO_ANSWER_TEXT,
} from "@/tasks/task-run/application/task-run-worker-context-conversation";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import type { Grant } from "@/tasks/task/domain/grants";
import { concurrentTest } from "tests/utils";
import { grant } from "tests/tasks/task/grants-test-support";

const decided = (
  requested: Grant[],
  approved: Grant[],
  note: string | null = null,
) => ({ status: "decided" as const, requested, approved, note });

const CLOSE_SECTION =
  "## Work Items: Close Your Work Item\n\nYou may close your work item. Use the `scarn-close-work-item` tool.";

describe("buildGrantRequestDecisionText", () => {
  concurrentTest("approving all lists each grant's prompt section", () => {
    expect(
      buildGrantRequestDecisionText(
        decided([grant("close", "self")], [grant("close", "self")]),
        "alex",
      ),
    ).toBe(
      `alex answered your access request.\n\nGranted:\n\n${CLOSE_SECTION}`,
    );
  });

  concurrentTest("approving some labels names the labels not granted", () => {
    const text = buildGrantRequestDecisionText(
      decided(
        [grant("label", "self", ["b", "c"]), grant("close", "self")],
        [grant("label", "self", ["b"])],
        "Only b for now.",
      ),
      "alex",
    );
    expect(text).toBe(
      [
        "alex answered your access request.",
        "Granted:\n\n## Work Items: Label Your Work Item\n\nYou may add or remove labels on your work item. Use the `scarn-label-work-item` tool.\n\nAllowed labels:\n- `b`\n\nAny other label is rejected.",
        "Not granted: Add or remove labels on your work item, with the label `c`. Close your work item.",
        "Note from alex: Only b for now.",
      ].join("\n\n"),
    );
  });

  concurrentTest("denying shows no Granted section", () => {
    expect(
      buildGrantRequestDecisionText(
        decided([grant("close", "self")], [], "Not this time."),
        "alex",
      ),
    ).toBe(
      "alex answered your access request.\n\nNot granted: Close your work item.\n\nNote from alex: Not this time.",
    );
  });

  concurrentTest("omits the note line when there is no note", () => {
    expect(
      buildGrantRequestDecisionText(
        decided([grant("close", "self")], []),
        "alex",
      ),
    ).not.toContain("Note from");
  });

  concurrentTest("an unanswered request says nothing was granted", () => {
    expect(
      buildGrantRequestDecisionText(
        {
          status: "unanswered",
          requested: [grant("close", "self")],
          approved: null,
          note: null,
        },
        "alex",
      ),
    ).toBe(UNANSWERED_GRANT_REQUEST_TEXT);
  });

  concurrentTest("a pending or withdrawn request has no text", () => {
    for (const status of ["pending", "withdrawn"] as const) {
      expect(
        buildGrantRequestDecisionText(
          { status, requested: [], approved: null, note: null },
          "alex",
        ),
      ).toBeNull();
    }
  });
});

describe("buildGrantsAddedPromptLines", () => {
  concurrentTest("is empty with no decided request", () => {
    expect(buildGrantsAddedPromptLines([])).toEqual([]);
  });

  concurrentTest("lists each decision under the heading", () => {
    expect(buildGrantsAddedPromptLines(["first", "second"])).toEqual([
      GRANTS_ADDED_HEADING,
      "",
      "first",
      "",
      "second",
      "",
    ]);
  });
});

describe("buildRestoredSessionMessage with a grant decision", () => {
  const decisionMessage = {
    authorKind: "system" as const,
    author: "alex",
    body: "alex approved all 1 requested grants",
    grantRequestId: createUuidV7(),
  };

  concurrentTest(
    "sends the decision and skips its linked system message",
    () => {
      expect(
        buildRestoredSessionMessage([decisionMessage], "Decision text"),
      ).toBe("Decision text");
    },
  );

  concurrentTest("puts the decision before any replies", () => {
    expect(
      buildRestoredSessionMessage(
        [
          decisionMessage,
          { authorKind: "person", author: "alex", body: "Go on." },
        ],
        "Decision text",
      ),
    ).toBe("Decision text\n\nReply from alex: Go on.");
  });

  concurrentTest(
    "a continue without a reply still adds the no-answer text",
    () => {
      expect(
        buildRestoredSessionMessage(
          [{ authorKind: "system", author: "alex", body: "continued" }],
          UNANSWERED_GRANT_REQUEST_TEXT,
        ),
      ).toBe(`${UNANSWERED_GRANT_REQUEST_TEXT}\n\n${NO_ANSWER_TEXT}`);
    },
  );
});
