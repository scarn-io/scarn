import { describe, expect, expectTypeOf, test } from "bun:test";
import {
  StepError,
  codeStep,
  failStep,
  isStepError,
  type CodeStepFail,
} from "../src/definitions/steps";
import type { BuiltInError } from "../src/pipelines/types";

describe("codeStep — context.fail typing", () => {
  test("fail accepts built-in names and the step's declared errors", () => {
    codeStep({
      key: "named",
      name: "Named",
      errors: ["Billing.Declined", "Billing.Expired"],
      fn: (_input, context) => {
        expectTypeOf(context.fail).toEqualTypeOf<
          CodeStepFail<"Billing.Declined" | "Billing.Expired">
        >();
        expectTypeOf(context.fail)
          .parameter(0)
          .toEqualTypeOf<
            BuiltInError | "Billing.Declined" | "Billing.Expired"
          >();
        if (Math.random() > 2) context.fail("Billing.Declined", "declined");
        if (Math.random() > 2) context.fail("Scarn.Timeout", "too slow");
        // @ts-expect-error "Billing.Unknown" isn't declared in errors
        if (Math.random() > 2) context.fail("Billing.Unknown", "nope");
        return {};
      },
    });
  });

  test("without errors, fail accepts only built-in names", () => {
    codeStep({
      key: "plain",
      name: "Plain",
      fn: (_input, context) => {
        expectTypeOf(context.fail).parameter(0).toEqualTypeOf<BuiltInError>();
        // @ts-expect-error no errors declared
        if (Math.random() > 2) context.fail("Billing.Declined", "nope");
        return {};
      },
    });
  });

  test("fail never returns", () => {
    codeStep({
      key: "never",
      name: "Never",
      fn: (_input, context) => {
        expectTypeOf(context.fail).returns.toEqualTypeOf<never>();
        return {};
      },
    });
  });

  test("a bare StepError with any name still type-checks", () => {
    codeStep({
      key: "bare",
      name: "Bare",
      fn: () => {
        if (Math.random() > 2) throw new StepError("Anything.Goes", "ok");
        return {};
      },
    });
  });
});

describe("codeStep — context.fail at run time", () => {
  test("the fail the runner passes throws a StepError with name and code", async () => {
    const spec = codeStep({
      key: "throws",
      name: "Throws",
      errors: ["Billing.Declined"],
      fn: (_input, { fail }) =>
        fail("Billing.Declined", "card declined", { code: "CARD_DECLINED" }),
    });
    let failure: unknown;
    try {
      await spec.entrypoint?.fn({}, { artifactsDir: "/a", fail: failStep });
    } catch (error) {
      failure = error;
    }
    expect(isStepError(failure)).toBe(true);
    expect(failure).toBeInstanceOf(StepError);
    expect(failure).toMatchObject({
      name: "Billing.Declined",
      code: "CARD_DECLINED",
      message: "card declined",
    });
  });
});
