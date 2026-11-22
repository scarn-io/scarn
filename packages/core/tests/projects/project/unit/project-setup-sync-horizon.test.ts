import { expect, test } from "bun:test";
import { setUpProjectInputSchema } from "@scarn/core/projects/project/contracts/project-setup-contracts";

test("project setup accepts a bounded first issue sync", () => {
  const result = setUpProjectInputSchema.safeParse({
    name: "API",
    description: null,
    gitUrl: "https://github.com/acme/api.git",
    issueTracker: {
      type: "github_app",
      installationId: "123",
      firstSyncHorizonDays: 7,
    },
  });

  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.data.issueTracker).toMatchObject({ firstSyncHorizonDays: 7 });
  }
});
