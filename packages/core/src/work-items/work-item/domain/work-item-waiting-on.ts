import { SYSTEM_ACTOR_ID } from "@scarn/core/access/authorization/system-actor";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { WorkItemEntity } from "./work-item-entity";

/**
 * How far up the parents the walk for someone to wait on goes. It bounds a
 * corrupted or cyclic hierarchy; real ones are far shallower.
 */
export const MAX_WAITING_ON_WALK = 100;

type WorkItemPeople = Pick<
  WorkItemEntity,
  "assigneeUserId" | "createdByUserId"
>;

/**
 * A work item's own people: its assignee, then its creator. The system actor
 * isn't a person, so an item it created has no creator here.
 */
export const workItemPeopleUserIds = (workItem: WorkItemPeople): UuidV7[] =>
  [
    workItem.assigneeUserId,
    workItem.createdByUserId === SYSTEM_ACTOR_ID
      ? null
      : workItem.createdByUserId,
  ].filter((id): id is UuidV7 => !!id);

/**
 * The people Scarn waits on for a work item: the assignee and creator of the
 * first item in `chain` (the work item, then its parent, then the parent's
 * parent…) that has either, then whoever triggered the work. Missing people
 * are dropped and each person appears once. The same rule is read live in
 * SQL by `workItemWaitingOnPeopleSql`.
 */
export const workItemWaitingOnUserIds = (
  chain: readonly WorkItemPeople[],
  triggeredByUserId: UuidV7 | null | undefined,
): UuidV7[] => {
  const people =
    chain.map(workItemPeopleUserIds).find((userIds) => userIds.length > 0) ??
    [];
  return [
    ...new Set(
      [...people, triggeredByUserId].filter((id): id is UuidV7 => !!id),
    ),
  ];
};
