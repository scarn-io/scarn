/**
 * A fake `context.workItems` for unit-testing a code step's `fn` without a
 * Scarn run. `createFakeWorkItems(features)` takes the step's own features,
 * so it has the same methods the step's context has, and keeps the project's
 * items in memory.
 *
 * It follows the server's rules: arguments are validated as the real client
 * validates them; an `upsert` of a new key needs a `create` grant on
 * `project`, of an existing one an `update` grant, each covering the key's
 * `keyPrefix` (the longest matching prefix wins) and the item's labels, and
 * one miss refuses the whole call with `WorkItemsRefusedError`; an item only
 * overwrites a stored one when its `sourceUpdatedAt` is strictly newer. A
 * `create` needs the same `create` grant, checked before the key is looked
 * up, and like the server's has no per-Task cap.
 */
import type {
  StepBridgeUpsertRequest,
  WorkItemUpsertItem,
} from "../../contracts/step-bridge";
import {
  buildWorkItemsClient,
  type WorkItemsClient,
} from "./code-step-work-items-client";
import type {
  CodeStepFeature,
  CodeStepGrant,
  FeatureGrants,
  Grant,
} from "./step-features";
import { WorkItemsRefusedError } from "./work-items-errors";

/** An item the fake project holds. */
export type FakeWorkItem = {
  readonly workItemId: string;
  readonly platform: string;
  readonly platformKey: string;
  readonly title: string;
  readonly description: string;
  readonly state: "open" | "closed";
  readonly labels: readonly string[];
  readonly url: string | null;
  readonly fields: Record<string, unknown> | null;
  readonly sourceUpdatedAt: string | null;
};

export type FakeWorkItemsOptions = {
  /** Items the project already has, written without any grant check. */
  readonly items?: readonly WorkItemUpsertItem[];
};

/** The fake client, plus the project's items to assert on. */
export type FakeWorkItems<TGrants extends Grant> = WorkItemsClient<TGrants> & {
  /** The project's items, in the order they were first written. */
  readonly items: () => FakeWorkItem[];
};

type WritableGrant = Extract<CodeStepGrant, { action: "create" | "update" }>;

const identityKey = (item: { platform: string; platformKey: string }) =>
  `${item.platform}:${item.platformKey}`;

function grantFor(
  grants: readonly Grant[],
  action: WritableGrant["action"],
  platformKey: string,
): WritableGrant | undefined {
  let best: WritableGrant | undefined;
  for (const grant of grants) {
    if (grant.action !== action || grant.scope !== "project") continue;
    const prefix = grant.keyPrefix ?? "";
    if (!platformKey.startsWith(prefix)) continue;
    if (best === undefined || prefix.length > (best.keyPrefix ?? "").length) {
      best = grant;
    }
  }
  return best;
}

function refusal(
  grants: readonly Grant[],
  item: { platform: string; platformKey: string; labels?: string[] },
  exists: boolean,
): string | null {
  const action = exists ? "update" : "create";
  const grant = grantFor(grants, action, item.platformKey);
  const what = `${exists ? "existing" : "new"} ${item.platform} item ${item.platformKey}`;
  if (grant === undefined) {
    return `This step may not write the ${what}: it has no ${action} grant on project covering that key`;
  }
  const allowed = grant.labels;
  if (allowed === undefined) return null;
  const outside = (item.labels ?? []).filter(
    (label) => !allowed.includes(label),
  );
  return outside.length === 0
    ? null
    : `This step may not write the ${what} with labels ${outside.join(", ")}: its ${action} grant on project covers ${allowed.join(", ")}`;
}

function refuse(refusals: readonly string[]): WorkItemsRefusedError {
  return new WorkItemsRefusedError(
    `workItems was refused: Nothing was written. ${refusals.join("; ")}`,
    "WORK_ITEM_GRANT_MISSING",
    refusals.length,
  );
}

const isNewer = (incoming: string, stored: string | null): boolean =>
  stored === null || Date.parse(incoming) > Date.parse(stored);

/**
 * A fake `context.workItems` for a code step with `features`, for unit tests:
 * `fn(input, { artifactsDir, fail: failStep, workItems: createFakeWorkItems(step features) })`.
 */
export function createFakeWorkItems<
  const TFeatures extends readonly CodeStepFeature[],
>(
  features: TFeatures,
  options: FakeWorkItemsOptions = {},
): FakeWorkItems<FeatureGrants<TFeatures>> {
  const grants = features.flatMap((feature) =>
    feature._grant ? [feature._grant] : [],
  );
  const store = new Map<string, FakeWorkItem>();

  const write = (item: StepBridgeUpsertRequest["items"][number]) => {
    const key = identityKey(item);
    const existing = store.get(key);
    store.set(key, {
      workItemId: existing?.workItemId ?? crypto.randomUUID(),
      platform: item.platform,
      platformKey: item.platformKey,
      title: item.title,
      description: item.description,
      state: item.state ?? existing?.state ?? "open",
      labels: item.labels ?? existing?.labels ?? [],
      url: item.url ?? null,
      fields: item.fields ?? null,
      sourceUpdatedAt: item.sourceUpdatedAt,
    });
    return store.get(key) as FakeWorkItem;
  };

  for (const seed of options.items ?? []) {
    write({
      ...seed,
      platformKey: seed.platformKey.trim(),
      title: seed.title.trim(),
    });
  }

  const client = buildWorkItemsClient(grants, {
    upsert: ({ items }) => {
      const refusals = items.flatMap((item) => {
        const reason = refusal(grants, item, store.has(identityKey(item)));
        return reason === null ? [] : [reason];
      });
      if (refusals.length > 0) throw refuse(refusals);
      const written = items.flatMap((item) => {
        const existing = store.get(identityKey(item));
        if (
          existing !== undefined &&
          !isNewer(item.sourceUpdatedAt, existing.sourceUpdatedAt)
        ) {
          return [];
        }
        const saved = write(item);
        return [
          {
            workItemId: saved.workItemId,
            platform: saved.platform,
            platformKey: saved.platformKey,
            outcome: existing ? ("updated" as const) : ("created" as const),
          },
        ];
      });
      const created = written.filter(
        (item) => item.outcome === "created",
      ).length;
      return {
        items: written,
        counts: {
          created,
          updated: written.length - created,
          unchanged: items.length - written.length,
        },
      };
    },
    create: (item) => {
      const reason = refusal(grants, { ...item, platform: "custom" }, false);
      if (reason !== null) throw refuse([reason]);
      const existing = store.get(identityKey({ ...item, platform: "custom" }));
      if (existing !== undefined) {
        return { workItemId: existing.workItemId, created: false };
      }
      const workItemId = crypto.randomUUID();
      store.set(identityKey({ ...item, platform: "custom" }), {
        workItemId,
        platform: "custom",
        platformKey: item.platformKey,
        title: item.title,
        description: item.description,
        state: "open",
        labels: item.labels ?? [],
        url: item.url ?? null,
        fields: item.fields ?? null,
        sourceUpdatedAt: null,
      });
      return { workItemId, created: true };
    },
    sourceCursor: ({ platform, keyPrefix }) => {
      let latest: string | null = null;
      for (const item of store.values()) {
        if (item.platform !== platform) continue;
        if (!item.platformKey.startsWith(keyPrefix ?? "")) continue;
        if (item.sourceUpdatedAt === null) continue;
        if (latest === null || isNewer(item.sourceUpdatedAt, latest)) {
          latest = item.sourceUpdatedAt;
        }
      }
      return { sourceUpdatedAt: latest };
    },
  });

  return Object.freeze({
    ...client,
    items: () => [...store.values()],
  });
}
