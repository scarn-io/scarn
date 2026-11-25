"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  AutomationContract,
  StepDefinitionContract,
} from "@scarn/api/frontend-contracts";
import type { Grant } from "@scarn/sdk/definitions/steps";
import { stepGrantsByKey } from "./step-grants";
import {
  fetchProjectAutomations,
  fetchProjectPipelineDefinitions,
  fetchProjectStepDefinitions,
} from "@/app/(protected)/projects/_lib/project-work-items";
import { parseApiError } from "@/app/_lib/api-error";

export type ProjectAutomationsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      automations: AutomationContract[];
      pipelineNames: ReadonlyMap<string, string>;
      stepGrants: ReadonlyMap<string, readonly Grant[]>;
    };

// eslint-disable-next-line local/no-unknown-parameter-type
const errorMessage = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : parseApiError(error, "Failed to load automations");

/**
 * Loads the project's automations, sorted by key, a pipeline key → name map
 * for labelling pipeline targets, and each step key's grants for the graph's
 * soft links. A failed step fetch leaves the grants empty rather than failing
 * the load. `reload` fetches everything again.
 */
export function useProjectAutomations(
  projectId: string,
): ProjectAutomationsState & { reload: () => void } {
  const [state, setState] = useState<ProjectAutomationsState>({
    status: "loading",
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    Promise.all([
      fetchProjectAutomations(projectId),
      fetchProjectPipelineDefinitions(projectId),
      fetchProjectStepDefinitions(projectId).catch(
        (): StepDefinitionContract[] => [],
      ),
    ])
      .then(([automations, definitions, steps]) => {
        if (cancelled) return;
        setState({
          status: "ready",
          automations: [...automations].sort((a, b) =>
            a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
          ),
          pipelineNames: new Map(
            definitions.map((definition) => [definition.key, definition.name]),
          ),
          stepGrants: stepGrantsByKey(steps),
        });
      })
      // eslint-disable-next-line local/no-unknown-parameter-type
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({ status: "error", message: errorMessage(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, attempt]);

  const reload = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  return { ...state, reload };
}
