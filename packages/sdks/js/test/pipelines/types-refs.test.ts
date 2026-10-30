/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- lines under @ts-expect-error are invalid on purpose */
/**
 * Type tests for refs, conditions, args and `each`: each `@ts-expect-error`
 * is a row of the "type error" column in docs/plans/pipeline-ts-sdk.md.
 */
import { describe, expect, test } from "bun:test";
import {
  after,
  avg,
  before,
  count,
  definePipeline,
  equal,
  each,
  greaterThan,
  isEmpty,
  some,
  startsWith,
  succeed,
  workItem,
  type ConversationResult,
  type DecisionResult,
  type Placeholder,
  type Ref,
} from "@scarn/sdk/pipelines";
import { defineStep } from "@scarn/sdk/definitions/steps";
import { fix } from "./fixtures/bug-steps";
import { reviewFix } from "./fixtures/decision-pipeline";
import {
  editFile,
  openPr,
  planChanges,
  reviewEdit,
} from "./fixtures/items-pipeline";

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

const done = succeed("done");

const grill = defineStep({
  key: "grill",
  name: "Grill",
  agentPrompt: "Grill the person about the design.",
});

function typeOnly(run: () => void): void {
  void run;
}

describe("refs and conditions", () => {
  test("refs carry the source step's types", () => {
    typeOnly(() => {
      fix.next((r) => {
        const checks: [
          Assert<Equal<typeof r.result.testsPass, Placeholder<boolean>>>,
          Assert<
            typeof r.result.changedFiles extends Ref<string[]> ? true : false
          >,
        ] = [true, true];
        void [checks, r];
        return done;
      });
    });
    expect(true).toBe(true);
  });

  test("a defineStep with no result has a ConversationResult", () => {
    typeOnly(() => {
      grill.next((r) => {
        const checks: [
          Assert<Equal<typeof r.result.summary, Placeholder<string>>>,
          Assert<Equal<typeof r.result.conversationId, Placeholder<string>>>,
        ] = [true, true];
        void checks;
        return editFile({ file: r.result.summary, planSummary: "" });
      });
      // @ts-expect-error -- a conversation step's result has no decision
      grill.next((r) => editFile({ file: r.result.decision, planSummary: "" }));
    });
    const result: ConversationResult = { conversationId: "c", summary: "s" };
    expect(result.summary).toBe("s");
  });

  test("a decision's result.action is the union of its action keys", () => {
    typeOnly(() => {
      reviewFix.next((r) => {
        const checks: [
          Assert<
            Equal<
              typeof r.result.action,
              Placeholder<"approve" | "revise" | "reject">
            >
          >,
          Assert<Equal<typeof r.result.body, Placeholder<string | null>>>,
        ] = [true, true];
        void [checks, r];
        return done;
      });
      reviewFix.next({
        routes: [
          { when: (r) => equal(r.result.action, "revise"), to: done },
          {
            // @ts-expect-error -- "nope" isn't one of the decision's actions
            when: (r) => equal(r.result.action, "nope"),
            to: done,
          },
        ],
        otherwise: done,
      });
    });
    const result: DecisionResult<"approve"> = { action: "approve", body: null };
    expect(result.action).toBe("approve");
  });

  test("plain JS conditions are type errors", () => {
    typeOnly(() => {
      fix.next({
        routes: [
          {
            // @ts-expect-error -- a JS comparison isn't a condition
            when: (r) => r.result.attempts > 3, // eslint-disable-line scarn/no-logic-in-pipeline-callbacks -- the mistake under test
            to: done,
          },
        ],
        otherwise: done,
      });
      fix.next({
        routes: [
          {
            // @ts-expect-error -- a JS boolean isn't a condition
            when: (r) => r.result.testsPass,
            to: done,
          },
        ],
        otherwise: done,
      });
    });
  });

  test("operators and right sides are typed against the left", () => {
    typeOnly(() => {
      fix.next({
        routes: [
          { when: (r) => greaterThan(avg([r.result.attempts]), 1), to: done },
          { when: (r) => before(r.result.finishedAt, "2026-01-01"), to: done },
          {
            when: (r) => greaterThan(count(r.result.changedFiles), 0),
            to: done,
          },
        ],
        otherwise: done,
      });
      fix.next({
        routes: [
          {
            // @ts-expect-error -- greaterThan on a boolean
            when: (r) => greaterThan(r.result.testsPass, 1),
            to: done,
          },
          {
            // @ts-expect-error -- startsWith on a number
            when: (r) => startsWith(r.result.attempts, "1"),
            to: done,
          },
          {
            // @ts-expect-error -- after on an array
            when: (r) => after(r.result.changedFiles, "2026-01-01"),
            to: done,
          },
          {
            // @ts-expect-error -- isEmpty on a number
            when: (r) => isEmpty(r.result.attempts),
            to: done,
          },
          {
            // @ts-expect-error -- right side of the wrong type
            when: (r) => equal(r.result.testsPass, "yes"),
            to: done,
          },
          {
            // @ts-expect-error -- right ref of the wrong type
            when: (r) => equal(r.result.attempts, r.input.plan.summary),
            to: done,
          },
        ],
        otherwise: done,
      });
    });
  });
});

