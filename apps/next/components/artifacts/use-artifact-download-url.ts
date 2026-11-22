"use client";

import { useCallback, useEffect, useState } from "react";
import {
  artifactDownloadUrlSchema,
  parseUuidV7,
  projectArtifactDetailSchema,
  type ProjectArtifactDetailContract,
} from "@scarn/api/frontend-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { apiErrorCode, parseApiError } from "@/app/_lib/api-error";

export type ArtifactUrlState =
  | { status: "loading" }
  | { status: "ready"; url: string | null }
  | { status: "expired" }
  | { status: "error"; message: string };

const READ_LIMIT_MESSAGE =
  "Your organization has reached its monthly artifact download limit.";

// eslint-disable-next-line local/no-unknown-parameter-type
const errorStatus = (error: unknown): number | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  const status = "status" in error ? error.status : undefined;
  return typeof status === "number" ? status : undefined;
};

/**
 * Mints the existing 300s presigned download URL for one artifact. `fetchUrl`
 * mints a fresh one (e.g. for the download button, after the preview URL may
 * have lapsed); it resolves to null and updates `state` on failure.
 */
export function useArtifactDownloadUrl(
  artifact: Pick<ProjectArtifactDetailContract, "id" | "taskRunId"> | null,
  { auto }: { auto: boolean },
): { state: ArtifactUrlState; fetchUrl: () => Promise<string | null> } {
  const [state, setState] = useState<ArtifactUrlState>({ status: "loading" });
  const artifactId = artifact?.id ?? null;
  const taskRunId = artifact?.taskRunId ?? null;

  const fetchUrl = useCallback(async (): Promise<string | null> => {
    if (!artifactId || !taskRunId) return null;
    const { data, error } = await getBrowserScarnApiClient()
      .api["task-runs"]({ taskRunId: parseUuidV7(taskRunId) })
      .artifacts({ artifactId: parseUuidV7(artifactId) })
      ["download-url"].get();
    if (error) {
      const status = errorStatus(error.value);
      if (status === 410 || apiErrorCode(error) === "ARTIFACT_EXPIRED") {
        setState({ status: "expired" });
      } else if (status === 402) {
        setState({ status: "error", message: READ_LIMIT_MESSAGE });
      } else {
        setState({
          status: "error",
          message: parseApiError(error, "Could not load this file."),
        });
      }
      return null;
    }
    const parsed = artifactDownloadUrlSchema.safeParse(data);
    if (!parsed.success) {
      setState({ status: "error", message: "Could not load this file." });
      return null;
    }
    setState({ status: "ready", url: parsed.data.url });
    return parsed.data.url;
  }, [artifactId, taskRunId]);

  useEffect(() => {
    if (auto) void fetchUrl();
  }, [auto, fetchUrl]);

  return { state, fetchUrl };
}

export type ProjectArtifactState =
  | { status: "loading" }
  | { status: "loaded"; artifact: ProjectArtifactDetailContract }
  | { status: "error"; message: string };

/** Loads the artifact page metadata for one artifact. */
export function useProjectArtifact(
  projectId: string,
  artifactId: string,
): ProjectArtifactState {
  const [state, setState] = useState<ProjectArtifactState>({
    status: "loading",
  });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    void getBrowserScarnApiClient()
      .api.projects({ projectId: parseUuidV7(projectId) })
      .artifacts({ artifactId: parseUuidV7(artifactId) })
      .get()
      .then(({ data, error }) => {
        if (cancelled) return;
        const parsed = error
          ? null
          : projectArtifactDetailSchema.safeParse(data);
        if (!parsed?.success) {
          setState({
            status: "error",
            message: error
              ? parseApiError(error, "Could not load this artifact.")
              : "Could not load this artifact.",
          });
          return;
        }
        setState({ status: "loaded", artifact: parsed.data });
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, artifactId]);

  return state;
}

/** Saves the file through a temporary `<a download>`. */
export function triggerDownload(url: string, fileName: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
