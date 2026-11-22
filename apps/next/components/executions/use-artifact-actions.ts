"use client";

import { useState } from "react";
import { basename } from "./format-artifact";
import type {
  ArtifactContract,
  ArtifactDownloadUrlContract,
} from "@scarn/api/frontend-contracts";

export type ArtifactActions = {
  /** Artifacts currently minting a download URL. */
  downloadingIds: ReadonlySet<string>;
  /** Playwright traces currently minting a viewer URL. */
  viewingTraceIds: ReadonlySet<string>;
  /** A download-time problem not already reported by the list hook. */
  actionError: string;
  download: (artifact: ArtifactContract) => Promise<void>;
  viewTrace: (artifact: ArtifactContract) => Promise<void>;
};

/**
 * Download and "View Playwright trace" for one task's artifacts, with
 * per-artifact pending state. Shared by the Details drawer's Artifacts
 * section and the inline artifacts card at the end of a run.
 */
export function useArtifactActions(
  getDownloadUrl: (
    artifactId: string,
  ) => Promise<ArtifactDownloadUrlContract | null>,
): ArtifactActions {
  const [downloadingIds, setDownloadingIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [viewingTraceIds, setViewingTraceIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [actionError, setActionError] = useState("");

  const withPending = async (
    setIds: (
      update: (current: ReadonlySet<string>) => ReadonlySet<string>,
    ) => void,
    artifact: ArtifactContract,
    unavailableMessage: string,
    use: (url: string) => void,
  ): Promise<void> => {
    setActionError("");
    setIds((current) => new Set(current).add(artifact.id));
    try {
      const result = await getDownloadUrl(artifact.id);
      if (!result) return;
      if (result.url === null) {
        setActionError(unavailableMessage);
        return;
      }
      use(result.url);
    } finally {
      setIds((current) => {
        const next = new Set(current);
        next.delete(artifact.id);
        return next;
      });
    }
  };

  const download = (artifact: ArtifactContract) =>
    withPending(
      setDownloadingIds,
      artifact,
      "This artifact can't be downloaded right now. Please try again later.",
      (url) => {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = basename(artifact.relativeStorePath);
        anchor.rel = "noopener";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      },
    );

  const viewTrace = (artifact: ArtifactContract) =>
    withPending(
      setViewingTraceIds,
      artifact,
      "This trace can't be opened right now. Please try again later.",
      (url) => {
        const viewerUrl = `https://trace.playwright.dev/?trace=${encodeURIComponent(url)}`;
        window.open(viewerUrl, "_blank", "noopener,noreferrer");
      },
    );

  return { downloadingIds, viewingTraceIds, actionError, download, viewTrace };
}
