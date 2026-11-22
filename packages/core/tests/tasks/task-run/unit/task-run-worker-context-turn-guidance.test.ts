import { describe, expect } from "bun:test";
import { buildTurnGuidancePromptLines } from "@/tasks/task-run/application/task-run-worker-context-turn-guidance";
import { concurrentTest } from "tests/utils";

describe("buildTurnGuidancePromptLines", () => {
  concurrentTest("is left out when no turns remain", () => {
    expect(
      buildTurnGuidancePromptLines({
        turnsRemaining: 0,
        isConversationStep: false,
      }),
    ).toEqual([]);
    expect(
      buildTurnGuidancePromptLines({
        turnsRemaining: 0,
        isConversationStep: true,
      }),
    ).toEqual([]);
  });

  concurrentTest("is left out outside a run", () => {
    expect(
      buildTurnGuidancePromptLines({
        turnsRemaining: null,
        isConversationStep: false,
      }),
    ).toEqual([]);
  });

  concurrentTest(
    "tells the agent to submit when done, or end its turn to hand back",
    () => {
      const text = buildTurnGuidancePromptLines({
        turnsRemaining: 2,
        isConversationStep: false,
      }).join("\n");

      expect(text).toContain("If you're done, submit your findings.");
      expect(text).toContain(
        "end your turn: your final message is sent to them and you continue in this conversation when they reply.",
      );
      expect(text).toContain(
        "Ask only when the answer changes what you'd do and you can't find it in the repo, the work item or its comments.",
      );
      expect(text).toContain("You can hand back 2 more times.");
      expect(text).not.toContain("scarn-ask");
    },
  );

  concurrentTest("uses the singular for one turn", () => {
    expect(
      buildTurnGuidancePromptLines({
        turnsRemaining: 1,
        isConversationStep: false,
      }).join("\n"),
    ).toContain("You can hand back 1 more time.");
  });

  concurrentTest("tells a conversation step there are no findings", () => {
    const text = buildTurnGuidancePromptLines({
      turnsRemaining: 3,
      isConversationStep: true,
    }).join("\n");

    expect(text).toContain(
      "This step is a conversation; there are no findings to submit.",
    );
    expect(text).toContain("call `scarn-end-conversation`");
    expect(text).not.toContain("submit your findings");
  });

  concurrentTest(
    "tells a conversation step its closing message is the work item's summary",
    () => {
      const text = buildTurnGuidancePromptLines({
        turnsRemaining: 3,
        isConversationStep: true,
      }).join("\n");

      expect(text).toContain(
        "That message is posted on the work item as its summary",
      );
      expect(text).toContain("what was decided and with whom");
      expect(text).toContain("links to the branch or pull request");
    },
  );
});
