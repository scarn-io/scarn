import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { AnyJsonValue } from "@scarn/core/common/contracts/json";
import type { AppContext } from "@scarn/core/lib/di";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import {
  ensureDemoFlagshipExecution,
  resetDemoFlagshipExecutions,
  type DemoFlagshipStepContent,
} from "./seed-demo-flagship-execution";

/**
 * The demo project's second flagship: a real captured run of the same
 * `Triage & Investigate` pipeline replaying a search-latency regression —
 * intake, then the `route-by-problem-type` choice node's real decision, then
 * down the perf-bisect branch, where the regression is confirmed with a
 * benchmark and traced to its culprit commit with `git bisect run`.
 *
 * This is why the two flagships matter together: they share ONE pipeline
 * definition and each take a different branch out of the same choice node, on
 * the strength of their own real `routeKey`. Captured as two executions
 * across two pipelines chained by a `route` advancement event (`Intake
 * Router` -> `Performance Regression Bisect`); replays now as one execution
 * of one graph-shaped pipeline.
 *
 * Every log transcript and result payload in
 * `fixtures/flagship/perf-search-regression/` is the real agent's own
 * captured output — see the four `.result.json`/`.log.jsonl` pairs (two
 * intake steps, two perf-bisect steps). Its intake content is its own real
 * capture, not a reuse of the coupon flagship's: a different ticket, so a
 * different restated problem, impact, and route. The only edit made to the
 * raw capture: `bisect-perf-regression`'s real result and transcript named
 * the culprit commit's actual author (a real name + corporate email address
 * from `git show`) — that has been replaced with a generic placeholder
 * (`Unknown <redacted@example.com>`) everywhere it appeared, since this repo
 * is not the place to publish who committed the (fictional) demo project's
 * regression. Nothing else was fabricated or altered.
 *
 * No artifacts: none of this run's steps recorded one.
 */

export const PERF_SEARCH_REGRESSION_WORK_ITEM_PLATFORM_KEY =
  "demo-perf-search-regression";

// See the identical note in `seed-demo-coupon-double-apply-flagship.ts`:
// `import.meta.url` (standard ESM), not Bun's `import.meta.dir` shorthand,
// since this module is transitively bundled into the Next.js/Turbopack API
// route via `refreshDemoProject`, where `import.meta.dir` is `undefined`.
// Resolved on first use rather than at import: the Cloudflare Worker build has
// no `import.meta.url` and no filesystem, and must still load this module.
const fixturePath = (fileName: string): string =>
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../fixtures/flagship/perf-search-regression",
    fileName,
  );

/**
 * The steps this capture covers: the pipeline's intake head, plus the
 * perf-bisect branch its real `routeKey` selects. The browser-repro branch's
 * steps are never queued for this work item, so no content is registered for
 * them — an unexpected step key is a bug, not a missing file.
 */
const CAPTURED_STEP_KEYS = new Set([
  "assess-intake-quality",
  "classify-and-label-impact",
  "confirm-perf-regression",
  "bisect-perf-regression",
]);

const loadStepContent = async (
  stepKey: string,
): Promise<DemoFlagshipStepContent> => {
  if (!CAPTURED_STEP_KEYS.has(stepKey)) {
    throw new Error(
      `No perf-bisect flagship fixture content registered for step "${stepKey}"`,
    );
  }

  const [rawLogJsonl, rawResultJson] = await Promise.all([
    readFile(fixturePath(`${stepKey}.log.jsonl`), "utf8"),
    readFile(fixturePath(`${stepKey}.result.json`), "utf8"),
  ]);
  const resultJson = JSON.parse(rawResultJson) as AnyJsonValue;

  return { rawLogJsonl, resultJson };
};

/**
 * Idempotently seeds the perf-regression-bisect flagship. See the module doc
 * comment above for what it replays and why.
 */
export const ensureDemoPerfRegressionBisectFlagship = async (
  appContext: AppContext,
  projectId: UuidV7,
  userAuthz: UserAuthorizationService,
): Promise<void> => {
  await ensureDemoFlagshipExecution(appContext, {
    projectId,
    userAuthz,
    workItem: {
      platformKey: PERF_SEARCH_REGRESSION_WORK_ITEM_PLATFORM_KEY,
      title: "Search endpoint is really slow",
      description: `Search on the site has gotten really slow the past week or so. I've gotten a few complaints from other people too, saying it feels like the search box "hangs" when you type something in.

What's happening now: You type a search and it just... sits there for a second before anything shows up. On a slower connection it feels straight up broken, like it's not going to respond at all.

What I expected: Search used to be basically instant — like, you'd barely notice it was even doing a lookup. Now there's a noticeable delay every time.

I don't think anything changed on our end (same computer, same setup, nothing like that), so I'm guessing something changed in the app itself recently. Not sure exactly when it started, just that it's been within the last week or two.

Can someone take a look? Would be good to figure out what changed and whether it can just be undone or needs an actual fix.`,
      daysAgo: 2,
    },
    stepContent: loadStepContent,
  });
};

export const resetDemoPerfRegressionBisectFlagship = async (
  appContext: AppContext,
  projectId: UuidV7,
): Promise<void> => {
  await resetDemoFlagshipExecutions(appContext, projectId, {
    workItemPlatformKey: PERF_SEARCH_REGRESSION_WORK_ITEM_PLATFORM_KEY,
  });
};
