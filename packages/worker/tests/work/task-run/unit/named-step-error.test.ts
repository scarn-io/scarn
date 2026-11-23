import { describe, expect, test } from "bun:test";
import {
  NamedStepError,
  codeStepFailure,
  isAllowedStepErrorName,
} from "../../../../src/work/task-run/application/named-step-error";

const record = (value: {
  name: string;
  code?: string | null;
  message: string;
}) => JSON.stringify(value);

function failureWithLogs(
  errorFileText: string | null,
  declaredErrors: readonly string[] = ["Billing.Declined"],
) {
  const logs: Array<{ message: string; details: Record<string, unknown> }> = [];
  const error = codeStepFailure({
    message: "Code task failed",
    errorFileText,
    declaredErrors,
    stepKey: "charge",
    onLog: (message, details) => logs.push({ message, details }),
  });
  return { error, logs };
}

describe("isAllowedStepErrorName", () => {
  test("accepts built-in and declared names", () => {
    expect(isAllowedStepErrorName("Scarn.McpToolError", [])).toBe(true);
    expect(
      isAllowedStepErrorName("Billing.Declined", ["Billing.Declined"]),
    ).toBe(true);
  });

  test("rejects undeclared names and Scarn.All", () => {
    expect(isAllowedStepErrorName("Billing.Declined", [])).toBe(false);
    expect(isAllowedStepErrorName("Scarn.All", [])).toBe(false);
  });
});

describe("codeStepFailure", () => {
  test("a declared name becomes a NamedStepError carrying its code", () => {
    const { error, logs } = failureWithLogs(
      record({ name: "Billing.Declined", code: "CARD_DECLINED", message: "x" }),
    );

    expect(error).toBeInstanceOf(NamedStepError);
    expect(error).toMatchObject({
      errorName: "Billing.Declined",
      code: "CARD_DECLINED",
      message: "Code task failed",
    });
    expect(logs).toEqual([]);
  });

  test("a built-in name without a code gets the default code", () => {
    const { error } = failureWithLogs(
      record({ name: "Scarn.McpUnavailable", code: null, message: "x" }),
      [],
    );

    expect(error).toMatchObject({
      errorName: "Scarn.McpUnavailable",
      code: "SCARN_STEP_ERROR",
    });
  });

  test("an undeclared name falls back to a plain error and logs why", () => {
    const { error, logs } = failureWithLogs(
      record({ name: "Billing.Unknown", message: "x" }),
    );

    expect(error).not.toBeInstanceOf(NamedStepError);
    expect(error.message).toBe("Code task failed");
    expect(logs).toHaveLength(1);
    expect(logs[0]?.message).toContain('"Billing.Unknown"');
    expect(logs[0]?.message).toContain("Scarn.StepFailed");
    expect(logs[0]?.details).toMatchObject({
      stepKey: "charge",
      errorName: "Billing.Unknown",
      declaredErrors: ["Billing.Declined"],
    });
  });

  test("an unreadable record falls back to a plain error and logs why", () => {
    const { error, logs } = failureWithLogs("not json");

    expect(error).not.toBeInstanceOf(NamedStepError);
    expect(logs[0]?.message).toContain("unreadable");
  });

  test("no record is a plain error with nothing logged", () => {
    const { error, logs } = failureWithLogs(null);

    expect(error).not.toBeInstanceOf(NamedStepError);
    expect(logs).toEqual([]);
  });
});
