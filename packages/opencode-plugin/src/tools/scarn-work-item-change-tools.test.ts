import { describe, expect, test } from "bun:test";
import {
  readWorkItemChanges,
  type WorkItemChange,
} from "@scarn/sdk/contracts/work-item-changes";
import type { GrantAction } from "./_shared/current-execution";
import {
  grant,
  workItemTestWorkspace,
} from "./_shared/work-item-test-workspace";
import {
  missingGrantMessage,
  NO_WORK_ITEM_MESSAGE,
  RECORDED_CHANGE_NOTE,
  recordWorkItemChange,
} from "./_shared/work-item-tool-support";
import {
  buildBlockChange,
  buildCloseChange,
  buildCommentChange,
  buildDescribeChange,
  buildLabelChange,
} from "./scarn-work-item-change-tools";

type Build = (input: Record<string, unknown>) => WorkItemChange | string;

const RECORDING_CASES: {
  name: string;
  action: GrantAction;
  build: Build;
  input: Record<string, unknown>;
  change: WorkItemChange;
}[] = [
  {
    name: "block",
    action: "block",
    build: buildBlockChange,
    input: { blockedWorkItemId: "item-a", blockingWorkItemId: "item-b" },
    change: {
      kind: "block",
      blockedWorkItemId: "item-a",
      blockingWorkItemId: "item-b",
    },
  },
  {
    name: "unblock",
    action: "block",
    build: buildBlockChange,
    input: {
      blockedWorkItemId: "item-a",
      blockingWorkItemId: "item-b",
      remove: true,
    },
    change: {
      kind: "block",
      blockedWorkItemId: "item-a",
      blockingWorkItemId: "item-b",
      remove: true,
    },
  },
  {
    name: "describe",
    action: "update",
    build: buildDescribeChange,
    input: { workItemId: "item-a", description: "New", descriptionVersion: 2 },
    change: {
      kind: "describe",
      workItemId: "item-a",
      description: "New",
      descriptionVersion: 2,
    },
  },
  {
    name: "label",
    action: "label",
    build: buildLabelChange,
    input: { workItemId: "item-a", add: ["bug", "ui"], remove: ["triage"] },
    change: {
      kind: "label",
      workItemId: "item-a",
      add: ["bug", "ui"],
      remove: ["triage"],
    },
  },
  {
    name: "comment",
    action: "comment",
    build: buildCommentChange,
    input: { workItemId: "item-a", body: "Hi" },
    change: { kind: "comment", workItemId: "item-a", body: "Hi" },
  },
  {
    name: "close",
    action: "close",
    build: buildCloseChange,
    input: { workItemId: "item-a", reason: "completed", resolution: "Done" },
    change: {
      kind: "close",
      workItemId: "item-a",
      reason: "completed",
      resolution: "Done",
    },
  },
];

describe("work item change tools", () => {
  for (const { name, action, build, input, change } of RECORDING_CASES) {
    test.concurrent(`records a ${name} change`, async () => {
      const workspacePath = await workItemTestWorkspace({
        grants: [grant(action, "children")],
      });

      expect(
        await recordWorkItemChange(workspacePath, action, () => build(input)),
      ).toBe(RECORDED_CHANGE_NOTE);
      expect(await readWorkItemChanges(workspacePath)).toEqual([change]);
    });
  }

  test.concurrent("appends changes in call order", async () => {
    const workspacePath = await workItemTestWorkspace();

    for (const { action, build, input } of RECORDING_CASES) {
      await recordWorkItemChange(workspacePath, action, () => build(input));
    }

    expect(await readWorkItemChanges(workspacePath)).toEqual(
      RECORDING_CASES.map(({ change }) => change),
    );
  });

  test.concurrent("refuses without a grant for the action", async () => {
    const workspacePath = await workItemTestWorkspace({
      grants: [grant("read", "self"), grant("close", "children")],
    });

    expect(
      await recordWorkItemChange(workspacePath, "comment", () =>
        buildCommentChange({ workItemId: "item-a", body: "Hi" }),
      ),
    ).toBe(missingGrantMessage("comment"));
    expect(await readWorkItemChanges(workspacePath)).toEqual([]);
  });

  test.concurrent("refuses outside a run on a work item", async () => {
    const workspacePath = await workItemTestWorkspace({ workItemId: null });

    expect(
      await recordWorkItemChange(workspacePath, "comment", () =>
        buildCommentChange({ workItemId: "item-a", body: "Hi" }),
      ),
    ).toBe(NO_WORK_ITEM_MESSAGE);
  });

  test.concurrent("rejects invalid input without recording", async () => {
    const workspacePath = await workItemTestWorkspace();

    expect(
      await recordWorkItemChange(workspacePath, "close", () =>
        buildCloseChange({ workItemId: "item-a", reason: "bored" }),
      ),
    ).toContain("Invalid input");
    expect(await readWorkItemChanges(workspacePath)).toEqual([]);
  });

  test("validates each input", () => {
    expect(
      buildBlockChange({ blockedWorkItemId: "a", blockingWorkItemId: "a" }),
    ).toContain("cannot block itself");
    expect(
      buildDescribeChange({
        workItemId: "a",
        description: "x",
        descriptionVersion: 0,
      }),
    ).toContain("descriptionVersion");
    expect(buildCommentChange({ workItemId: "a", body: "" })).toContain("body");
    expect(buildLabelChange({ workItemId: "a" })).toContain("at least one");
    expect(buildLabelChange({ workItemId: "a", add: ["ok", ""] })).toContain(
      "`add`",
    );
    expect(buildLabelChange({ workItemId: "a", remove: "bug" })).toContain(
      "`remove`",
    );
    expect(buildLabelChange({ workItemId: "a", add: ["bug"] })).toEqual({
      kind: "label",
      workItemId: "a",
      add: ["bug"],
    });
  });
});
