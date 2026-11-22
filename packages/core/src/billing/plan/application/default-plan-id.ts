import { ConfigurationError } from "@scarn/core/lib/errors";
import {
  planIdSchema,
  type PlanId,
} from "@scarn/core/billing/plan/contracts/plan-contracts";

/**
 * The plan a new billing-period meter starts on. Self-hosted installs default
 * to `unlimited` (usage is metered but never capped); a deployment opts into
 * caps by setting `SCARN_DEFAULT_PLAN` (the cloud sets `free`). An existing
 * meter row keeps the plan it was created with.
 */
export const defaultPlanId = (
  env: Record<string, string | undefined> = process.env,
): PlanId => {
  const raw = env["SCARN_DEFAULT_PLAN"]?.trim();
  if (!raw) return "unlimited";

  const parsed = planIdSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigurationError(
      `SCARN_DEFAULT_PLAN must be one of ${planIdSchema.options.join(", ")}; got "${raw}"`,
      "INVALID_DEFAULT_PLAN",
    );
  }
  return parsed.data;
};
