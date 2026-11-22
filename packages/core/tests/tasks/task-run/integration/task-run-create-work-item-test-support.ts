import { expect } from "bun:test";
import {
  createUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import { getDb } from "@/lib/db";
import { workItems } from "@/lib/db/schema";
import { WORK_ITEM_CHANGES_INVALID } from "@/tasks/task/application/validate-work-item-changes";
import { parseWorkItemId } from "@/work-items/work-item/domain/work-item-id";

export type Claim = { task: { id: string }; claimToken: string };

/** A `work-item-creates` body under `claim`, with a fresh id unless given. */
export const childInput = (
  claim: Claim,
  extra: { workItemId?: UuidV7; labels?: string[]; blockedBy?: UuidV7[] } = {},
) => ({
  claimToken: claim.claimToken,
  workItemId: parseWorkItemId(extra.workItemId ?? createUuidV7()),
  title: "A child",
  description: "Something to do.",
  ...(extra.labels ? { labels: extra.labels } : {}),
  ...(extra.blockedBy
    ? { blockedBy: extra.blockedBy.map(parseWorkItemId) }
    : {}),
});

/** Expects a `WORK_ITEM_CHANGES_INVALID` refusal whose detail holds `detail`. */
export const expectRefused = (
  response: { error: { status: unknown; value: unknown } | null },
  detail?: string,
) => {
  expect(response.error?.status).toBe(422);
  const value = response.error?.value as
    { code?: string; detail?: string } | undefined;
  expect(value?.code).toBe(WORK_ITEM_CHANGES_INVALID);
  if (detail) {
    expect(value?.detail).toContain(detail);
  }
};

/** Inserts `count` open children of `parent`, spawned by a Task when given. */
export const seedChildren = async (
  projectId: UuidV7,
  parent: UuidV7,
  count: number,
  spawnedByTaskId: UuidV7 | null = null,
) => {
  await getDb()
    .insert(workItems)
    .values(
      Array.from({ length: count }, () => ({
        id: createUuidV7(),
        projectId,
        platform: "scarn" as const,
        platformKey: `manual-${crypto.randomUUID()}`,
        title: "Seeded child",
        parentWorkItemId: parent,
        spawnedByTaskId,
      })),
    );
};
