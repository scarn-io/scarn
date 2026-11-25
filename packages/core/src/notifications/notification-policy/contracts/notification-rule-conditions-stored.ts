import { z } from "zod";
import type { AnyJsonObject } from "@scarn/core/common/contracts/json";
import { createTolerantReader } from "@scarn/core/lib/db/stored-json";

/**
 * Read-side schema for `notification_rules.conditions_json`. Tolerant, not
 * versioned: the column is reserved and nothing reads its keys yet. It is
 * null or a JSON object, passed through to the rule's API contract as-is.
 *
 * Promote it to versioned in the change that gives it structure (quiet
 * hours, rate limits). See `docs/persistence/json-columns.md`.
 */
const storedNotificationRuleConditionsSchema = z
  .record(z.string(), z.json())
  .nullable();

/** Reads a rule's `conditions_json`, or explains why it is unreadable. */
export const readStoredNotificationRuleConditions =
  createTolerantReader<AnyJsonObject | null>(
    storedNotificationRuleConditionsSchema,
  );
