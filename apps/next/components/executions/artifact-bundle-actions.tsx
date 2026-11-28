"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Tooltip,
} from "@mui/material";
import FileDownloadOutlinedIcon from "@mui/icons-material/FileDownloadOutlined";
import { artifactBundlePagePath } from "@/components/artifacts/artifact-page-path";
import { ArtifactSharePanel } from "@/components/artifacts/artifact-share-panel";
import { useArtifactBundleShare } from "@/components/artifacts/use-artifact-bundle";
import type { ArtifactActions } from "./use-artifact-actions";
import type {
  ArtifactBundleContract,
  ArtifactContract,
} from "@scarn/api/frontend-contracts";

/** A run's artifacts split into its bundles and the files outside any bundle. */
export type GroupedArtifacts = {
  bundles: ArtifactBundleContract[];
  loose: ArtifactContract[];
  /** Each bundle's entry file, when it is among the run's artifacts. */
  entryArtifacts: ReadonlyMap<string, ArtifactContract>;
};

const joinPath = (rootPath: string, entryPath: string) =>
  `${rootPath.replace(/\/+$/, "")}/${entryPath.replace(/^\/+/, "")}`;

/**
 * Collapses bundle members into their bundle. A member whose bundle isn't in
 * `bundles` (e.g. the bundles fetch failed) stays a loose file.
 */
export function groupArtifactsByBundle(
  artifacts: readonly ArtifactContract[],
  bundles: readonly ArtifactBundleContract[],
): GroupedArtifacts {
  const byId = new Map(bundles.map((bundle) => [bundle.id, bundle]));
  const entryArtifacts = new Map<string, ArtifactContract>();
  const loose: ArtifactContract[] = [];
  for (const artifact of artifacts) {
    const bundle = artifact.bundleId ? byId.get(artifact.bundleId) : undefined;
    if (!bundle) {
      loose.push(artifact);
      continue;
    }
    if (
      artifact.relativeStorePath === joinPath(bundle.rootPath, bundle.entryPath)
    ) {
      entryArtifacts.set(bundle.id, artifact);
    }
  }
  return { bundles: [...bundles], loose, entryArtifacts };
}

/** The chip shown on a bundle row that isn't simply ready. */
export const bundleStatusLabel = (
  bundle: ArtifactBundleContract,
): string | null => {
  if (bundle.expired) return "Expired";
  if (bundle.status === "pending") return "Uploading";
  if (bundle.status === "failed") return "Failed";
  return null;
};

/** Whether a bundle row should read as unavailable (dimmed). */
export const isBundleDimmed = (bundle: ArtifactBundleContract): boolean =>
  bundle.expired || bundle.status !== "ready";

function ShareDialog({
  name,
  open,
  onClose,
  share,
}: {
  name: string;
  open: boolean;
  onClose: () => void;
  share: ReturnType<typeof useArtifactBundleShare>;
}) {
  const { state, busy, actionError } = share;
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Share {name}</DialogTitle>
      <DialogContent>
        {state.status === "loaded" ? (
          <ArtifactSharePanel
            share={state.share}
            busy={busy}
            error={actionError}
            onShare={share.share}
            onRevoke={share.revoke}
          />
        ) : busy ? (
          <Box sx={{ display: "flex", justifyContent: "center", py: 2 }}>
            <CircularProgress size={24} aria-label="Sharing" />
          </Box>
        ) : (
          <Alert severity="error" role="alert">
            {actionError ||
              (state.status === "error"
                ? state.message
                : "Could not share this bundle.")}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

/**
 * A bundle row's trailing controls: a status chip, **Open** (the bundle
 * page), **Share** (creates or returns the link, then shows it with the
 * public-access warning in a dialog) and **Download** (the bundle's entry
 * file; its other files download from the bundle page). Pending bundles
 * disable everything; failed and expired ones can still be opened. Share
 * is hidden when `canShare` is false.
 */
export function ArtifactBundleActions({
  bundle,
  entryArtifact,
  actions,
  canShare,
}: {
  bundle: ArtifactBundleContract;
  entryArtifact: ArtifactContract | undefined;
  actions: ArtifactActions;
  canShare: boolean;
}) {
  const share = useArtifactBundleShare(bundle.projectId, bundle.id, {
    auto: false,
  });
  const [dialogOpen, setDialogOpen] = useState(false);
  const status = bundleStatusLabel(bundle);
  const usable = bundle.status === "ready" && !bundle.expired;
  const canOpen = bundle.status !== "pending";
  const canDownload =
    usable && entryArtifact !== undefined && entryArtifact.storeRef !== null;
  const downloading =
    entryArtifact !== undefined && actions.downloadingIds.has(entryArtifact.id);

  const handleShare = () => {
    setDialogOpen(true);
    void share.share();
  };

  return (
    <>
      {status ? <Chip size="small" label={status} variant="outlined" /> : null}
      {canOpen ? (
        <Button
          size="small"
          variant="outlined"
          component={Link}
          href={artifactBundlePagePath(bundle.projectId, bundle.id)}
          aria-label={`Open ${bundle.name}`}
        >
          Open
        </Button>
      ) : (
        <Button
          size="small"
          variant="outlined"
          disabled
          aria-label={`Open ${bundle.name}`}
        >
          Open
        </Button>
      )}
      {canShare ? (
        <Button
          size="small"
          variant="outlined"
          disabled={!usable}
          onClick={handleShare}
          aria-label={`Share ${bundle.name}`}
        >
          Share
        </Button>
      ) : null}
      {downloading ? (
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 40,
            height: 40,
          }}
        >
          <CircularProgress size={20} />
        </Box>
      ) : (
        <Tooltip title={canDownload ? "Download entry file" : ""}>
          <span>
            <IconButton
              size="small"
              disabled={!canDownload}
              onClick={() => {
                if (entryArtifact) void actions.download(entryArtifact);
              }}
              aria-label={`Download ${bundle.name}`}
            >
              <FileDownloadOutlinedIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      )}
      <ShareDialog
        name={bundle.name}
        open={dialogOpen}
        onClose={() => {
          setDialogOpen(false);
        }}
        share={share}
      />
    </>
  );
}
