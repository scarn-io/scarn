import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { AnyJsonValue } from "@scarn/core/common/contracts/json";
import type { AppContext } from "@scarn/core/lib/di";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { ArtifactKind } from "@scarn/core/tasks/task-artifact/contracts/task-artifact-contracts";
import {
  ensureDemoFlagshipExecution,
  resetDemoFlagshipExecutions,
  type DemoFlagshipStepContent,
} from "./seed-demo-flagship-execution";

/**
 * One of the demo project's two flagships: a real captured run of the
 * `Triage & Investigate` pipeline replaying the coupon-double-apply-on-
 * checkout bug — intake, then the `route-by-problem-type` choice node's real
 * decision, then down the browser-repro branch.
 *
 * This was captured as two executions across two pipelines chained by a
 * `route` advancement event (`Intake Router` -> `Browser Repro &
 * Investigate`), which is how a chain-shaped definition had to express a
 * fork. The captured content is unchanged; it now replays as one execution of
 * one graph-shaped pipeline — see
 * `triage-and-investigate-pipeline-fixture.ts`.
 *
 * Every log transcript and result payload in
 * `fixtures/flagship/coupon-double-apply/` is the real agent's own captured
 * output — see the four `.result.json`/`.log.jsonl` pairs (two intake steps,
 * two browser-repro steps). The only edits made to the raw capture:
 * `investigate-root-cause`'s transcript has 4 log lines removed (a real
 * product bug re-saved the previous step's artifacts onto this step; those
 * artifacts are not part of this flagship at all — see below), and
 * `reproduce-in-browser`'s two `tracePath`/`screenshotPath` result fields
 * point at the artifacts' `relativeStorePath` instead of the original run's
 * now-meaningless absolute workspace path.
 *
 * Artifacts: the real Playwright trace + failure screenshot belong to
 * `reproduce-in-browser` (where they were actually recorded) and are
 * attached there. `investigate-root-cause` never touches a browser — its
 * real run picking up copies of those same two files was a worker bug, not
 * real output, so this flagship attaches no artifacts to it at all.
 */

export const COUPON_DOUBLE_APPLY_WORK_ITEM_PLATFORM_KEY =
  "demo-bug-double-apply-coupon";

// `path.dirname(fileURLToPath(import.meta.url))`, not Bun's `import.meta.dir`
// shorthand: this module is transitively pulled into the Next.js/Turbopack
// server bundle for the API's catch-all route (via `refreshDemoProject`), and
// `import.meta.dir` is a Bun-only property that Turbopack's `import.meta`
// handling does not populate — it evaluates to `undefined`, so `path.join`
// throws at module-evaluation time in that bundled context. `import.meta.url`
// is standard ESM and resolves correctly under both Bun and Turbopack/webpack.
// Resolved on first use rather than at import: the Cloudflare Worker build has
// no `import.meta.url` and no filesystem, and must still load this module.
const fixturePath = (fileName: string): string =>
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../fixtures/flagship/coupon-double-apply",
    fileName,
  );

/**
 * The steps this capture covers: the pipeline's intake head, plus the
 * browser-repro branch its real `routeKey` selects. The perf-bisect branch's
 * steps are never queued for this work item, so no content is registered for
 * them — an unexpected step key is a bug, not a missing file.
 */
const STEP_ARTIFACTS: Record<
  string,
  readonly { relativeStorePath: string; contentType: string; kind: ArtifactKind }[]
> = {
  "reproduce-in-browser": [
    {
      relativeStorePath: "reproduce-in-browser-trace.zip",
      contentType: "application/zip",
      kind: "playwright-trace",
    },
    {
      relativeStorePath: "reproduce-in-browser-checkout-coupon-error.png",
      contentType: "image/png",
      kind: "generic",
    },
  ],
};

const CAPTURED_STEP_KEYS = new Set([
  "assess-intake-quality",
  "classify-and-label-impact",
  "reproduce-in-browser",
  "investigate-root-cause",
]);

const loadStepContent = async (
  stepKey: string,
): Promise<DemoFlagshipStepContent> => {
  if (!CAPTURED_STEP_KEYS.has(stepKey)) {
    throw new Error(
      `No coupon-double-apply flagship fixture content registered for step "${stepKey}"`,
    );
  }

  const [rawLogJsonl, rawResultJson] = await Promise.all([
    readFile(fixturePath(`${stepKey}.log.jsonl`), "utf8"),
    readFile(fixturePath(`${stepKey}.result.json`), "utf8"),
  ]);
  const resultJson = JSON.parse(rawResultJson) as AnyJsonValue;

  const artifactFiles = STEP_ARTIFACTS[stepKey];
  if (!artifactFiles) {
    return { rawLogJsonl, resultJson };
  }

  const artifacts = await Promise.all(
    artifactFiles.map(async (artifact) => ({
      ...artifact,
      bytes: new Uint8Array(
        await readFile(fixturePath(artifact.relativeStorePath)),
      ),
    })),
  );
  return { rawLogJsonl, resultJson, artifacts };
};

/**
 * Idempotently seeds the coupon-double-apply flagship. See the module doc
 * comment above for what it replays and why.
 */
export const ensureDemoCouponDoubleApplyFlagship = async (
  appContext: AppContext,
  projectId: UuidV7,
  userAuthz: UserAuthorizationService,
): Promise<void> => {
  await ensureDemoFlagshipExecution(appContext, {
    projectId,
    userAuthz,
    workItem: {
      platformKey: COUPON_DOUBLE_APPLY_WORK_ITEM_PLATFORM_KEY,
      title: "Applying a coupon twice crashes the checkout page",
      description: `A few shoppers on the support queue this week have hit a hard failure at
checkout: they apply a coupon code, then click "Apply" again on the same code
— often because the page didn't seem to respond, or they just wanted to
double-check it stuck — and the whole checkout page throws an error banner,
"Something went wrong applying your coupon (HTTP 500)," instead of just
telling them the coupon is already applied.

Applying a code once seems to work fine. It's the second time on the same
code that breaks.

Repro:
  1. POST /api/coupon with { "code": "SAVE10" } — succeeds, 200.
  2. POST /api/coupon again with the same code — fails, 500.`,
      daysAgo: 0,
    },
    stepContent: loadStepContent,
  });
};

export const resetDemoCouponDoubleApplyFlagship = async (
  appContext: AppContext,
  projectId: UuidV7,
): Promise<void> => {
  await resetDemoFlagshipExecutions(appContext, projectId, {
    workItemPlatformKey: COUPON_DOUBLE_APPLY_WORK_ITEM_PLATFORM_KEY,
  });
};
