/**
 * Upserts `WORK_ITEMS` into the sandbox in one batch. The server saves every
 * item, skipped ones included, and the `default` project automation routes
 * each item as it becomes ready and queues a run for the ones it routes.
 */
import { createScarnClient } from "@scarn/sdk";
import type { LocalDevAuth } from "./auth";
import type { LocalWorkItem } from "./work-items";

export interface SeededWorkItem {
  item: LocalWorkItem;
  id: string;
  /** The pipeline the default automation should pick, or `null` if skipped. */
  pipeline: string | null;
}

export function platformKeyOf(item: LocalWorkItem): string {
  return `local-${item.key}`;
}

export function expectedPipeline(item: LocalWorkItem): string | null {
  const { fields } = item;
  if (fields["state"] === "closed" || fields["status"] === "resolved") {
    return null;
  }
  return typeof fields["demo"] === "string"
    ? `ld-${fields["demo"]}`
    : "ld-linear";
}

export async function seedWorkItems(input: {
  auth: LocalDevAuth;
  projectId: string;
  items: LocalWorkItem[];
}): Promise<SeededWorkItem[]> {
  const { auth, projectId, items } = input;
  const api = createScarnClient(auth.origin);
  const now = new Date().toISOString();

  const result = await api.workItems.upsertWorkItems({
    body: items.map((item) => ({
      projectId,
      platform: "custom" as const,
      platformKey: platformKeyOf(item),
      title: item.title,
      description: item.description,
      fields: item.fields,
      state: item.state ?? "open",
      sourceCreatedAt: now,
      sourceUpdatedAt: now,
    })),
    headers: auth.headers,
  });
  if (result.error !== undefined) {
    throw new Error(
      `[local-dev] upsertWorkItems failed (${String(result.response.status)}): ${JSON.stringify(result.error)}`,
    );
  }

  const idByPlatformKey = new Map(
    result.data.map((workItem) => [workItem.platformKey, workItem.id]),
  );
  return items.map((item) => {
    const id = idByPlatformKey.get(platformKeyOf(item));
    if (!id) {
      throw new Error(
        `[local-dev] upsertWorkItems returned no work item for ${platformKeyOf(item)}`,
      );
    }
    return { item, id, pipeline: expectedPipeline(item) };
  });
}
