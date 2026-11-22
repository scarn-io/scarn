import { describe, test } from "bun:test";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { WORK_ITEM_CHANGES_INVALID } from "@/tasks/task/application/validate-work-item-changes";
import type { WorkItemChange } from "@/tasks/task/contracts/work-item-change-contracts";
import {
  all,
  expectRefused,
  grant,
  item,
  setup,
  uid,
} from "./validate-work-item-changes-fixtures";

describe("validateWorkItemChanges", () => {
  describe("grants", () => {
    test.concurrent(
      "grants on self allow updating, commenting on and closing its own item",
      async () => {
        const { root, validate } = setup(all("self"));
        await validate([
          {
            kind: "describe",
            workItemId: uid(root),
            description: "New",
            descriptionVersion: 1,
          },
          { kind: "comment", workItemId: uid(root), body: "Note" },
          { kind: "close", workItemId: uid(root), reason: "completed" },
        ]);
      },
    );

    for (const [action, change] of [
      [
        "update",
        (id: UuidV7) => ({
          kind: "describe",
          workItemId: id,
          description: "New",
          descriptionVersion: 1,
        }),
      ],
      [
        "comment",
        (id: UuidV7) => ({ kind: "comment", workItemId: id, body: "x" }),
      ],
      [
        "label",
        (id: UuidV7) => ({ kind: "label", workItemId: id, add: ["a"] }),
      ],
      [
        "close",
        (id: UuidV7) => ({
          kind: "close",
          workItemId: id,
          reason: "completed",
        }),
      ],
    ] as const) {
      const others = (scope: "self" | "children") =>
        all(scope).filter((granted) => granted.action !== action);

      test.concurrent(`${action} on self needs its grant`, async () => {
        const { root, validate } = setup([
          ...others("self"),
          ...all("children"),
        ]);
        await expectRefused(
          validate([change(uid(root)) as WorkItemChange]),
          WORK_ITEM_CHANGES_INVALID,
          new RegExp(`no ${action} grant on self`),
        );
      });

      test.concurrent(`${action} on a child needs its grant`, async () => {
        const root = item();
        const child = item({ parent: uid(root) });
        const { validate } = setup([...all("self"), ...others("children")], {
          root,
          items: [child],
        });
        await expectRefused(
          validate([change(uid(child)) as WorkItemChange]),
          WORK_ITEM_CHANGES_INVALID,
          new RegExp(`no ${action} grant on children`),
        );
      });

      test.concurrent(
        `${action} on a child passes with its grant`,
        async () => {
          const root = item();
          const child = item({ parent: uid(root) });
          const { validate } = setup(
            all("children").filter((granted) => granted.action === action),
            { root, items: [child] },
          );
          await validate([change(uid(child)) as WorkItemChange]);
        },
      );
    }

    test.concurrent(
      "grants on self don't cover an existing child",
      async () => {
        const root = item();
        const child = item({ parent: uid(root) });
        const { validate } = setup(all("self"), { root, items: [child] });
        await expectRefused(
          validate([{ kind: "comment", workItemId: uid(child), body: "Hi" }]),
          WORK_ITEM_CHANGES_INVALID,
          /no comment grant on children/,
        );
      },
    );

    test.concurrent(
      "a label grant may add or remove only its labels",
      async () => {
        const { root, validate } = setup([grant("label", "self", ["a", "b"])]);
        await validate([
          { kind: "label", workItemId: uid(root), add: ["a"], remove: ["b"] },
        ]);
        await expectRefused(
          validate([{ kind: "label", workItemId: uid(root), add: ["c"] }]),
          WORK_ITEM_CHANGES_INVALID,
          /labels c/,
        );
        await expectRefused(
          validate([{ kind: "label", workItemId: uid(root), remove: ["d"] }]),
          WORK_ITEM_CHANGES_INVALID,
          /labels d/,
        );
      },
    );

    test.concurrent("a block needs a block grant", async () => {
      const root = item();
      const first = item({ parent: uid(root) });
      const second = item({ parent: uid(root) });
      const { validate } = setup(
        all("children").filter((granted) => granted.action !== "block"),
        { root, items: [first, second] },
      );
      await expectRefused(
        validate([
          {
            kind: "block",
            blockedWorkItemId: uid(first),
            blockingWorkItemId: uid(second),
          },
        ]),
        WORK_ITEM_CHANGES_INVALID,
        /no block grant on children/,
      );
    });

    test.concurrent(
      "a block's blocking item must be in the grant's scope",
      async () => {
        const root = item();
        const child = item({ parent: uid(root) });
        const { validate } = setup([grant("block", "self")], {
          root,
          items: [child],
        });
        await expectRefused(
          validate([
            {
              kind: "block",
              blockedWorkItemId: uid(root),
              blockingWorkItemId: uid(child),
            },
          ]),
          WORK_ITEM_CHANGES_INVALID,
          /block grant on self doesn't cover/,
        );
      },
    );

    test.concurrent(
      "children grants cover block, update and close on children",
      async () => {
        const root = item();
        const child = item({ parent: uid(root), descriptionVersion: 3 });
        const sibling = item({ parent: uid(root) });
        const { validate } = setup([...all("self"), ...all("children")], {
          root,
          items: [child, sibling],
        });
        await validate([
          {
            kind: "block",
            blockedWorkItemId: uid(sibling),
            blockingWorkItemId: uid(child),
          },
          {
            kind: "describe",
            workItemId: uid(child),
            description: "Sharper",
            descriptionVersion: 3,
          },
          { kind: "close", workItemId: uid(child), reason: "completed" },
        ]);
      },
    );

    test.concurrent(
      "an item outside the Task's subtree is refused",
      async () => {
        const other = item();
        const { validate } = setup([...all("self"), ...all("children")], {
          items: [other],
        });
        await expectRefused(
          validate([
            { kind: "close", workItemId: uid(other), reason: "completed" },
          ]),
          WORK_ITEM_CHANGES_INVALID,
          /neither the Task's work item nor one of its children/,
        );
      },
    );

    test.concurrent("an item in another project is refused", async () => {
      const root = item();
      const foreign = item({ parent: uid(root), projectId: createUuidV7() });
      const { validate } = setup(all("children"), {
        root,
        items: [foreign],
      });
      await expectRefused(
        validate([{ kind: "comment", workItemId: uid(foreign), body: "Hi" }]),
        WORK_ITEM_CHANGES_INVALID,
        /doesn't exist/,
      );
    });
  });
});
