/** Builds the merges found by the split analysis: what each one closes, and the fields its arriving lanes supply. */
import { jsonPointer } from "@scarn/sdk/contracts/pipeline-document";
import type { Edge, PipelineGraph } from "./graph";
import { collectFields, type EdgeSource } from "./merge-fields";
import type { Merge, Split } from "./splits";
import type { ValidationError } from "./types";

export interface Position {
  scope: readonly string[];
  origins: readonly ReadonlySet<string>[];
}

export interface Closing {
  closes: string[];
  partialOf: string | null;
}

function depthOf(splits: Map<string, Split>, id: string): number {
  let depth = 0;
  let parent = splits.get(id)?.parent ?? null;
  while (parent !== null) {
    depth += 1;
    parent = splits.get(parent)?.parent ?? null;
  }
  return depth;
}

export function buildMerges(
  graph: PipelineGraph,
  splits: Map<string, Split>,
  positions: Map<string, Position>,
  closings: Map<Edge, Closing | null>,
  errors: ValidationError[],
): Map<string, Merge> {
  const merges = new Map<string, Merge>();
  for (const [edge, closing] of closings) {
    if (closing === null) {
      continue;
    }
    const merge: Merge = merges.get(edge.to) ?? {
      nodeId: edge.to,
      closes: [],
      partialOf: null,
      incoming: [],
      fields: new Map(),
    };
    merges.set(edge.to, merge);
    merge.incoming.push(edge);
    merge.partialOf ??= closing.partialOf;
    for (const id of closing.closes) {
      if (!merge.closes.includes(id)) {
        merge.closes.push(id);
      }
    }
  }
  const sourceOf = (edge: Edge): EdgeSource | undefined => {
    const position = positions.get(edge.from ?? "");
    const split = splits.get(position?.scope.at(-1) ?? "");
    return position === undefined || split === undefined
      ? undefined
      : {
          split: split.id,
          kind: split.kind,
          origin: position.origins.at(-1) ?? new Set(),
          routes: split.routes,
        };
  };
  for (const merge of merges.values()) {
    merge.closes.sort((a, b) => depthOf(splits, b) - depthOf(splits, a));
    for (const id of merge.closes) {
      const split = splits.get(id);
      if (split !== undefined && split.merge === null) {
        split.merge = merge.nodeId;
      }
    }
    for (const edge of graph.incoming.get(merge.nodeId) ?? []) {
      if (edge.lane !== "partial") {
        errors.push({
          code: "split",
          path: jsonPointer(edge.pointer),
          message: `"${merge.nodeId}" is a merge (it has incoming "partial" routes), so every route into it must be "partial"`,
          hint: 'Add "partial": true here, or route to a separate node',
        });
      }
    }
    merge.fields = collectFields(
      graph,
      merge.nodeId,
      merge.incoming,
      sourceOf,
      errors,
    );
  }
  return merges;
}
