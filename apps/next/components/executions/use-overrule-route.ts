"use client";

/**
 * The Overrule dialog's requests: a preview of the chosen routes fetched
 * whenever the choice changes, the overrule itself, and which of the node's
 * route targets are code or MCP tool steps (whose missing args can't be
 * accepted).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import {
  apiErrorCode,
  apiErrorMeta,
  parseApiError,
} from "@/app/_lib/api-error";
import { unwrapTreatyResponse } from "@/app/_lib/scarn-treaty";
import {
  parseUuidV7,
  type PipelineVersionContract,
} from "@scarn/api/frontend-contracts";
import type { PipelineDocument } from "@scarn/sdk/contracts/pipeline-document";
import { overrulePreviewSchema } from "@scarn/core/pipeline-executions/pipeline-run/contracts/overrule-contracts";
import { assertNever } from "@scarn/core/lib/assert-never";
import type { StepDefinitionKind } from "@scarn/core/pipeline-definitions/step-definition/domain/step-definition-entity";
import { z } from "zod";
import type { OverrulePreview, RouteRef } from "./overrule-routes";
import type { OverruleRouteBody } from "./use-execution-detail";

export const ROUTE_ARGS_MISSING = "PIPELINE_RUN_ROUTE_ARGS_MISSING";

function rejectsMissingArgs(kind: StepDefinitionKind): boolean {
  switch (kind) {
    case "code":
    case "mcp_tool":
      return true;
    case "built_in":
    case "user_defined":
      return false;
    default:
      return assertNever(kind);
  }
}

/** The reason a preview is sent with; a preview writes nothing, so it isn't recorded. */
const PREVIEW_REASON = "Preview";

export type MissingArg = { arg: string; reference: string };

export type OverruleRefusal = {
  message: string;
  code: string | undefined;
  missing: MissingArg[];
};

export type PreviewState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; preview: OverrulePreview }
  | { kind: "refused"; refusal: OverruleRefusal };

export type PostVisitRoute = (
  visitId: string,
  body: OverruleRouteBody,
) => Promise<unknown>;

const missingArgsSchema = z
  .array(z.object({ arg: z.string(), reference: z.string() }))
  .catch([]);

const previewResultSchema = z.object({ preview: overrulePreviewSchema });

// eslint-disable-next-line local/no-unknown-parameter-type
function readRefusal(error: unknown): OverruleRefusal {
  return {
    message: parseApiError(error, "The overrule was refused"),
    code: apiErrorCode(error),
    missing: missingArgsSchema.parse(apiErrorMeta(error)?.["missing"] ?? []),
  };
}

const toSelectors = (routes: readonly RouteRef[]) =>
  routes.map((route) =>
    route.kind === "otherwise"
      ? { kind: "otherwise" as const }
      : { kind: "route" as const, index: route.index },
  );

/** Fetches a preview of overruling `visitId` onto `routes` each time they (or `acceptMissing`) change; `null` routes clear it. */
export function useOverrulePreview(
  postVisitRoute: PostVisitRoute,
  visitId: string,
  routes: readonly RouteRef[] | null,
  acceptMissing: boolean,
): PreviewState {
  const [state, setState] = useState<PreviewState>({ kind: "idle" });
  const requestRef = useRef(0);
  const routesKey = routes === null ? null : JSON.stringify(routes);

  useEffect(() => {
    const request = ++requestRef.current;
    if (routesKey === null) {
      setState({ kind: "idle" });
      return;
    }
    setState({ kind: "loading" });
    postVisitRoute(visitId, {
      routes: toSelectors(JSON.parse(routesKey) as RouteRef[]),
      reason: PREVIEW_REASON,
      acceptMissing,
      preview: true,
    }).then(
      (result) => {
        if (request !== requestRef.current) return;
        const parsed = previewResultSchema.safeParse(result);
        setState(
          parsed.success
            ? { kind: "ready", preview: parsed.data.preview }
            : {
                kind: "refused",
                refusal: {
                  message: "Received an invalid preview",
                  code: undefined,
                  missing: [],
                },
              },
        );
      },
      // eslint-disable-next-line local/no-unknown-parameter-type
      (error: unknown) => {
        if (request !== requestRef.current) return;
        setState({ kind: "refused", refusal: readRefusal(error) });
      },
    );
  }, [postVisitRoute, visitId, routesKey, acceptMissing]);

  return state;
}

/** Applies the overrule, then `onApplied`; a refusal stays in `refusal`. */
export function useApplyOverrule(
  postVisitRoute: PostVisitRoute,
  visitId: string,
  onApplied: () => void,
): {
  apply: (
    routes: readonly RouteRef[],
    reason: string,
    acceptMissing: boolean,
  ) => void;
  pending: boolean;
  refusal: OverruleRefusal | null;
} {
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<OverruleRefusal | null>(null);
  const apply = useCallback(
    (routes: readonly RouteRef[], reason: string, acceptMissing: boolean) => {
      setPending(true);
      setRefusal(null);
      postVisitRoute(visitId, {
        routes: toSelectors(routes),
        reason: reason.trim(),
        acceptMissing,
        preview: false,
      })
        .then(
          () => {
            onApplied();
          },
          // eslint-disable-next-line local/no-unknown-parameter-type
          (error: unknown) => {
            setRefusal(readRefusal(error));
          },
        )
        .finally(() => {
          setPending(false);
        });
    },
    [postVisitRoute, visitId, onApplied],
  );
  return { apply, pending, refusal };
}

/**
 * The target node ids that are code steps, from the step definitions the run's
 * version pinned; `null` while loading or when they couldn't be read.
 */
export function useCodeStepTargets(
  version: PipelineVersionContract | null,
  targets: readonly string[],
): ReadonlySet<string> | null {
  const [codeSteps, setCodeSteps] = useState<ReadonlySet<string> | null>(null);
  const targetsKey = targets.join("\n");

  useEffect(() => {
    let cancelled = false;
    setCodeSteps(null);
    if (!version) return;
    const document = version.definition as unknown as PipelineDocument;
    const stepTargets = targetsKey.split("\n").flatMap((nodeId) => {
      const node = document.nodes[nodeId];
      const pin =
        node?.kind === "step"
          ? version.steps.find((step) => step.stepKey === node.step)
          : undefined;
      return pin ? [{ nodeId, stepDefinitionId: pin.stepDefinitionId }] : [];
    });
    const apiClient = getBrowserScarnApiClient();
    void Promise.all(
      stepTargets.map(async ({ nodeId, stepDefinitionId }) => {
        const definition = await unwrapTreatyResponse(
          apiClient.api["step-definitions"]({
            stepDefinitionId: parseUuidV7(stepDefinitionId),
          }).get(),
        );
        return rejectsMissingArgs(definition.kind) ? [nodeId] : [];
      }),
    ).then(
      (results) => {
        if (!cancelled) setCodeSteps(new Set(results.flat()));
      },
      () => {
        if (!cancelled) setCodeSteps(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [version, targetsKey]);

  return codeSteps;
}
