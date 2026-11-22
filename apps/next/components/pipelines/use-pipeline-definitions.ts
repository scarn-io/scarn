"use client";

import { useCallback, useEffect, useState } from "react";
import {
  parseUuidV7,
  pipelineDefinitionSchema,
  type PipelineDefinitionContract,
} from "@scarn/api/frontend-contracts";
import { z } from "zod";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { unwrapTreatyResponse } from "@/app/_lib/scarn-treaty";

const pipelineDefinitionsSchema = z.array(pipelineDefinitionSchema);

export type PipelineDefinitionsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; definitions: PipelineDefinitionContract[] };

/**
 * The project's pipeline definitions, archived ones too when
 * `includeArchived`. `upsert` puts a created, archived or restored
 * definition in place without a refetch; an archived one drops out unless
 * archived ones are shown.
 */
export function usePipelineDefinitions(
  projectId: string,
  includeArchived: boolean,
): PipelineDefinitionsState & {
  upsert: (definition: PipelineDefinitionContract) => void;
} {
  const [state, setState] = useState<PipelineDefinitionsState>({
    status: "loading",
  });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    const endpoint = getBrowserScarnApiClient().api.projects({
      projectId: parseUuidV7(projectId),
    })["pipeline-definitions"];
    unwrapTreatyResponse(
      includeArchived
        ? endpoint.get({ query: { includeArchived: true } })
        : endpoint.get(),
    )
      .then((data) => {
        if (cancelled) return;
        const parsed = pipelineDefinitionsSchema.safeParse(data);
        setState(
          parsed.success
            ? { status: "loaded", definitions: parsed.data }
            : {
                status: "error",
                message: "Received invalid pipeline definition payload",
              },
        );
      })
      // eslint-disable-next-line local/no-unknown-parameter-type
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "Failed to load pipeline definitions",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, includeArchived]);

  const upsert = useCallback(
    (definition: PipelineDefinitionContract) => {
      setState((current) => {
        if (current.status !== "loaded") return current;
        const others = current.definitions.filter(
          (entry) => entry.id !== definition.id,
        );
        const hidden = definition.archivedAt !== null && !includeArchived;
        if (hidden) return { status: "loaded", definitions: others };
        const exists = others.length < current.definitions.length;
        return {
          status: "loaded",
          definitions: exists
            ? current.definitions.map((entry) =>
                entry.id === definition.id ? definition : entry,
              )
            : [...current.definitions, definition],
        };
      });
    },
    [includeArchived],
  );

  return { ...state, upsert };
}
