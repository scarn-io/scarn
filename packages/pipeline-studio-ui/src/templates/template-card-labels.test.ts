import { describe, expect, test } from "bun:test";
import {
  formatOptionalSettings,
  formatSetupLabel,
  formatStepCount,
  hasStepConflicts,
} from "./template-card-labels";

const optional = (label: string) => ({ label, required: false });
const required = (label: string) => ({ label, required: true });

describe("formatStepCount", () => {
  test("counts graph steps and adds hand-off steps separately", () => {
    expect(formatStepCount({ stepCount: 4, handoffStepCount: 3 })).toBe(
      "1 step +3 hand-off",
    );
    expect(formatStepCount({ stepCount: 3, handoffStepCount: 0 })).toBe(
      "3 steps",
    );
    expect(formatStepCount({ stepCount: 1, handoffStepCount: 0 })).toBe(
      "1 step",
    );
  });
});

describe("formatSetupLabel", () => {
  test("reads No setup when nothing is required", () => {
    expect(formatSetupLabel([])).toBe("No setup");
    expect(formatSetupLabel([optional("Planning guidance")])).toBe("No setup");
  });

  test("counts required settings", () => {
    expect(formatSetupLabel([required("App URL"), optional("Notes")])).toBe(
      "1 required setting",
    );
    expect(formatSetupLabel([required("App URL"), required("Login")])).toBe(
      "2 required settings",
    );
  });
});

describe("formatOptionalSettings", () => {
  test("lists optional parameters by label", () => {
    expect(formatOptionalSettings([required("App URL")])).toBeNull();
    expect(
      formatOptionalSettings([
        optional("Planning guidance"),
        required("App URL"),
        optional("Notes"),
      ]),
    ).toBe("Optional: Planning guidance, Notes");
  });
});

describe("hasStepConflicts", () => {
  test("is true only when step keys are taken", () => {
    const conflicts = {
      takenStepKeys: [],
      pipelineKeyTaken: true,
      nextPipelineKey: "wayfinder-2",
    };
    expect(hasStepConflicts({ conflicts })).toBe(false);
    expect(
      hasStepConflicts({
        conflicts: { ...conflicts, takenStepKeys: ["plan"] },
      }),
    ).toBe(true);
  });
});
