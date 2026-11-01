import { describe, expect, test } from "bun:test";
import {
  MAX_WORK_ITEMS_CREATED_PER_RUN,
  readWorkItemChanges,
} from "@scarn/sdk/contracts/work-item-changes";
import { workItemTestWorkspace } from "./_shared/work-item-test-workspace";
import {
  missingPermissionMessage,
  NO_WORK_ITEM_MESSAGE,
} from "./_shared/work-item-tool-support";
import {
  CREATE_LIMIT_REACHED_MESSAGE,
  createWorkItem,
} from "./scarn-create-work-item";

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("createWorkItem", () => {
  test.concurrent(
    "records a create change and returns the generated UUIDv7",
    async () => {
      const workspacePath = await workItemTestWorkspace();

      const output = JSON.parse(
        await createWorkItem(
          {
            title: "Child",
            description: "Do it",
            fields: { size: "s" },
            blockedBy: ["item-other"],
          },
          workspacePath,
        ),
      ) as { workItemId: string };

      expect(output.workItemId).toMatch(UUID_V7);
      expect(await readWorkItemChanges(workspacePath)).toEqual([
        {
          kind: "create",
          workItemId: output.workItemId,
          title: "Child",
          description: "Do it",
          fields: { size: "s" },
          blockedBy: ["item-other"],
        },
      ]);
    },
  );

  test.concurrent("omits absent optional fields", async () => {
    const workspacePath = await workItemTestWorkspace();

    await createWorkItem({ title: "Child", description: "" }, workspacePath);

    const [change] = await readWorkItemChanges(workspacePath);
    expect(Object.keys(change ?? {}).sort()).toEqual([
      "description",
      "kind",
      "title",
      "workItemId",
    ]);
  });

  test.concurrent("refuses past the per-run limit", async () => {
    const workspacePath = await workItemTestWorkspace();
    for (let index = 0; index < MAX_WORK_ITEMS_CREATED_PER_RUN; index++) {
      await createWorkItem(
        { title: `Child ${String(index)}`, description: "" },
        workspacePath,
      );
    }

    expect(
      await createWorkItem(
        { title: "One more", description: "" },
        workspacePath,
      ),
    ).toBe(CREATE_LIMIT_REACHED_MESSAGE);
    expect(await readWorkItemChanges(workspacePath)).toHaveLength(
      MAX_WORK_ITEMS_CREATED_PER_RUN,
    );
  });

  test.concurrent("refuses without the children permission", async () => {
    const workspacePath = await workItemTestWorkspace({
      workItemPermissions: ["self"],
    });

    expect(
      await createWorkItem({ title: "Child", description: "" }, workspacePath),
    ).toBe(missingPermissionMessage("children"));
    expect(await readWorkItemChanges(workspacePath)).toEqual([]);
  });

  test.concurrent("refuses outside a run on a work item", async () => {
    const workspacePath = await workItemTestWorkspace({ workItemId: null });

    expect(
      await createWorkItem({ title: "Child", description: "" }, workspacePath),
    ).toBe(NO_WORK_ITEM_MESSAGE);
  });

  test.concurrent("rejects an empty title without recording", async () => {
    const workspacePath = await workItemTestWorkspace();

    expect(
      await createWorkItem({ title: " ", description: "" }, workspacePath),
    ).toContain("Invalid input");
    expect(await readWorkItemChanges(workspacePath)).toEqual([]);
  });
});
