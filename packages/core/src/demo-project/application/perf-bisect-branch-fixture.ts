import type { DemoFlagshipStepNodeFixture } from "./demo-flagship-pipeline-types";

/**
 * The flagship pipeline's performance-bisect branch — the two steps
 * `classify-and-label-impact` dispatches to when intake classified
 * the ticket as "something that used to be fast got slower".
 *
 * Every prompt and gate here is copied from the real pipeline definition
 * this branch was captured against, with each advancement rule rewritten as
 * a `next` route and the `block` default as a `fail` node. The
 * confirmed measurements are passed to the bisect step as `args`, which is
 * where its prompt's `{{input.*}}` placeholders read them from. The captured content these steps replay
 * lives in `fixtures/flagship/perf-search-regression/` — see
 * `seed-demo-perf-regression-bisect-flagship.ts`.
 */

export const PERF_BISECT_ENTRY_NODE_KEY = "confirm-perf-regression";

export const PERF_BISECT_BRANCH_STEPS: readonly DemoFlagshipStepNodeFixture[] =
  [
    {
      key: PERF_BISECT_ENTRY_NODE_KEY,
      stepName: "Confirm Performance Regression",
      stepPrompt: `Confirm — or refute — the latency regression described in this work item, by
measuring it. You are not fixing anything and you are not reading code looking
for something that "looks slow". Produce two numbers a human can trust.

A regression counts as confirmed at {{input.regressionThresholdPct}}% or more
above baseline p95.

## 1. Work out what to measure

From the work item, identify:

- The endpoint or operation that got slower. Write it in \`endpointPath\`.
- Any baseline the report names — a release, a tag, a date, "last Tuesday".

If the report does not name an endpoint you can actually hit, stop and emit a
\`feedback_request\` notification saying exactly what you could not determine.
Do not guess an endpoint; a benchmark of the wrong route is worse than no
benchmark, because it looks like an answer.

## 2. Get a benchmark harness

Look for one first — a \`bench/\` directory, a \`bench\` script in
package.json, an existing load test. Reuse it if it exists.

If you must write one, it has to satisfy all of the following, because the next
step hands it to \`git bisect run\`:

- Boots the app from the CURRENT WORKING DIRECTORY, not from a path derived
  from the script's own location. The script will be copied outside the repo.
- Fails loudly if its port is already in use. This is not a nicety. A leftover
  server from an earlier run will answer on that port and you will measure the
  wrong process and get a confident, wrong answer.
- Warms up before it measures.
- Reports p50/p95/p99 as JSON.
- Exits 0 when p95 is at or under a \`--max-p95 <ms>\` argument, 1 when over,
  and 125 when this revision cannot be measured at all (endpoint absent, build
  broken, server won't boot). Those are the exit codes \`git bisect run\`
  interprets as good / bad / skip.

Commit the harness. The next step runs in a fresh checkout of your work branch.

## 3. Establish the baseline

Find a commit that predates the regression and where the endpoint exists and
is fast. Use whatever the report gives you (a tag, a release, a date via
\`git log --before\`). Verify it by benchmarking it — a "baseline" you did not
measure is a guess. Record the resolved SHA in \`baselineRef\`.

If every commit you try is already slow, the regression is older than the
report claims. Say so in \`measurementNotes\` and score \`confidence\` low.

## 4. Measure the noise floor before you measure the regression

Benchmark the SAME commit at least twice and record the spread between runs as
\`noiseFloorPct\`. A shared machine can easily move p95 by 20%. Without this
number you cannot tell a regression from a busy CPU, and neither can the human
reading your result.

Then benchmark baseline and HEAD, at least twice each, and take the median p95
of the runs — not the best, not the mean.

## 5. Report

- \`p95BaselineMs\`, \`p95CurrentMs\`: median p95 across runs.
- \`regressionPct\`: (current - baseline) / baseline * 100. Negative if it got
  faster.
- \`noiseFloorPct\`: run-to-run spread on the same commit, from step 4.
- \`suggestedThresholdP95Ms\`: the p95 cutoff the bisect should use to classify
  a commit as good or bad. Put it between the two measurements — the geometric
  mean of \`p95BaselineMs\` and \`p95CurrentMs\` is a good default. It must be
  comfortably clear of both, or the bisect will chase noise.
- \`benchmarkCommand\`: the exact command, including flags, that produced these
  numbers. The next step reuses it verbatim.
- \`confidence\`: 0 = these numbers could be noise or the wrong endpoint,
  1 = the gap dwarfs the noise floor and reproduces on every run.

  Score this honestly and score it LOW when \`regressionPct\` is not several
  times \`noiseFloorPct\`. The advancement rules can compare each of these
  numbers to a constant but cannot compare them to EACH OTHER, so your
  confidence is the only place that judgement can live. A low score parks this
  for a human, which is the correct outcome for an ambiguous measurement.
- \`setupNotes\`: anything you had to install, seed, or start to make the
  benchmark run — the next step needs to do the same thing.`,
      // A measured-but-immaterial regression ends the run here rather than
      // bisecting history for a jump inside the noise floor.
      next: {
        routes: [
          {
            when: {
              all: [
                {
                  path: "result.confidence",
                  op: "greaterThanInclusive",
                  value: 0.7,
                },
                {
                  path: "result.regressionPct",
                  op: "greaterThanInclusive",
                  value: 10,
                },
              ],
            },
            to: "bisect-perf-regression",
            args: {
              endpointPath: "result.endpointPath",
              baselineRef: "result.baselineRef",
              p95BaselineMs: "result.p95BaselineMs",
              p95CurrentMs: "result.p95CurrentMs",
              benchmarkCommand: "result.benchmarkCommand",
              suggestedThresholdP95Ms: "result.suggestedThresholdP95Ms",
              setupNotes: "result.setupNotes",
            },
          },
          {
            when: {
              all: [
                {
                  path: "result.confidence",
                  op: "greaterThanInclusive",
                  value: 0.7,
                },
                { path: "result.regressionPct", op: "lessThan", value: 10 },
              ],
            },
            to: "done",
          },
        ],
        otherwise: { to: "regression-unconfirmed" },
      },
    },
    {
      key: "bisect-perf-regression",
      stepName: "Bisect Performance Regression",
      stepPrompt: `A previous step confirmed a real regression on {{input.endpointPath}} and left
you a benchmark. Find the commit that introduced it.

Confirmed measurements:
- baseline {{input.baselineRef}}: p95 {{input.p95BaselineMs}}ms
- HEAD: p95 {{input.p95CurrentMs}}ms
- benchmark: \`{{input.benchmarkCommand}}\`
- good/bad cutoff to use: p95 {{input.suggestedThresholdP95Ms}}ms
- setup the last step needed: {{input.setupNotes}}

## Copy the harness out of the repository FIRST

\`\`\`sh
cp <harness> /tmp/perf-bench.mjs
\`\`\`

This is the single most common way to waste an hour here. \`git bisect\`
checks out old commits. The harness does not exist at those commits, so a
bisect that invokes the in-tree path fails on every revision that predates it
and gives you nothing. Run the copy, and pass its absolute path.

## Bisect

\`\`\`sh
git bisect start <bad> <good>
git bisect run node /tmp/perf-bench.mjs --json --max-p95 {{input.suggestedThresholdP95Ms}}
\`\`\`

- \`<bad>\` is HEAD, \`<good>\` is {{input.baselineRef}}.
- Let \`git bisect run\` drive it. Do not hand-check commits unless the
  automated run breaks down — it is deterministic and you are not.
- Commits the harness cannot measure must exit 125 so bisect skips them rather
  than scoring them. If you find yourself marking commits good or bad by hand
  to work around a crash, fix the harness instead.
- Re-run \`git bisect reset\` when you are done, before anything else. Leaving
  the repo in a detached bisect state breaks every later step and confuses the
  human who opens this branch.

## Verify before you report

A bisect result is a hypothesis until you test it. Do one of these:

1. Revert the culprit's diff on top of HEAD and benchmark again. If p95 returns
   to roughly baseline, set \`verifiedByRevert\` to true and record the number
   in \`revertedP95Ms\`.
2. If the revert does not apply cleanly, benchmark the culprit and its direct
   parent back to back. Both numbers go in \`p95AtCulpritMs\` and
   \`p95BeforeCulpritMs\`.

Then read the culprit's diff and explain the mechanism in one paragraph. "This
commit is slow" is not an explanation. Name the operation that became more
expensive and say why — an index replaced by a scan, work moved inside a loop,
a cache that stopped being hit, a call that became synchronous.

## Do not fix it

This step ends the pipeline. A human decides whether to revert, forward-fix, or
accept the cost, and that decision needs context you do not have. Put your
recommendation in \`suggestedFix\` and stop.

## Report

- \`culpritCommit\`: full SHA. \`culpritSubject\`, \`culpritAuthor\`,
  \`culpritDate\`: from \`git show -s\`.
- \`p95BeforeCulpritMs\` / \`p95AtCulpritMs\`: the measurements either side.
- \`deltaPctAtCulprit\`: the jump attributable to this one commit.
- \`bisectSteps\`: how many revisions were tested. \`skippedCommits\`: any that
  exited 125, with the reason in \`explanation\`.
- \`verifiedByRevert\`: true ONLY if you reverted it and re-measured.
- \`confidence\`: 0 = the bisect was noisy or several commits looked similar,
  1 = one commit moved p95 across the threshold and reverting it moved it back.
- \`explanation\`: the mechanism. \`suggestedFix\`: what you would do, and what
  it would cost.`,
      next: {
        routes: [{ to: "done" }],
      },
    },
  ];
