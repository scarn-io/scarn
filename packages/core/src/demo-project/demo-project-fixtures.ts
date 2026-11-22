/**
 * Static content for the seeded demo project (issue #151) — two pipelines
 * (`feature_qa`, `security_review`), each with several work items in varied
 * states. Pure data: no persistence, no I/O. `seed-demo-pipeline.ts` and
 * `seed-demo-execution.ts` turn this into real rows.
 *
 * The demo project's two flagship work streams — the coupon-double-apply-on-
 * checkout bug and the search-latency regression — replay real captured runs
 * of the branching `Triage & Investigate` pipeline instead of fabricating
 * content from a template, so they don't fit this file at all. They are
 * bespoke, hand-authored content in
 * `seed-demo-coupon-double-apply-flagship.ts` /
 * `seed-demo-perf-regression-bisect-flagship.ts` instead — see those modules'
 * doc comments, and `seed-demo-flagship-execution.ts` for why a flagship
 * isn't modeled here.
 *
 * Every pipeline's steps are described by an ordered `steps` array.
 * `seed-demo-pipeline.ts` turns each entry into its own `StepDefinition` and
 * chains them into a pipeline document, in array order, ending in a
 * `succeed` node.
 */

/**
 * What the seed script should do to a work item's pipeline execution:
 *  - `notStarted`: no execution is created at all (an untouched backlog item).
 *  - `queued`: an execution IS created — its first step run exists — but is
 *    deliberately left unclaimed, so the execution's derived status reads
 *    `queued`. Distinct from `notStarted`: this is a pipeline someone kicked
 *    off that's still waiting for a worker to pick it up, not one that was
 *    never started at all. Stable indefinitely: nothing about a `queued` step
 *    run's status depends on the wall clock the way a claimed/running one does
 *    (see the `inProgress` note below), so it never drifts to another status
 *    after seeding.
 *  - `succeeded`: an execution is created, claimed, given real log lines
 *    (and, for at least one, a real artifact), then completed successfully.
 *  - `failed`: same as `succeeded`, but completed with a failure result and
 *    real failure log lines. Issue #151 requires at least one of these.
 *
 * There is deliberately no `inProgress` outcome. A mid-flight task
 * cannot be seeded stably: `claimTaskRuns` stamps a `leaseExpiresAt` (30s
 * by default), and the next claim pass fails a Task whose lease lapsed as
 * `abandoned`, which fails its run. A seeded "running" step therefore
 * silently becomes a failed execution within a minute of seeding, which is the opposite of what a demo
 * wants. Items that would once have been `inProgress` are `notStarted`,
 * `queued`, or `succeeded` instead.
 */
export type DemoWorkItemOutcome =
  "notStarted" | "queued" | "succeeded" | "failed";

export type DemoWorkItemFixture = {
  /** Stable `work_items.platform_key` — the natural key the seed script re-runs against. */
  platformKey: string;
  title: string;
  description: string;
  outcome: DemoWorkItemOutcome;
  /**
   * How many days before "now" (at seed time) this work item's
   * `sourceUpdatedAt` should be re-anchored to — smaller is more recent, `0`
   * is "just updated". Mirrors the "re-anchor to now" pattern in
   * `replay-captured-log.ts`, but applied to a single point in time instead
   * of a whole log's timestamps, so the seeded fixtures always read as
   * freshly-updated relative to whenever the seed script runs, and sort
   * consistently across pipelines rather than by insertion order.
   */
  daysAgo: number;
  /**
   * Splice 1-2 fabricated `tool` conversation events into this work item's
   * log burst so its Agent tab shows a `ToolCard`.
   */
  withToolEvents?: boolean;
};

export type DemoStepFixture = {
  /**
   * Stable key for this step within its pipeline. `seed-demo-pipeline.ts`
   * combines it with the pipeline's own `key` for the step definition's key
   * (`${fixture.key}_${step.key}`), and uses it verbatim as the step's node
   * id in the pipeline document.
   */
  key: string;
  stepName: string;
  stepPrompt: string;
};

export type DemoPipelineFixture = {
  /** Stable key for both the step definition(s) and the pipeline definition (suffixed). */
  key: string;
  name: string;
  description: string;
  /**
   * Ordered steps for this pipeline — array order is step order.
   */
  steps: readonly DemoStepFixture[];
  workItems: DemoWorkItemFixture[];
};

