import { sql, type SQL } from "drizzle-orm";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { WORK_ITEM_PLATFORM_COMMENT_CHANNEL } from "@scarn/core/notifications/notification-delivery/contracts/notification-delivery-contracts";
import type { NotificationDeliveryStatus } from "@scarn/core/notifications/notification-delivery/contracts/notification-delivery-contracts";

/** Alias of the awaiting-approval subquery, as it appears in `FROM`/`JOIN`. */
export const ALIAS = "awaiting_approval";
/** Output column carrying the work item id, for the caller's join condition. */
export const WORK_ITEM_ID_COLUMN = "work_item_id";
/** Output column carrying the draft count. */
export const COLUMN = "awaiting_approval_count";

/**
 * The channel/status pair that makes a `notification_deliveries` row a
 * still-actionable comment draft. Shared between this subquery's `WHERE` and
 * `buildFilterPredicates`'s `EXISTS` in `work-item-listing-query.ts` so the
 * badge and the filter can never drift apart — see
 * `docs/plans/awaiting-approval-filter.md`'s "Badge and filter drift apart"
 * risk. `status IN (...)` matches `drizzle-notification-delivery-repo.ts`'s
 * `listPendingWorkItemPlatformCommentDrafts`: a `failed` delivery still has a
 * live Approve button and still blocks a human (decision 3).
 */
export const AWAITING_APPROVAL_CHANNEL = WORK_ITEM_PLATFORM_COMMENT_CHANNEL;
export const AWAITING_APPROVAL_STATUSES: NotificationDeliveryStatus[] = [
  "pending",
  "failed",
];

/**
 * Per-work-item count of still-actionable comment drafts, project-wide.
 *
 * Modeled on `buildLatestExecutionStatusSubquery`'s shape — grouped, so an
 * outer `LEFT JOIN` stays 1:1 and cannot inflate `COUNT(*) OVER ()` — but
 * simpler: `GROUP BY` alone gives 1:1 here since there is exactly one row per
 * `work_item_id`, with no need for `DISTINCT ON`'s tiebreaker dance.
 *
 * Project-scoped via `user_notifications_project_id_idx` rather than by
 * joining `work_items`, since `user_notifications.project_id` is already the
 * project-scoping column the rest of the notifications domain reads through.
 * `work_item_id is not null` drops orphaned drafts whose work item was
 * deleted (`user_notifications.work_item_id` is `ON DELETE SET NULL`).
 */
export const buildAwaitingApprovalSubquery = (projectId: UuidV7): SQL =>
  // Both enum columns are cast to text before comparison, matching
  // `work-item-listing-query.ts`'s own enum-cast precedent for its `platform`
  // ILIKE clause: an enum column compared directly against a bind parameter is
  // ambiguous to the planner, so the comparison side is cast explicitly
  // rather than relying on an implicit unknown-type coercion.
  sql`(
  select
    n.work_item_id as ${sql.identifier(WORK_ITEM_ID_COLUMN)},
    count(*)::int as ${sql.identifier(COLUMN)}
  from app.notification_deliveries d
  join app.user_notifications n on n.id = d.notification_id
  where n.project_id = ${projectId}::uuid
    and n.work_item_id is not null
    and d.channel::text = ${AWAITING_APPROVAL_CHANNEL}
    and d.status::text in (${sql.join(
      AWAITING_APPROVAL_STATUSES.map((status) => sql`${status}`),
      sql`, `,
    )})
  group by n.work_item_id
) as ${sql.identifier(ALIAS)}`;