describe("where refs are available", () => {
  test("result and error exist only where the JSON allows them", () => {
    typeOnly(() => {
      // @ts-expect-error -- there's no r.results
      fix.next((r) => openPr({ request: "x", reviews: r.results }));
      // @ts-expect-error -- no error outside a catch
      fix.next((r) => editFile({ file: r.error.message, planSummary: "" }));
      fix.catch(["Scarn.All"], (r) =>
        // @ts-expect-error -- no result in a catch
        editFile({ file: r.result.finishedAt, planSummary: "" }),
      );
    });
  });

  test("item exists only as each's start parameter", () => {
    typeOnly(() => {
      planChanges.next((r) =>
        each(r.result.files, (file) => editFile({ file, planSummary: "" })),
      );
      // @ts-expect-error -- `item` isn't on r
      editFile.next((r2) => reviewEdit({ path: r2.item, diff: "" }));
    });
  });
});

describe("each", () => {
  test("each needs a start callback and an array", () => {
    typeOnly(() => {
      // @ts-expect-error -- each with no start
      planChanges.next((r) => each(r.result.files, { maxConcurrency: 2 }));
      planChanges.next((r) =>
        // @ts-expect-error -- each over a non-array
        each(r.result.summary, (x) => editFile({ file: x, planSummary: "" })),
      );
      planChanges.next((r) =>
        each(
          r.result.files,
          // @ts-expect-error -- toleratedFailures needs count or percent
          { toleratedFailures: { some: 1 } },
          (x) => editFile({ file: x, planSummary: "" }),
        ),
      );
    });
  });

  test("each can't be the pipeline's start", () => {
    typeOnly(() => {
      definePipeline({
        key: "k",
        // @ts-expect-error -- each in start
        start: each(workItem.title as never, (x: never) =>
          editFile({ file: x, planSummary: "" }),
        ),
        flow: [],
      });
    });
  });
});

describe("args", () => {
  test("literal objects containing refs are type errors", () => {
    typeOnly(() => {
      fix.next((r) =>
        fix({
          ...r.input,
          // @ts-expect-error -- a literal object with a ref inside
          plan: { requiresHumanApproval: r.result.testsPass, summary: "" },
        }),
      );
      planChanges.next((r) =>
        openPr({
          request: "",
          // @ts-expect-error -- a literal array with a ref inside
          reviews: [{ approved: r.result.count, confidence: 1, notes: "" }],
        }),
      );
    });
  });

  test("spreading a ref is typed per property", () => {
    typeOnly(() => {
      fix.next((r) => fix({ ...r.input, previousAttempt: r.result }));
      // @ts-expect-error -- the spread's properties don't fit the target's input
      planChanges.next((r) => editFile({ ...r.result }));
    });
  });

  test("an array of refs is a list arg, typed per element", () => {
    typeOnly(() => {
      reviewEdit.next((r) => openPr.partial({ reviews: [r.result] }));
      // @ts-expect-error -- the element doesn't fit the array's items
      editFile.next((r) => openPr.partial({ reviews: [r.result] }));
    });
  });

  test("list conditions type their element", () => {
    typeOnly(() => {
      openPr.next({
        routes: [
          {
            when: (r) => some(r.input.reviews, (x) => equal(x.approved, false)),
            to: done,
          },
          {
            // @ts-expect-error -- the element has no "missing" field
            when: (r) => some(r.input.reviews, (x) => equal(x.missing, false)),
            to: done,
          },
        ],
      });
    });
  });
});
