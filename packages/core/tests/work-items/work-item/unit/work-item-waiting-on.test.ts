import { describe, expect, test } from "bun:test";
import { SYSTEM_ACTOR_ID } from "@/access/authorization/system-actor";
import {
  createUuidV7,
  parseUuidV7,
  type UuidV7,
} from "@/common/contracts/uuid-v7";
import { loadWorkItemWaitingOnUserIds } from "@/work-items/work-item/application/load-work-item-waiting-on";
import { WorkItemEntity } from "@/work-items/work-item/domain/work-item-entity";
import type { WorkItemId } from "@/work-items/work-item/domain/work-item-id";
import { workItemWaitingOnUserIds } from "@/work-items/work-item/domain/work-item-waiting-on";
import type { DbExecutor } from "@/lib/db/db-executor";

const projectId = parseUuidV7("0196917c-532c-75aa-b7d5-0a84b71a1f02");
const alice = createUuidV7();
const bob = createUuidV7();
const starter = createUuidV7();

const item = (
  input: {
    assigneeUserId?: UuidV7;
    createdByUserId?: UuidV7;
    parent?: WorkItemEntity;
  } = {},
) =>
  WorkItemEntity.create({
    projectId,
    platform: "scarn",
    platformKey: `manual-${createUuidV7()}`,
    title: "A work item",
    createdByUserId: input.createdByUserId ?? null,
    assigneeUserId: input.assigneeUserId ?? null,
    parentWorkItemId: input.parent?.id ?? null,
  });

const repoOf = (items: WorkItemEntity[]) => {
  const loads: WorkItemId[] = [];
  return {
    loads,
    load: (id: WorkItemId) => {
      loads.push(id);
      return Promise.resolve(items.find((entry) => entry.id === id) ?? null);
    },
  };
};

const tx = {} as DbExecutor;

describe("who a work item waits on", () => {
  test("its assignee, then its creator, then whoever triggered the work", () => {
    expect(
      workItemWaitingOnUserIds(
        [item({ assigneeUserId: alice, createdByUserId: bob })],
        starter,
      ),
    ).toEqual([alice, bob, starter]);
    expect(
      workItemWaitingOnUserIds([item({ createdByUserId: alice })], alice),
    ).toEqual([alice]);
  });

  test("the system actor is no creator, so the walk carries on up", () => {
    const parent = item({ createdByUserId: bob });
    expect(
      workItemWaitingOnUserIds(
        [item({ createdByUserId: SYSTEM_ACTOR_ID, parent }), parent],
        null,
      ),
    ).toEqual([bob]);
  });

  test("loads parents only until one has a person, over two levels", async () => {
    const map = item({ createdByUserId: alice });
    const middle = item({ parent: map });
    const child = item({ parent: middle });
    const repo = repoOf([map, middle, child]);

    expect(
      await loadWorkItemWaitingOnUserIds(child, starter, repo, tx),
    ).toEqual([alice, starter]);
    expect(repo.loads).toEqual([middle.id, map.id]);
  });

  test("an item with a person loads no parent; no one anywhere leaves the starter", async () => {
    const assigned = item({ assigneeUserId: bob, parent: item() });
    const orphan = item();
    const repo = repoOf([]);

    expect(
      await loadWorkItemWaitingOnUserIds(assigned, null, repo, tx),
    ).toEqual([bob]);
    expect(
      await loadWorkItemWaitingOnUserIds(orphan, starter, repo, tx),
    ).toEqual([starter]);
    expect(await loadWorkItemWaitingOnUserIds(null, null, repo, tx)).toEqual(
      [],
    );
    expect(repo.loads).toEqual([]);
  });
});
