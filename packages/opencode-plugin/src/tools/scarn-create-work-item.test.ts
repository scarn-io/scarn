import { describe, expect, test } from "bun:test";
import {
  MAX_WORK_ITEMS_CREATED_PER_RUN,
  readWorkItemChanges,
} from "@scarn/sdk/contracts/work-item-changes";
import {
  grant,
  workItemTestWorkspace,
} from "./_shared/work-item-test-workspace";
import {
  missingGrantMessage,
  NO_WORK_ITEM_MESSAGE,
} from "./_shared/work-item-tool-support";
import {
  CREATE_LIMIT_REACHED_MESSAGE,
  CREATED_WORK_ITEM_NOTE,
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
            labels: ["bug"],
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
          labels: ["bug"],
          blockedBy: ["item-other"],
        },
      ]);
    },
  );

  test.concurrent(
    "returns the new item's web page url and a note on linking it",
    async () => {
      const workspacePath = await workItemTestWorkspace({
        workItemLinks: {
          appBaseUrl: "https://app.test/",
          projectPath: "acme/web",
        },
      });

      const output = JSON.parse(
        await createWorkItem(
          { title: "Child", description: "" },
          workspacePath,
        ),
      ) as { workItemId: string; url: string; note: string };

      expect(output.url).toBe(
        `https://app.test/acme/web/work-items/${output.workItemId}`,
      );
      expect(output.note).toBe(CREATED_WORK_ITEM_NOTE);
      expect(output.note).toContain("[title](url)");
    },
  );

  test.concurrent("returns a null url without work item links", async () => {
    const workspacePath = await workItemTestWorkspace();

    const output = JSON.parse(
      await createWorkItem({ title: "Child", description: "" }, workspacePath),
    ) as { url: unknown };

    expect(output.url).toBeNull();
  });

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

  test.concurrent("refuses without a create grant", async () => {
    const workspacePath = await workItemTestWorkspace({
      grants: [grant("read", "self"), grant("update", "children")],
    });

    expect(
      await createWorkItem({ title: "Child", description: "" }, workspacePath),
    ).toBe(missingGrantMessage("create"));
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

  test.concurrent("rejects labels that are not strings", async () => {
    const workspacePath = await workItemTestWorkspace();

    expect(
      await createWorkItem(
        { title: "Child", description: "", labels: ["bug", 3] },
        workspacePath,
      ),
    ).toContain("`labels`");
    expect(await readWorkItemChanges(workspacePath)).toEqual([]);
  });
});
