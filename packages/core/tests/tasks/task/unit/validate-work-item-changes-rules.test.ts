import { describe, test } from "bun:test";
import {
  WORK_ITEM_CHANGE_NOT_NATIVE,
  WORK_ITEM_CHANGES_INVALID,
} from "@/tasks/task/application/validate-work-item-changes";
import type { WorkItemChange } from "@/tasks/task/contracts/work-item-change-contracts";
import {
  all,
  expectRefused,
  item,
  setup,
  uid,
} from "./validate-work-item-changes-fixtures";

describe("validateWorkItemChanges", () => {
  describe("native items", () => {
    test.concurrent(
      "a synced item can't be described, commented on or closed",
      async () => {
        const root = item({ platform: "github" });
        const { validate } = setup(all("self"), { root });
        for (const change of [
          {
            kind: "describe",
            workItemId: uid(root),
            description: "x",
            descriptionVersion: 1,
          },
          { kind: "comment", workItemId: uid(root), body: "x" },
          { kind: "close", workItemId: uid(root), reason: "completed" },
          { kind: "label", workItemId: uid(root), add: ["bug"] },
        ] as WorkItemChange[]) {
          await expectRefused(validate([change]), WORK_ITEM_CHANGE_NOT_NATIVE);
        }
      },
    );

    test.concurrent("a synced item can't be blocked", async () => {
      const root = item();
      const synced = item({ parent: uid(root), platform: "github" });
      const native = item({ parent: uid(root) });
      const { validate } = setup(all("children"), {
        root,
        items: [synced, native],
      });
      await expectRefused(
        validate([
          {
            kind: "block",
            blockedWorkItemId: uid(synced),
            blockingWorkItemId: uid(native),
          },
        ]),
        WORK_ITEM_CHANGE_NOT_NATIVE,
      );
    });
  });

  describe("labels", () => {
    test.concurrent(
      "a Task may label its own item and its children",
      async () => {
        const root = item();
        const child = item({ parent: uid(root) });
        const { validate } = setup([...all("self"), ...all("children")], {
          root,
          items: [child],
        });
        await validate([
          { kind: "label", workItemId: uid(root), add: ["a"], remove: ["b"] },
          {
            kind: "label",
            workItemId: uid(child),
            remove: ["wayfinder:research"],
          },
        ]);
      },
    );

    test.concurrent("a label change must add or remove something", async () => {
      const { root, validate } = setup(all("self"));
      await expectRefused(
        validate([{ kind: "label", workItemId: uid(root), add: [] }]),
        WORK_ITEM_CHANGES_INVALID,
        /add or remove/,
      );
    });
  });

  describe("description versions", () => {
    test.concurrent("a write naming a stale version is refused", async () => {
      const root = item({ descriptionVersion: 4 });
      const { validate } = setup(all("self"), { root });
      await expectRefused(
        validate([
          {
            kind: "describe",
            workItemId: uid(root),
            description: "x",
            descriptionVersion: 3,
          },
        ]),
        WORK_ITEM_CHANGES_INVALID,
        /version 4, not 3/,
      );
    });

    test.concurrent(
      "a second write in the run names the version the first made",
      async () => {
        const root = item({ descriptionVersion: 2 });
        const { validate } = setup(all("self"), { root });
        await validate([
          {
            kind: "describe",
            workItemId: uid(root),
            description: "a",
            descriptionVersion: 2,
          },
          {
            kind: "describe",
            workItemId: uid(root),
            description: "b",
            descriptionVersion: 3,
          },
        ]);
        await expectRefused(
          validate([
            {
              kind: "describe",
              workItemId: uid(root),
              description: "a",
              descriptionVersion: 2,
            },
            {
              kind: "describe",
              workItemId: uid(root),
              description: "b",
              descriptionVersion: 2,
            },
          ]),
          WORK_ITEM_CHANGES_INVALID,
        );
      },
    );
  });

  test.concurrent(
    "a write that leaves the description unchanged doesn't move the version",
    async () => {
      const { root, validate } = setup(all("self"));
      await validate([
        {
          kind: "describe",
          workItemId: uid(root),
          description: "Same",
          descriptionVersion: 1,
        },
        {
          kind: "describe",
          workItemId: uid(root),
          description: "Same",
          descriptionVersion: 2,
        },
        {
          kind: "describe",
          workItemId: uid(root),
          description: "Same",
          descriptionVersion: 2,
        },
      ]);
    },
  );

  test.concurrent("closing an item twice is refused", async () => {
    const root = item({ state: "closed" });
    const { validate } = setup(all("self"), { root });
    await expectRefused(
      validate([{ kind: "close", workItemId: uid(root), reason: "completed" }]),
      WORK_ITEM_CHANGES_INVALID,
      /already closed/,
    );
  });
});
