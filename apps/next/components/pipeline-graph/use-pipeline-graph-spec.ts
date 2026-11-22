"use client";

import { useMemo } from "react";
import {
  translateDocumentToGraph,
  type StudioEdge,
  type StudioNode,
} from "@scarn/pipeline-studio-ui";
import type { PipelineVersionContract } from "@scarn/api/frontend-contracts";

export type PipelineGraphSpecData = {
  nodes: StudioNode[];
  edges: StudioEdge[];
  loading: boolean;
  error: string;
};

type Graph = { nodes: StudioNode[]; edges: StudioEdge[] };
type PipelineDocument = Parameters<typeof translateDocumentToGraph>[0];

const EMPTY_GRAPH: Graph = { nodes: [], edges: [] };

/**
 * Keyed by version id. Versions are immutable once published, so a
 * translated (and laid-out) graph stays valid for the lifetime of the tab and
 * survives the overview being unmounted and remounted.
 */
const graphCache = new Map<string, Graph>();

export function __resetPipelineGraphSpecCacheForTests(): void {
  graphCache.clear();
}

function translateVersion(version: PipelineVersionContract): Graph {
  const cached = graphCache.get(version.id);
  if (cached) return cached;
  const graph = translateDocumentToGraph(
    version.definition as unknown as PipelineDocument,
  );
  graphCache.set(version.id, graph);
  return graph;
}

/**
 * Translates a run's pinned pipeline version (`definition_json`) into a
 * React Flow `{nodes, edges}` graph. `version: null` means it is still
 * loading; `failed` means it could not be loaded at all.
 */
export function usePipelineGraphSpec(
  version: PipelineVersionContract | null,
  failed = false,
): PipelineGraphSpecData {
  return useMemo(() => {
    if (!version) {
      return failed
        ? {
            ...EMPTY_GRAPH,
            loading: false,
            error: "Failed to load pipeline graph",
          }
        : { ...EMPTY_GRAPH, loading: true, error: "" };
    }
    try {
      return { ...translateVersion(version), loading: false, error: "" };
    } catch (translateError) {
      return {
        ...EMPTY_GRAPH,
        loading: false,
        error:
          translateError instanceof Error
            ? translateError.message
            : "Failed to render pipeline graph",
      };
    }
  }, [version, failed]);
}
