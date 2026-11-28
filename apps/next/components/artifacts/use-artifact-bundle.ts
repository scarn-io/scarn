"use client";

import { useCallback, useEffect, useState } from "react";
import {
  artifactPreviewSchema,
  artifactShareSchema,
  parseUuidV7,
  projectArtifactBundleDetailSchema,
  type ArtifactShareContract,
  type ProjectArtifactBundleDetailContract,
} from "@scarn/api/frontend-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { apiErrorCode, parseApiError } from "@/app/_lib/api-error";

const bundleApi = (projectId: string, bundleId: string) =>
  getBrowserScarnApiClient()
    .api.projects({ projectId: parseUuidV7(projectId) })
    ["artifact-bundles"]({ bundleId: parseUuidV7(bundleId) });

export type ProjectArtifactBundleState =
  | { status: "loading" }
  | { status: "loaded"; bundle: ProjectArtifactBundleDetailContract }
  | { status: "error"; message: string };

/** Loads the bundle page metadata (the bundle and its member files). */
export function useProjectArtifactBundle(
  projectId: string,
  bundleId: string,
): ProjectArtifactBundleState {
  const [state, setState] = useState<ProjectArtifactBundleState>({
    status: "loading",
  });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    void bundleApi(projectId, bundleId)
      .get()
      .then(({ data, error }) => {
        if (cancelled) return;
        const parsed = error
          ? null
          : projectArtifactBundleDetailSchema.safeParse(data);
        if (!parsed?.success) {
          setState({
            status: "error",
            message: error
              ? parseApiError(error, "Could not load this bundle.")
              : "Could not load this bundle.",
          });
          return;
        }
        setState({ status: "loaded", bundle: parsed.data });
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, bundleId]);

  return state;
}

export type ArtifactBundleShareState =
  | { status: "loading" }
  | { status: "loaded"; share: ArtifactShareContract }
  | { status: "error"; message: string };

export type ArtifactBundleShare = {
  state: ArtifactBundleShareState;
  busy: boolean;
  actionError: string;
  share: () => Promise<ArtifactShareContract | null>;
  revoke: () => Promise<ArtifactShareContract | null>;
  reload: () => Promise<void>;
};

const SHARING_DISABLED_MESSAGE = "Sharing is off on this server.";

/**
 * A bundle's share link: loads its state and exposes `share()` (create or
 * return the active link) and `revoke()`. A failed mutation leaves the last
 * loaded state in place and sets `actionError`; a 409 sharing-disabled
 * response also reloads the state, which then reads `unavailable`. Pass
 * `auto: false` to skip the initial load (e.g. a list row that only loads
 * on demand).
 */
export function useArtifactBundleShare(
  projectId: string,
  bundleId: string,
  { auto = true }: { auto?: boolean } = {},
): ArtifactBundleShare {
  const [state, setState] = useState<ArtifactBundleShareState>({
    status: "loading",
  });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");

  const reload = useCallback(async () => {
    const { data, error } = await bundleApi(projectId, bundleId).share.get();
    const parsed = error ? null : artifactShareSchema.safeParse(data);
    if (!parsed?.success) {
      setState({
        status: "error",
        message: error
          ? parseApiError(error, "Could not load the share link.")
          : "Could not load the share link.",
      });
      return;
    }
    setState({ status: "loaded", share: parsed.data });
  }, [projectId, bundleId]);

  const mutate = useCallback(
    async (
      request: () => Promise<{ data: unknown; error: unknown }>,
      fallback: string,
    ): Promise<ArtifactShareContract | null> => {
      setBusy(true);
      setActionError("");
      try {
        const { data, error } = await request();
        if (error) {
          if (apiErrorCode(error) === "ARTIFACT_SHARING_DISABLED") {
            setActionError(SHARING_DISABLED_MESSAGE);
            await reload();
          } else {
            setActionError(parseApiError(error, fallback));
          }
          return null;
        }
        const parsed = artifactShareSchema.safeParse(data);
        if (!parsed.success) {
          setActionError(fallback);
          return null;
        }
        setState({ status: "loaded", share: parsed.data });
        return parsed.data;
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  const share = useCallback(
    () =>
      mutate(
        () => bundleApi(projectId, bundleId).share.post(),
        "Could not share this bundle.",
      ),
    [mutate, projectId, bundleId],
  );

  const revoke = useCallback(
    () =>
      mutate(
        () => bundleApi(projectId, bundleId).share.delete(),
        "Could not revoke the link.",
      ),
    [mutate, projectId, bundleId],
  );

  useEffect(() => {
    if (auto) void reload();
  }, [auto, reload]);

  return { state, busy, actionError, share, revoke, reload };
}

export type ArtifactBundlePreviewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; url: string; expiresAt: string }
  | { status: "unavailable" }
  | { status: "error"; message: string };

/** How long before a preview token lapses the hook mints the next one. */
export const PREVIEW_REFRESH_LEAD_MS = 60_000;
const MIN_REFRESH_DELAY_MS = 5_000;

/**
 * Mints a short-lived preview URL for a bundle on the content origin, and
 * mints a fresh one `PREVIEW_REFRESH_LEAD_MS` before each token expires so
 * an open page keeps working. Each refresh changes the URL, which reloads an
 * iframe pointed at it. Sharing being off on this server (409) reads as
 * `unavailable`. Does nothing while `enabled` is false.
 */
export function useArtifactBundlePreview(
  projectId: string,
  bundleId: string,
  enabled: boolean,
): ArtifactBundlePreviewState {
  const [state, setState] = useState<ArtifactBundlePreviewState>({
    status: enabled ? "loading" : "idle",
  });

  useEffect(() => {
    if (!enabled) {
      setState({ status: "idle" });
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const mint = async () => {
      const { data, error } = await bundleApi(
        projectId,
        bundleId,
      ).preview.post();
      if (cancelled) return;
      if (error) {
        setState(
          apiErrorCode(error) === "ARTIFACT_SHARING_DISABLED"
            ? { status: "unavailable" }
            : {
                status: "error",
                message: parseApiError(error, "Could not load the preview."),
              },
        );
        return;
      }
      const parsed = artifactPreviewSchema.safeParse(data);
      if (!parsed.success) {
        setState({ status: "error", message: "Could not load the preview." });
        return;
      }
      setState({ status: "ready", ...parsed.data });
      const delay = Math.max(
        MIN_REFRESH_DELAY_MS,
        Date.parse(parsed.data.expiresAt) -
          Date.now() -
          PREVIEW_REFRESH_LEAD_MS,
      );
      timer = setTimeout(() => {
        void mint();
      }, delay);
    };

    setState({ status: "loading" });
    void mint();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [projectId, bundleId, enabled]);

  return state;
}
