import { expect } from "bun:test";
import {
  createUuidV7,
  parseUuidV7,
  type UuidV7,
} from "@/common/contracts/uuid-v7";
import type { DbExecutor } from "@/lib/db/db-executor";
import { CoreError } from "@/lib/errors";
import { validateWorkItemChanges } from "@/tasks/task/application/validate-work-item-changes";
import type { WorkItemChange } from "@/tasks/task/contracts/work-item-change-contracts";
import { TaskEntity } from "@/tasks/task/domain/task-entity";
import type { Grant, GrantScope } from "@/tasks/task/domain/grants";
import { grant } from "tests/tasks/task/grants-test-support";
import type { WorkItemRepo } from "@/work-items/work-item/application/work-item-repo";
import { WorkItemEntity } from "@/work-items/work-item/domain/work-item-entity";
import { parseWorkItemId } from "@/work-items/work-item/domain/work-item-id";

const tx = {} as DbExecutor;
const PROJECT_ID = createUuidV7();

export const item = (
  props: {
    id?: UuidV7;
    parent?: UuidV7 | null;
    platform?: "scarn" | "github";
    state?: "open" | "closed";
    descriptionVersion?: number;
    projectId?: UuidV7;
  } = {},
): WorkItemEntity => {
  const id = props.id ?? createUuidV7();
  return WorkItemEntity.rehydrate({
    id: parseWorkItemId(id),
    projectId: props.projectId ?? PROJECT_ID,
    platform: props.platform ?? "scarn",
    platformKey: `manual-${id}`,
    title: "Item",
    parentWorkItemId: props.parent ? parseWorkItemId(props.parent) : null,
    state: props.state ?? "open",
    descriptionVersion: props.descriptionVersion ?? 1,
  });
};

export { grant };

export const LABELS = ["a", "b", "wayfinder:research"];

/** Every action but `create` on `scope`, labels limited to `LABELS`. */
export const all = (scope: GrantScope): Grant[] => [
  grant("update", scope),
  grant("comment", scope),
  grant("label", scope, LABELS),
  grant("block", scope),
  grant("close", scope),
];

export const setup = (
  grants: Grant[],
  options: { root?: WorkItemEntity; items?: WorkItemEntity[] } = {},
) => {
  const root = options.root ?? item();
  const all = [root, ...(options.items ?? [])];
  const workItemRepo = {
    loadMany: (ids: string[]) =>
      Promise.resolve(all.filter((workItem) => ids.includes(workItem.id))),
  } as unknown as WorkItemRepo;
  const task = TaskEntity.create({
    projectId: PROJECT_ID,
    workItemId: uid(root),
    kind: "agent",
    name: "Wayfinder",
    prompt: "Plan the work.",
    grants,
    status: "running",
    createdAt: new Date("2026-10-28T12:00:00.000Z"),
  });
  const validate = async (changes: WorkItemChange[]) => {
    await validateWorkItemChanges(task, changes, { workItemRepo }, tx);
  };
  return { root, validate };
};

export const uid = (workItem: WorkItemEntity): UuidV7 =>
  parseUuidV7(workItem.id);

export const expectRefused = async (
  promise: Promise<void>,
  code: string,
  message = /./,
) => {
  let error: CoreError | null = null;
  try {
    await promise;
  } catch (caught) {
    error = caught instanceof CoreError ? caught : null;
  }
  expect(error?.code).toBe(code);
  expect(error?.message ?? "").toMatch(message);
};
