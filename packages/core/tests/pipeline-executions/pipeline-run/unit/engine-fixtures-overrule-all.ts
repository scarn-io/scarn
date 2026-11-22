import type { Lane } from "@/pipeline-executions/pipeline-run/domain/engine/types";
import {
  CLASSIFIED,
  forkDocument,
  forkSteps,
  triageDocument,
  triageSteps,
} from "./engine-fixtures-all";
import { RunSimulator } from "./engine-harness";
import type { Json } from "./engine-fixtures-overrule";

type Nodes = { nodes: Record<string, { next: Json & { routes: Json[] } }> };

/**
 * The triage example with its `classify-issue` routes overridable: through
 * `next.overridable` (every conditional route and `otherwise`), or only the
 * conditional routes listed, and `otherwise` when asked.
 */
export function overridableTriage(
  marked: "next" | { routes: number[]; otherwise: boolean } = "next",
): object {
  const document = triageDocument() as unknown as Nodes;
  const next = document.nodes["classify-issue"]
    ?.next as Nodes["nodes"][string]["next"];
  if (marked === "next") {
    next["overridable"] = true;
    return document;
  }
  for (const index of marked.routes) {
    (next.routes[index] as Json)["overridable"] = true;
  }
  if (marked.otherwise) {
    (next["otherwise"] as Json)["overridable"] = true;
  }
  return document;
}

/** The triage run with `classify-issue` succeeded with `classified`; returns the run and the visit to overrule. */
export function classifiedRun(
  classified: object = CLASSIFIED,
  document: object = overridableTriage(),
): { run: RunSimulator; visitId: string } {
  const run = new RunSimulator(document, triageSteps).start();
  run.succeed("classify-issue", classified as Json as never);
  return { run, visitId: run.visits("classify-issue")[0]?.id as string };
}

/** The fork example with `pick`'s routes overridable, after `pick` chose `left` and `right`. */
export function pickedFork(
  options: { merge: boolean; otherwise: boolean },
  picked: { left: boolean; right: boolean },
): { run: RunSimulator; visitId: string } {
  const document = forkDocument(options) as Nodes;
  (document.nodes["pick"]?.next as Json)["overridable"] = true;
  const run = new RunSimulator(document, forkSteps).start();
  run.succeed("pick", picked);
  return { run, visitId: run.visits("pick")[0]?.id as string };
}

/** The lanes of the run's first group (the `all` split), in index order. */
export function splitLanes(run: RunSimulator): Lane[] {
  const group = run.state.laneGroups[0];
  return run.state.lanes
    .filter((lane) => lane.laneGroupId === group?.id)
    .sort((left, right) => left.index - right.index);
}

export const route = (index: number) => ({ kind: "route", index }) as const;
export const OTHERWISE = { kind: "otherwise", index: 0 } as const;
