"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { parseApiError } from "@/app/_lib/api-error";
import { unwrapTreatyResponse } from "@/app/_lib/scarn-treaty";
import {
  pipelineDefinitionSchema,
  pipelineExecutionSchema,
  parseUuidV7,
} from "@scarn/api/frontend-contracts";
import type {
  PipelineDefinitionContract,
  PipelineExecutionContract,
  PipelineVersionContract,
  WorkItemContract,
} from "@scarn/api/frontend-contracts";
import {
  isPageHidden,
  waitUntilVisible,
} from "@/components/use-defer-while-hidden";
import { loadRunVersion } from "./load-run-version";
import {
  buildExecutionProgressSignature,
  hasPendingTaskSnapshots,
} from "./execution-detail-view-polling";

const FAST_REFRESH_INTERVAL_MS = 5000;
const MAX_REFRESH_INTERVAL_MS = 20000;
const REFRESH_BACKOFF_FACTOR = 2;

const ACTIVE_EXECUTION_STATUSES = new Set<PipelineExecutionContract["status"]>([
  "queued",
  "running",
]);

export type OverruleRouteBody = {
  routes: ({ kind: "route"; index: number } | { kind: "otherwise" })[];
  reason: string;
  acceptMissing: boolean;
  preview: boolean;
};

export type SendStepMessageOutcome =
  { ok: true } | { ok: false; error: string };

export type ExecutionDetailData = {
  execution: PipelineExecutionContract | null;
  definition: PipelineDefinitionContract | null;
  /** The pipeline version this run is pinned to: its document and step pins. */
  version: PipelineVersionContract | null;
  workItem: WorkItemContract | null;
  /** True only while the first load of this execution id is in flight;
   * reloads after a mutation keep the current page rendered. */
  loading: boolean;
  error: string;
  /** Error from a rerun/resolve mutation (separate from the load error). */
  actionError: string;
  /** Human-readable label shown while a mutation is pending. */
  pendingActionLabel: string;
  /** True while a rerun/resolve transition is in flight. */
  isMutating: boolean;
  /** Reruns a step or wait visit; it and everything downstream is superseded. */
  rerunVisit: (visitId: string) => void;
  /** Overrules (or, with `preview`, previews overruling) the routes a visit took; resolves with the response, rejects with the problem. */
  postVisitRoute: (
    visitId: string,
    body: OverruleRouteBody,
  ) => Promise<unknown>;
  /** The wait actions resolve whether they went through. Records the chosen
   * action (and optional notes) on a waiting decision visit. */
  decideVisit: (
    visitId: string,
    action: string,
    body?: string,
  ) => Promise<boolean>;
  /** Stops waiting on an open question; the run continues without a reply. */
  continueWithoutReply: (questionId: string) => Promise<boolean>;
  /** Answers an open question; the run continues with the answer. */
  answerQuestion: (questionId: string, body: string) => Promise<boolean>;
  /** Sends a message to a step visit, rerunning it with the message attached.
   * Reports failure to the caller rather than through `actionError`. */
  sendVisitMessage: (
    visitId: string,
    body: string,
    quoteText?: string,
  ) => Promise<SendStepMessageOutcome>;
  /** Reloads the execution, e.g. after a conversation action moved it on. */
  reload: () => void;
};

/**
 * Owns all data fetching, polling, and mutations for a single pipeline
 * execution. The view component is left to handle layout and local selection
 * state only.
 */
