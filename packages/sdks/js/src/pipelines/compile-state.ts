/**
 * The state of one `definePipeline` compile: the nodes placed so far, the
 * chains wired, build issues, and the source map from JSON pointers to TS
 * sites.
 */
import { jsonPointer } from "../contracts/pipeline-document";
import { AuthoringError, type BuildIssue } from "./errors";
import type { ChainData, NodeDef } from "./model";
import { setTrackerPointer, type ReadTracker } from "./refs";
import type { SourceSite } from "./source";

export type Segment = string | number;

export interface PlacedNode {
  def: NodeDef;
  chain: ChainData | undefined;
  /** The compiled JSON node. */
  json: Record<string, unknown>;
}

export interface CompileState {
  readonly nodes: Map<string, PlacedNode>;
  readonly issues: BuildIssue[];
  readonly sourceMap: Record<string, SourceSite>;
  readonly tracker: ReadTracker;
  /** Every chain in `flow`. */
  readonly usedChains: Set<ChainData>;
}

export function newState(): CompileState {
  return {
    nodes: new Map(),
    issues: [],
    sourceMap: {},
    tracker: { records: [], fields: [], reaches: [], pointer: "" },
    usedChains: new Set(),
  };
}

export function issue(
  state: CompileState,
  site: SourceSite | null,
  pointer: readonly Segment[],
  message: string,
): void {
  state.issues.push({ site, pointer: jsonPointer(pointer), message });
}

export function mapSource(
  state: CompileState,
  pointer: readonly Segment[],
  site: SourceSite | null,
): void {
  const key = jsonPointer(pointer);
  if (site !== null && state.sourceMap[key] === undefined) {
    state.sourceMap[key] = site;
  }
}

/**
 * Runs authoring code (a callback, an args object) for the JSON at
 * `pointer`. Errors it throws become build issues there; returns undefined
 * when it threw.
 */
export function attempt<T>(
  state: CompileState,
  pointer: readonly Segment[],
  site: SourceSite | null,
  run: () => T,
): T | undefined {
  const previous = state.tracker.pointer;
  setTrackerPointer(jsonPointer(pointer));
  try {
    return run();
  } catch (error) {
    if (error instanceof AuthoringError) {
      issue(state, error.site ?? site, pointer, error.message);
    } else {
      issue(
        state,
        site,
        pointer,
        error instanceof Error ? error.message : String(error),
      );
    }
    return undefined;
  } finally {
    setTrackerPointer(previous);
  }
}

/** Places `def`, or reports a clash with an earlier node of the same id. */
export function place(
  state: CompileState,
  def: NodeDef,
  site: SourceSite | null,
  pointer: readonly Segment[],
): PlacedNode | undefined {
  const existing = state.nodes.get(def.id);
  if (existing === undefined) {
    const placed: PlacedNode = {
      def,
      chain: undefined,
      json: {},
    };
    state.nodes.set(def.id, placed);
    mapSource(state, ["nodes", def.id], def.site);
    return placed;
  }
  if (existing.def !== def) {
    issue(
      state,
      site,
      pointer,
      `two different handles use the node id "${def.id}"; give one a different id (step.as("...") for steps)`,
    );
    return undefined;
  }
  return existing;
}
