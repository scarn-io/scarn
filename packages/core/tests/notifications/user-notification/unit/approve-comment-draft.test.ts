import { describe, expect } from "bun:test";
import { deriveJiraProjectKey } from "@/notifications/user-notification/application/comment-draft/approve-comment-draft";
import { concurrentTest } from "tests/utils";

/**
 * `deriveJiraProjectKey` is pure string logic (Decision 2 in
 * `docs/plans/jira-comment-approval.md`), kept separate from the
 * integration-resolution flow specifically so it can be unit-tested in
 * isolation here rather than only indirectly through
 * `work-item-comment-draft.approve-jira*.test.ts`.
 */
describe("deriveJiraProjectKey", () => {
  concurrentTest("splits a simple key on its dash", () => {
    expect(deriveJiraProjectKey("PROJ-123")).toBe("PROJ");
  });

  concurrentTest(
    "splits on the LAST dash when the project key itself contains dashes",
    () => {
      expect(deriveJiraProjectKey("MY-PROJ-45")).toBe("MY-PROJ");
    },
  );

  concurrentTest(
    "returns the input unchanged when there is no dash to split on",
    () => {
      expect(deriveJiraProjectKey("NODASH")).toBe("NODASH");
    },
  );
});
