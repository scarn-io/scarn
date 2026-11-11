import { describe, expect, test } from "bun:test";
import type { Info as ToolInfo } from "@opencode/plugin/promise/tool";
import { readWorkItemChanges } from "@scarn/sdk/contracts/work-item-changes";
import type { Grant } from "./_shared/current-execution";
import {
  ALL_GRANTS,
  grant,
  workItemTestWorkspace,
} from "./_shared/work-item-test-workspace";
import {
  RECORDED_CHANGE_NOTE,
  recordWorkItemChange,
} from "./_shared/work-item-tool-support";
import { SCARN_CREATE_WORK_ITEM_TOOL } from "./scarn-create-work-item";
import { getWorkItem } from "./scarn-get-work-item";
import {
  buildBlockChange,
  buildCommentChange,
  buildLabelChange,
  SCARN_COMMENT_ON_WORK_ITEM_TOOL,
  SCARN_LABEL_WORK_ITEM_TOOL,
} from "./scarn-work-item-change-tools";
import { createWorkItemTools } from "./work-item-tools";

function toolsFor(grants: Grant[]): Map<string, ToolInfo> {
  const tools = createWorkItemTools("/unused", {
    taskRunId: "task-run-1",
    resultSchemaJson: null,
    turnsRemaining: 3,
    workItemId: "item-self",
    grants,
    api: null,
    workItemLinks: null,
  });
  return new Map(tools.map((tool) => [tool.name, tool]));
}

function labelItems(tool: ToolInfo | undefined, property: string): unknown {
  const input = tool?.input as {
    properties: Record<string, { items: unknown }>;
  };
  return input.properties[property]?.items;
}

describe("work item tools follow the grants", () => {
  test("label tool lists the union of label grants as an enum", () => {
    const tool = toolsFor([
      grant("label", "self", ["triage"]),
      grant("label", "children", ["bug", "triage"]),
    ]).get(SCARN_LABEL_WORK_ITEM_TOOL);

    expect(labelItems(tool, "add")).toEqual({
      type: "string",
      enum: ["triage", "bug"],
    });
    expect(labelItems(tool, "remove")).toEqual({
      type: "string",
      enum: ["triage", "bug"],
    });
    expect(tool?.description).toContain(
      "Works on your own work item and your work item's children only.",
    );
    expect(tool?.description).toContain(
      "On your work item's children you may add or remove: bug, triage.",
    );
  });

  test("create tool takes only the create grant's labels", () => {
    const tool = toolsFor([grant("create", "children", ["bug"])]).get(
      SCARN_CREATE_WORK_ITEM_TOOL,
    );

    expect(labelItems(tool, "labels")).toEqual({
      type: "string",
      enum: ["bug"],
    });
    expect(tool?.description).toContain("Labels you may give it: bug.");
  });

  test("a run with no create grant has no create tool", () => {
    const tools = toolsFor(
      ALL_GRANTS.filter((granted) => granted.action !== "create"),
    );

    expect(tools.has(SCARN_CREATE_WORK_ITEM_TOOL)).toBe(false);
  });

  test("a chat run (no work item, no grants) gets no work item tools", () => {
    expect(
      createWorkItemTools("/unused", {
        taskRunId: "task-run-1",
        resultSchemaJson: null,
        turnsRemaining: 3,
        workItemId: null,
        grants: [],
        api: null,
        workItemLinks: null,
      }),
    ).toEqual([]);
  });

  test("descriptions name the scopes granted", () => {
    expect(
      toolsFor([grant("comment", "children")]).get(
        SCARN_COMMENT_ON_WORK_ITEM_TOOL,
      )?.description,
    ).toContain("Works on your work item's children only.");
    expect(
      toolsFor([grant("comment", "self")]).get(SCARN_COMMENT_ON_WORK_ITEM_TOOL)
        ?.description,
    ).toContain("Works on your own work item only.");
  });
});

describe("work item tools refuse what the grants don't cover", () => {
  test.concurrent("refuses the own item without a self grant", async () => {
    const workspacePath = await workItemTestWorkspace({
      grants: [grant("comment", "children")],
    });

    expect(
      await recordWorkItemChange(workspacePath, "comment", () =>
        buildCommentChange({ workItemId: "item-self", body: "Hi" }),
      ),
    ).toBe(
      "This Task may not comment work item item-self: it has no `comment` grant on `self`.",
    );
    expect(
      await recordWorkItemChange(workspacePath, "comment", () =>
        buildCommentChange({ workItemId: "item-child", body: "Hi" }),
      ),
    ).toBe(RECORDED_CHANGE_NOTE);
    expect(await readWorkItemChanges(workspacePath)).toHaveLength(1);
  });

  test.concurrent("refuses another item without a children grant", async () => {
    const workspacePath = await workItemTestWorkspace({
      grants: [grant("comment", "self")],
    });

    expect(
      await recordWorkItemChange(workspacePath, "comment", () =>
        buildCommentChange({ workItemId: "item-child", body: "Hi" }),
      ),
    ).toBe(
      "This Task may not comment work item item-child: it has no `comment` grant on `children`.",
    );
    expect(await readWorkItemChanges(workspacePath)).toEqual([]);
  });

  test.concurrent("refuses labels outside the target's grant", async () => {
    const workspacePath = await workItemTestWorkspace({
      grants: [
        grant("label", "self", ["triage"]),
        grant("label", "children", ["bug"]),
      ],
    });

    expect(
      await recordWorkItemChange(workspacePath, "label", () =>
        buildLabelChange({ workItemId: "item-self", add: ["bug"] }),
      ),
    ).toBe(
      "This Task may not label work item item-self with labels bug: its `label` grant on `self` covers triage.",
    );
    expect(
      await recordWorkItemChange(workspacePath, "label", () =>
        buildLabelChange({ workItemId: "item-child", remove: ["bug"] }),
      ),
    ).toBe(RECORDED_CHANGE_NOTE);
    expect(await readWorkItemChanges(workspacePath)).toHaveLength(1);
  });

  test.concurrent("refuses a block outside the block grant", async () => {
    const workspacePath = await workItemTestWorkspace({
      grants: [grant("block", "children")],
    });

    expect(
      await recordWorkItemChange(workspacePath, "block", () =>
        buildBlockChange({
          blockedWorkItemId: "item-self",
          blockingWorkItemId: "item-child",
        }),
      ),
    ).toContain("no `block` grant on `self`");
    expect(
      await recordWorkItemChange(workspacePath, "block", () =>
        buildBlockChange({
          blockedWorkItemId: "item-child",
          blockingWorkItemId: "item-self",
        }),
      ),
    ).toContain("doesn't cover item-self");
    expect(await readWorkItemChanges(workspacePath)).toEqual([]);
  });

  test.concurrent(
    "refuses reading an item outside the read grant",
    async () => {
      const workspacePath = await workItemTestWorkspace({
        grants: [grant("read", "self")],
      });

      expect(
        await getWorkItem({ workItemId: "item-child" }, workspacePath, fetch),
      ).toBe(
        "This Task may not read work item item-child: it has no `read` grant on `children`.",
      );
    },
  );
});
