import { describe, expect, test } from "bun:test";
import {
  readWorkItemChanges,
  type WorkItemChange,
} from "@scarn/sdk/contracts/work-item-changes";
import { workItemTestWorkspace } from "./_shared/work-item-test-workspace";
import {
  missingPermissionMessage,
  NO_WORK_ITEM_MESSAGE,
  RECORDED_CHANGE_NOTE,
  recordWorkItemChange,
} from "./_shared/work-item-tool-support";
import {
  buildBlockChange,
  buildCloseChange,
  buildCommentChange,
  buildDescribeChange,
  buildStartTaskChange,
} from "./scarn-work-item-change-tools";

type Build = (input: Record<string, unknown>) => WorkItemChange | string;

const RECORDING_CASES: {
  name: string;
  build: Build;
  input: Record<string, unknown>;
  change: WorkItemChange;
}[] = [
  {
    name: "block",
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
    name: "comment",
    build: buildCommentChange,
    input: { workItemId: "item-a", body: "Hi" },
    change: { kind: "comment", workItemId: "item-a", body: "Hi" },
  },
  {
    name: "close",
    build: buildCloseChange,
    input: { workItemId: "item-a", reason: "completed", resolution: "Done" },
    change: {
      kind: "close",
      workItemId: "item-a",
      reason: "completed",
      resolution: "Done",
    },
  },
  {
    name: "start task",
    build: buildStartTaskChange,
    input: { workItemId: "item-a", stepDefinitionKey: "implement" },
    change: { kind: "startTask", workItemId: "item-a", stepKey: "implement" },
  },
];

describe("work item change tools", () => {
  for (const { name, build, input, change } of RECORDING_CASES) {
    test.concurrent(`records a ${name} change`, async () => {
      const workspacePath = await workItemTestWorkspace({
        workItemPermissions: ["self"],
      });

      expect(
        await recordWorkItemChange(workspacePath, () => build(input)),
      ).toBe(RECORDED_CHANGE_NOTE);
      expect(await readWorkItemChanges(workspacePath)).toEqual([change]);
    });
  }

  test.concurrent("appends changes in call order", async () => {
    const workspacePath = await workItemTestWorkspace();

    for (const { build, input } of RECORDING_CASES) {
      await recordWorkItemChange(workspacePath, () => build(input));
    }

    expect(await readWorkItemChanges(workspacePath)).toEqual(
      RECORDING_CASES.map(({ change }) => change),
    );
  });

  test.concurrent("refuses without the self permission", async () => {
    const workspacePath = await workItemTestWorkspace({
      workItemPermissions: ["children"],
    });

    expect(
      await recordWorkItemChange(workspacePath, () =>
        buildCommentChange({ workItemId: "item-a", body: "Hi" }),
      ),
    ).toBe(missingPermissionMessage("self"));
    expect(await readWorkItemChanges(workspacePath)).toEqual([]);
  });

  test.concurrent("refuses outside a run on a work item", async () => {
    const workspacePath = await workItemTestWorkspace({ workItemId: null });

    expect(
      await recordWorkItemChange(workspacePath, () =>
        buildCommentChange({ workItemId: "item-a", body: "Hi" }),
      ),
    ).toBe(NO_WORK_ITEM_MESSAGE);
  });

  test.concurrent("rejects invalid input without recording", async () => {
    const workspacePath = await workItemTestWorkspace();

    expect(
      await recordWorkItemChange(workspacePath, () =>
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
    expect(buildStartTaskChange({ workItemId: "a" })).toContain(
      "stepDefinitionKey",
    );
  });
});