export function useExecutionDetail(
  projectId: string,
  executionId: string,
): ExecutionDetailData {
  const apiClient = useMemo(() => getBrowserScarnApiClient(), []);

  const [execution, setExecution] = useState<PipelineExecutionContract | null>(
    null,
  );
  const [definition, setDefinition] =
    useState<PipelineDefinitionContract | null>(null);
  const [version, setVersion] = useState<PipelineVersionContract | null>(null);
  const [workItem, setWorkItem] = useState<WorkItemContract | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [pendingActionLabel, setPendingActionLabel] = useState("");
  const [reloadNonce, setReloadNonce] = useState(0);
  const [isMutating, startTransition] = useTransition();

  const pollDelayRef = useRef(FAST_REFRESH_INTERVAL_MS);
  const progressSignatureRef = useRef<string | null>(null);
  const loadedExecutionIdRef = useRef<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const isCancelled = () => controller.signal.aborted;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    // Reset backoff state on every fresh mount of this polling loop —
    // switching executions, or reloading the current one after a mutation,
    // should always start back at the fast interval rather than carry over
    // whatever delay a previous execution's backoff had reached.
    pollDelayRef.current = FAST_REFRESH_INTERVAL_MS;
    progressSignatureRef.current = null;
    const isFirstLoad = loadedExecutionIdRef.current !== executionId;

    const load = async (isInitial: boolean) => {
      if (isInitial && isFirstLoad) {
        setLoading(true);
        setError("");
      }
      try {
        const parsedExecutionId = parseUuidV7(executionId);
        const executionData = await unwrapTreatyResponse(
          apiClient.api["pipeline-executions"]({
            pipelineExecutionId: parsedExecutionId,
          }).get(),
        );
        if (isCancelled()) return;

        const executionResult =
          pipelineExecutionSchema.safeParse(executionData);
        if (!executionResult.success) {
          throw new Error("Received invalid pipeline execution payload");
        }
        const nextExecution = executionResult.data;
        setExecution(nextExecution);

        const signature = buildExecutionProgressSignature(nextExecution);
        if (isInitial) {
          // Nothing to compare against yet — just record it and leave the
          // delay at the fast interval for the first subsequent poll.
          progressSignatureRef.current = signature;
        } else if (signature === progressSignatureRef.current) {
          // Nothing structurally meaningful changed since the last poll —
          // back off.
          pollDelayRef.current = Math.min(
            pollDelayRef.current * REFRESH_BACKOFF_FACTOR,
            MAX_REFRESH_INTERVAL_MS,
          );
        } else {
          // Something changed — poll fast again.
          pollDelayRef.current = FAST_REFRESH_INTERVAL_MS;
          progressSignatureRef.current = signature;
        }

        if (isInitial) {
          const [definitionData, workItemData] = await Promise.all([
            unwrapTreatyResponse(
              apiClient.api["pipeline-definitions"]({
                pipelineDefinitionId: nextExecution.pipelineDefinitionId,
              }).get(),
            ).catch(() => null),
            unwrapTreatyResponse(
              apiClient.api["work-items"]({
                workItemId: nextExecution.workItemId,
              }).get(),
            ).catch(() => null),
          ]);
          if (isCancelled()) return;

          const parsedDefinition =
            pipelineDefinitionSchema.safeParse(definitionData);
          const loadedDefinition = parsedDefinition.success
            ? parsedDefinition.data
            : null;
          setDefinition(loadedDefinition);
          const loadedVersion = await loadRunVersion(
            apiClient,
            nextExecution,
            loadedDefinition,
          ).catch(() => null);
          if (isCancelled()) return;
          setVersion(loadedVersion);

          if (workItemData) {
            setWorkItem(workItemData);
          }
        }

        if (isInitial) {
          loadedExecutionIdRef.current = executionId;
          setLoading(false);
        }

        const shouldContinuePolling =
          ACTIVE_EXECUTION_STATUSES.has(nextExecution.status) ||
          hasPendingTaskSnapshots(nextExecution);
        if (shouldContinuePolling && !isCancelled()) {
          // A hidden tab makes no requests: the timer waits for the tab to be
          // visible again, then catches up once at the fast interval.
          timeoutId = setTimeout(() => {
            void pollWhenVisible();
          }, pollDelayRef.current);
        }
      } catch (loadError) {
        if (isCancelled()) return;
        if (isInitial && isFirstLoad) {
          setLoading(false);
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Failed to load pipeline execution",
          );
        }
      }
    };

    const pollWhenVisible = async () => {
      if (isPageHidden()) {
        await waitUntilVisible(controller.signal);
        if (isCancelled()) return;
        pollDelayRef.current = FAST_REFRESH_INTERVAL_MS;
      }
      await load(false);
    };

    void load(true);

    return () => {
      controller.abort();
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [apiClient, executionId, reloadNonce]);

  const runMutation = useCallback(
    (
      label: string,
      fallbackError: string,
      mutate: () => Promise<unknown>,
    ): Promise<boolean> =>
      new Promise((resolve) => {
        startTransition(async () => {
          setActionError("");
          setPendingActionLabel(label);
          try {
            await mutate();
            setReloadNonce((current) => current + 1);
            resolve(true);
          } catch (mutationError) {
            setActionError(parseApiError(mutationError, fallbackError));
            resolve(false);
          } finally {
            setPendingActionLabel("");
          }
        });
      }),
    [],
  );

  const visitRoute = useCallback(
    (visitId: string) => {
      if (!execution) throw new Error("Pipeline execution is not loaded");
      return apiClient.api["pipeline-executions"]({
        pipelineExecutionId: parseUuidV7(execution.id),
      }).visits({ visitId: parseUuidV7(visitId) });
    },
    [apiClient, execution],
  );

  const rerunVisit = useCallback(
    (visitId: string) => {
      if (!execution) return;
      void runMutation("Rerunning", "Failed to rerun visit", () =>
        unwrapTreatyResponse(visitRoute(visitId).rerun.post()),
      );
    },
    [execution, runMutation, visitRoute],
  );

  const postVisitRoute = useCallback(
    (visitId: string, body: OverruleRouteBody) =>
      unwrapTreatyResponse(visitRoute(visitId).route.post(body)),
    [visitRoute],
  );

  const decideVisit = useCallback(
    (visitId: string, action: string, body?: string) => {
      if (!execution) return Promise.resolve(false);
      const visit = execution.visits.find(
        (candidate) => candidate.id === visitId,
      );
      const label =
        visit?.actions?.find((candidate) => candidate.key === action)?.label ??
        action;
      return runMutation(label, "Failed to record decision", () =>
        unwrapTreatyResponse(
          visitRoute(visitId).decision.post(
            body ? { action, body } : { action },
          ),
        ),
      );
    },
    [execution, runMutation, visitRoute],
  );

  const questionRoute = useCallback(
    (questionId: string) => {
      if (!execution) throw new Error("Pipeline execution is not loaded");
      return apiClient.api["pipeline-executions"]({
        pipelineExecutionId: parseUuidV7(execution.id),
      }).questions({ questionId: parseUuidV7(questionId) });
    },
    [apiClient, execution],
  );

  const continueWithoutReply = useCallback(
    (questionId: string) => {
      if (!execution) return Promise.resolve(false);
      return runMutation("Continuing", "Failed to continue without reply", () =>
        unwrapTreatyResponse(questionRoute(questionId).continue.post()),
      );
    },
    [execution, runMutation, questionRoute],
  );

  const answerQuestion = useCallback(
    (questionId: string, body: string) => {
      if (!execution) return Promise.resolve(false);
      return runMutation("Sending answer", "Failed to send the answer", () =>
        unwrapTreatyResponse(questionRoute(questionId).answer.post({ body })),
      );
    },
    [execution, runMutation, questionRoute],
  );

  const sendVisitMessage = useCallback(
    (
      visitId: string,
      body: string,
      quoteText?: string,
    ): Promise<SendStepMessageOutcome> => {
      if (!execution) {
        return Promise.resolve({
          ok: false,
          error: "Pipeline execution is not loaded",
        });
      }
      return new Promise((resolve) => {
        startTransition(async () => {
          setPendingActionLabel("Sending message");
          try {
            const result = await unwrapTreatyResponse(
              visitRoute(visitId).messages.post(
                quoteText ? { body, quoteText } : { body },
              ),
            );
            const parsedExecution = pipelineExecutionSchema.safeParse(
              result.pipelineExecution,
            );
            if (parsedExecution.success) {
              setExecution(parsedExecution.data);
            }
            setReloadNonce((current) => current + 1);
            resolve({ ok: true });
          } catch (sendError) {
            resolve({
              ok: false,
              error: parseApiError(sendError, "Failed to send message"),
            });
          } finally {
            setPendingActionLabel("");
          }
        });
      });
    },
    [execution, visitRoute],
  );

  const reload = useCallback(() => {
    setReloadNonce((current) => current + 1);
  }, []);

  return {
    execution,
    definition,
    version,
    workItem,
    loading,
    error,
    actionError,
    pendingActionLabel,
    isMutating,
    rerunVisit,
    postVisitRoute,
    decideVisit,
    continueWithoutReply,
    answerQuestion,
    sendVisitMessage,
    reload,
  };
}
