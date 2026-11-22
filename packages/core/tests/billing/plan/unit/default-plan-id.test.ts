import { describe, expect } from "bun:test";
import { defaultPlanId } from "@/billing/plan/application/default-plan-id";
import { ConfigurationError } from "@/lib/errors";
import { concurrentTest } from "tests/utils";

describe("defaultPlanId", () => {
  concurrentTest(
    "is unlimited when SCARN_DEFAULT_PLAN is unset or blank",
    () => {
      expect(defaultPlanId({})).toBe("unlimited");
      expect(defaultPlanId({ SCARN_DEFAULT_PLAN: "  " })).toBe("unlimited");
    },
  );

  concurrentTest("returns the configured plan", () => {
    expect(defaultPlanId({ SCARN_DEFAULT_PLAN: "free" })).toBe("free");
    expect(defaultPlanId({ SCARN_DEFAULT_PLAN: "unlimited" })).toBe(
      "unlimited",
    );
  });

  concurrentTest("throws for an unknown plan", () => {
    try {
      defaultPlanId({ SCARN_DEFAULT_PLAN: "enterprise" });
      throw new Error("expected defaultPlanId to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as ConfigurationError).code).toBe("INVALID_DEFAULT_PLAN");
    }
  });
});