/**
 * Work items that used to be in `DEMO_PIPELINE_FIXTURES` and have been
 * retired. `prune-retired-demo-work-items.ts` deletes these — and every
 * execution they accumulated — from an already-seeded demo project, because
 * simply removing a fixture from the array below leaves its rows behind
 * forever.
 *
 * Keys must never be reused: a key here is a tombstone, and re-adding it as a
 * live fixture would have the seed create it and the pruner delete it on the
 * same run.
 *
 * These three were dropped when `bug_triage` still existed as a single-item
 * "Bug Triage" pipeline. `bug_triage` itself (and its two remaining work
 * items, `demo-bug-triage-3`/`demo-bug-triage-5`) has since been removed
 * entirely in favor of the `Triage & Investigate` flagship pipeline (see
 * `seed-demo-coupon-double-apply-flagship.ts`) — that removal needed no
 * tombstone here because none of this data had shipped to a real environment
 * yet. Retired *pipeline* definitions are pruned separately, by key, in
 * `prune-retired-demo-pipelines.ts`.
 */
export const RETIRED_DEMO_WORK_ITEM_KEYS: readonly string[] = [
  "demo-bug-triage-1",
  "demo-bug-triage-2",
  "demo-bug-triage-4",
];

export const DEMO_PIPELINE_FIXTURES: readonly DemoPipelineFixture[] = [
  {
    key: "feature_qa",
    name: "Feature QA",
    description:
      "Runs a browser-driven regression pass over newly shipped features before they're marked ready for release notes.",
    steps: [
      {
        key: "step",
        stepName: "Playwright Regression Check",
        stepPrompt:
          "Exercise the feature described in this work item using Playwright, looking for regressions in adjacent flows. Summarize what you tried and what you observed.",
      },
    ],
    workItems: [
      {
        platformKey: "demo-feature-qa-1",
        title: "Add dark mode toggle to settings",
        description:
          "A new toggle in account settings should switch the whole app to a dark color scheme and persist the preference.",
        outcome: "notStarted",
        daysAgo: 8,
      },
      {
        // The fixture set's single `failed` item (issue #151 requires one).
        platformKey: "demo-feature-qa-2",
        title: "Support bulk-archive for work items",
        description:
          "Selecting multiple work items in the table should offer a bulk 'Archive' action in the toolbar.",
        outcome: "failed",
        withToolEvents: true,
        daysAgo: 5,
      },
      {
        platformKey: "demo-feature-qa-3",
        title: "Add CSV export to work items table",
        description:
          "The work items table should have an 'Export CSV' button that downloads the current filtered view.",
        outcome: "succeeded",
        withToolEvents: true,
        daysAgo: 2,
      },
      {
        // The fixture set's single `queued` item: a pipeline that's been
        // kicked off and is waiting for a worker, distinct from
        // `demo-feature-qa-1`'s `notStarted` (never kicked off at all).
        platformKey: "demo-feature-qa-4",
        title: "Add keyboard shortcuts to the work items table",
        description:
          "Power users want single-key shortcuts (e.g. 'j'/'k' to move focus, 'x' to select) on the work items table, matching the conventions the pipelines table already uses.",
        outcome: "queued",
        daysAgo: 1,
      },
    ],
  },
  {
    key: "security_review",
    name: "Security Review",
    description:
      "Reviews security-sensitive changes — auth flows, dependency updates, and public-facing surface area — before they roll out.",
    steps: [
      {
        key: "step",
        stepName: "Dependency & Auth Review",
        stepPrompt:
          "Review the change described in this work item for security implications: authentication/authorization edge cases, dependency provenance, and any newly-exposed public surface area. Summarize any concerns.",
      },
    ],
    workItems: [
      {
        platformKey: "demo-security-review-1",
        title: "Rotate stale GitHub App private keys",
        description:
          "The GitHub App's private key hasn't been rotated since initial setup. Rotate it and confirm installation tokens still mint correctly.",
        outcome: "notStarted",
        daysAgo: 9,
      },
      {
        platformKey: "demo-security-review-2",
        title: "Audit session fixation on password reset",
        description:
          "Confirm that completing a password reset invalidates every other active session, not just issues a new one alongside the old ones.",
        outcome: "succeeded",
        withToolEvents: true,
        daysAgo: 6,
      },
      {
        platformKey: "demo-security-review-3",
        title: "Harden CORS policy for public API reads",
        description:
          "Now that public projects allow anonymous API reads, confirm the CORS policy on those routes is scoped as tightly as the product requires.",
        outcome: "succeeded",
        withToolEvents: true,
        daysAgo: 3,
      },
    ],
  },
];
