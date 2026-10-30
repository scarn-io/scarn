/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unused-expressions -- lines under @ts-expect-error are invalid on purpose */
/**
 * Type tests for chains and targets: each `@ts-expect-error` is a row of the
 * "type error" column in docs/plans/pipeline-ts-sdk.md and
 * docs/plans/pipeline-splits.md. The SDK `typecheck`
 * fails if any of them stops being an error.
 */
import { describe, expect, test } from "bun:test";
import {
  each,
  equal,
  fail,
  succeed,
  type FlowChain,
  type PartialTarget,
  type Target,
} from "@scarn/sdk/pipelines";
import {
  editFile,
  openPr,
  planChanges,
  reviewEdit,
} from "./fixtures/items-pipeline";
import { fix, reproduceFromLogs } from "./fixtures/bug-steps";
import {
  classify,
  intake,
} from "../../../../../apps/docs/src/content/catalog-fixtures/pipeline-graph/steps";

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

const done = succeed("done");
const failed = fail("failed");

function typeOnly(run: () => void): void {
  void run;
}

describe("chain type-state", () => {
  test("finished chains are FlowChain, .partial(...) is a PartialTarget", () => {
    const flow = intake.next(done);
    const partial = openPr.partial({ request: "x" });
    const checks: [
      Assert<Equal<typeof flow, FlowChain>>,
      Assert<Equal<typeof partial, PartialTarget>>,
    ] = [true, true];
    expect(checks).toEqual([true, true]);
    expect([flow, partial]).toHaveLength(2);
  });

  test("unfinished or misordered chains are type errors", () => {
    typeOnly(() => {
      // @ts-expect-error -- next needs at least one route
      classify.next({ routes: [] });
      const routed = classify.next({
        routes: [
          { when: (r) => equal(r.result.severity, "critical"), to: done },
        ],
        otherwise: done,
      });
      // @ts-expect-error -- .next after .next
      routed.next(done);
      // @ts-expect-error -- .retry after .next
      fix.next(done).retry;
      // @ts-expect-error -- .catch after .next
      fix.next(done).catch;
      // @ts-expect-error -- .settings after .retry
      fix.retry({ on: ["Scarn.All"], maxAttempts: 2 }).settings;
      // @ts-expect-error -- a terminal has no chain
      done.next(failed);
    });
  });

  test("partial targets go only in .next(...), and not as an each's start", () => {
    typeOnly(() => {
      reviewEdit.next((r) => openPr.partial({ reviews: [r.result] }));
      // @ts-expect-error -- a partial target in .catch
      fix.catch(["Scarn.All"], openPr.partial({ request: "x" }));
      planChanges.next((r) =>
        // @ts-expect-error -- an each's start can't be a partial target
        each(r.result.files, () => openPr.partial({ request: "x" })),
      );
      planChanges.next((r) =>
        each(r.result.files, (file) =>
          editFile({ file, planSummary: r.result.summary }),
        ),
      );
      // @ts-expect-error -- a partial arg must fit the node's input
      openPr.partial({ request: 1 });
      // @ts-expect-error -- terminals have no .partial
      done.partial;
    });
  });

  test("the next object: match is first or all", () => {
    typeOnly(() => {
      classify.next({ match: "all", routes: [{ to: done }, { to: failed }] });
      classify.next({ match: "first", routes: [{ to: done }] });
      // @ts-expect-error -- an unknown match value
      classify.next({ match: "any", routes: [{ to: done }] });
    });
  });

  test("partial args and each targets", () => {
    typeOnly(() => {
      // @ts-expect-error -- a partial arg that isn't in the input
      openPr.partial({ nope: "x" });
      planChanges.next((r) =>
        // @ts-expect-error -- each with a lane block instead of a start callback
        each(r.result.files, { start: editFile, flow: [] }),
      );
    });
  });

  test("catching or retrying an error the step doesn't declare", () => {
    typeOnly(() => {
      reproduceFromLogs.catch(["LogsUnavailable"], done).next(done);
      fix
        .retry({ on: ["MergeConflict", "Scarn.Timeout"], maxAttempts: 2 })
        .next(done);
      // @ts-expect-error -- "Nope" isn't a built-in or declared error
      reproduceFromLogs.catch(["Nope"], done);
      // @ts-expect-error -- "LogsUnavailable" is declared by another step
      fix.retry({ on: ["LogsUnavailable"], maxAttempts: 2 });
    });
  });
});

describe("targets", () => {
  test("args are typed against the target's input", () => {
    typeOnly(() => {
      const ok: Target = openPr({ request: "r", reviews: [] });
      // @ts-expect-error -- missing arg
      openPr({ request: "r" });
      // @ts-expect-error -- extra arg
      openPr({ request: "r", reviews: [], extra: 1 });
      // @ts-expect-error -- wrongly typed arg
      openPr({ request: 1, reviews: [] });
      // @ts-expect-error -- a bare step that needs args
      intake.next(openPr);
      void ok;
    });
  });

  test("a bare step without required inputs is a target", () => {
    typeOnly(() => {
      intake.next(classify);
      intake.next(done);
    });
    expect(true).toBe(true);
  });
});
