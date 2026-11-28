"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { unwrapTreatyResponse } from "@/app/_lib/scarn-treaty";
import {
  artifactSchema,
  artifactDownloadUrlSchema,
  listArtifactBundlesResponseSchema,
  parseUuidV7,
} from "@scarn/api/frontend-contracts";
import { z } from "zod";
import type {
  ArtifactBundleContract,
  ArtifactContract,
  ArtifactDownloadUrlContract,
} from "@scarn/api/frontend-contracts";

/** User-facing copy when the org has exhausted its monthly read allowance. */
const READ_LIMIT_MESSAGE =
  "You've reached your monthly artifact download limit. Upgrade your plan to download artifacts again.";

/** User-facing copy when the artifact's stored bytes have aged out. */
const ARTIFACT_EXPIRED_MESSAGE =
  "This artifact has expired and is no longer available.";

/**
 * Detects the server's 402 read-cap error (`UsageLimitExceededError`, serialized
 * as a problem-details body with `status: 402` and a `USAGE_LIMIT_EXCEEDED_READ`
 * code). Treaty throws the parsed error body as the rejection value, so we match
 * on its shape rather than on an HTTP Response object. Mirrors the identical
 * check in `use-task-run-logs.ts`; replicated locally rather than shared
 * because it is a one-line shape guard and extracting a util would touch the
 * logs hook for no net gain.
 */
// eslint-disable-next-line local/no-unknown-parameter-type
const isReadLimitExceededError = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const status = "status" in error ? error.status : undefined;
  const code = "code" in error ? error.code : undefined;
  return (
    status === 402 ||
    (typeof code === "string" && code.startsWith("USAGE_LIMIT_EXCEEDED"))
  );
};

/**
 * Detects the server's 410 expired-artifact error (`ArtifactExpiredError`,
 * serialized as a problem-details body with `status: 410` and an
 * `ARTIFACT_EXPIRED` code). Same shape-guard style as
 * {@link isReadLimitExceededError} above, matched on either the HTTP status
 * or the error code so a code change on one side alone still matches.
 */
// eslint-disable-next-line local/no-unknown-parameter-type
const isArtifactExpiredError = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const status = "status" in error ? error.status : undefined;
  const code = "code" in error ? error.code : undefined;
  return status === 410 || code === "ARTIFACT_EXPIRED";
};

/** Lifecycle of the lazily-loaded artifact list. */
export type ArtifactsStatus = "idle" | "loading" | "loaded" | "error";

export type TaskRunArtifactsData = {
  /** The task's persisted artifacts, once loaded. */
  artifacts: ArtifactContract[];
  /**
   * The task's artifact bundles, fetched alongside the artifacts. A failed
   * bundles fetch reads as no bundles, so member files still list loose.
   */
  bundles: ArtifactBundleContract[];
  /** Coarse lifecycle state for driving idle/loading/loaded/error UI. */
  status: ArtifactsStatus;
  /** True while the list request is in flight (equivalent to status === "loading"). */
  loading: boolean;
  /** Load/list error message, or "" when there is none. */
  error: string;
  /**
   * Lazily fetches the artifact list. Safe to call repeatedly; a call while a
   * fetch is already in flight is ignored. Intended to be triggered when the
   * user expands the Artifacts section (not on mount).
   */
  load: () => void;
  /**
   * Fetches a presigned download URL for a single artifact. Returns the parsed
   * contract on success, or `null` on failure (with the error surfaced via the
   * hook's `error` state, including the 402 read-cap and 410 expired-artifact
   * messages).
   */
  getDownloadUrl: (
    artifactId: string,
  ) => Promise<ArtifactDownloadUrlContract | null>;
};

/**
 * Owns lazy artifact-listing and per-artifact download-URL minting for a single
 * task. Unlike {@link useTaskRunLogs}, this does NOT fetch on
 * mount: the consumer calls {@link TaskRunArtifactsData.load} when the
 * Artifacts section is expanded, keeping read-side cost off the hot path.
 *
 * Responses are re-validated against the frontend contracts (`artifactSchema` /
 * `artifactDownloadUrlSchema`) so a drifting server payload fails loudly rather
 * than propagating an ill-typed value into the UI.
 */
export function useTaskRunArtifacts(
  taskRunId: string | null,
): TaskRunArtifactsData {
  const apiClient = useMemo(() => getBrowserScarnApiClient(), []);
  const [artifacts, setArtifacts] = useState<ArtifactContract[]>([]);
  const [bundles, setBundles] = useState<ArtifactBundleContract[]>([]);
  const [status, setStatus] = useState<ArtifactsStatus>("idle");
  const [error, setError] = useState("");
  // Guards against overlapping list fetches (e.g. rapid expand/collapse).
  const loadingRef = useRef(false);

  const load = useCallback(() => {
    if (!taskRunId || loadingRef.current) {
      return;
    }
    loadingRef.current = true;
    setStatus("loading");
    setError("");

    void (async () => {
      try {
        const id = parseUuidV7(taskRunId);
        const taskRunApi = apiClient.api["task-runs"]({ taskRunId: id });
        const [result, bundlesResult] = await Promise.all([
          unwrapTreatyResponse(taskRunApi.artifacts.get()),
          unwrapTreatyResponse(taskRunApi["artifact-bundles"].get()).catch(
            () => null,
          ),
        ]);
        const parsed = z.array(artifactSchema).safeParse(result);
        if (!parsed.success) {
          setStatus("error");
          setError("Received invalid artifacts payload");
          return;
        }
        const parsedBundles =
          listArtifactBundlesResponseSchema.safeParse(bundlesResult);
        setArtifacts(parsed.data);
        setBundles(parsedBundles.success ? parsedBundles.data : []);
        setStatus("loaded");
      } catch (loadError) {
        setStatus("error");
        if (isReadLimitExceededError(loadError)) {
          setError(READ_LIMIT_MESSAGE);
          return;
        }
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Failed to load artifacts",
        );
      } finally {
        loadingRef.current = false;
      }
    })();
  }, [apiClient, taskRunId]);

  const getDownloadUrl = useCallback(
    async (artifactId: string): Promise<ArtifactDownloadUrlContract | null> => {
      if (!taskRunId) {
        return null;
      }
      try {
        const id = parseUuidV7(taskRunId);
        const parsedArtifactId = parseUuidV7(artifactId);
        const result = await unwrapTreatyResponse(
          apiClient.api["task-runs"]({ taskRunId: id })
            .artifacts({ artifactId: parsedArtifactId })
            ["download-url"].get(),
        );
        const parsed = artifactDownloadUrlSchema.safeParse(result);
        if (!parsed.success) {
          setError("Received invalid artifact download URL payload");
          return null;
        }
        return parsed.data;
      } catch (downloadError) {
        if (isReadLimitExceededError(downloadError)) {
          setError(READ_LIMIT_MESSAGE);
          return null;
        }
        if (isArtifactExpiredError(downloadError)) {
          setError(ARTIFACT_EXPIRED_MESSAGE);
          return null;
        }
        setError(
          downloadError instanceof Error
            ? downloadError.message
            : "Failed to get artifact download URL",
        );
        return null;
      }
    },
    [apiClient, taskRunId],
  );

  return {
    artifacts,
    bundles,
    status,
    loading: status === "loading",
    error,
    load,
    getDownloadUrl,
  };
}
