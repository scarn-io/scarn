"use client";

import { useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  Stack,
  Typography,
} from "@mui/material";
import DeleteIcon from "@mui/icons-material/Delete";
import { RecordList } from "@/components/common/record-list/record-list";
import { RecordListRow } from "@/components/common/record-list/record-list-row";
import { RecordListEmpty } from "@/components/common/record-list/record-list-empty";
import { useHasProjectPermission } from "@/components/project-route-context";
import { basename, formatArtifactMeta } from "@/components/executions/format-artifact";
import { useProjectArtifacts } from "./use-project-artifacts";
import type { ProjectArtifactContract } from "@scarn/api/frontend-contracts";

/**
 * Settings page "Artifacts" section: lists every artifact a pipeline step in
 * this project has produced, and lets project members with the
 * `executions:delete` permission remove artifacts (individually or as a
 * batch) to free up storage.
 *
 * Read access (the list itself) is available to anyone who can reach the
 * Settings page (`executions:read`, gated upstream by project membership);
 * only the delete affordances — checkboxes, per-row delete buttons, and the
 * header "Delete selected" button — are hidden for viewers lacking
 * `executions:delete`.
 *
 * NOTE on the `nodeKey` secondary line: the plan asked for it to link to the
 * originating task's detail page. No such page exists in this
 * app (see this phase's step report for the full explanation) — it renders
 * as plain, non-link text instead.
 */
export function ProjectArtifactsPanel({
  projectId,
  initialArtifacts,
  initialHasMore,
}: {
  projectId: string;
  initialArtifacts: ProjectArtifactContract[];
  initialHasMore: boolean;
}) {
  const canDelete = useHasProjectPermission("executions:delete");
  const { artifacts, hasMore, loading, error, deleteOne, deleteMany } =
    useProjectArtifacts(projectId, initialArtifacts, initialHasMore);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  // Non-null while the delete-confirmation dialog is open; holds the ids the
  // dialog would delete on confirm (one for a per-row delete, many for the
  // header "Delete selected" action).
  const [confirmIds, setConfirmIds] = useState<string[] | null>(null);

  const toggleSelected = (artifactId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(artifactId)) {
        next.delete(artifactId);
      } else {
        next.add(artifactId);
      }
      return next;
    });
  };

  const handleConfirmDelete = async () => {
    if (!confirmIds) return;
    const ids = confirmIds;
    const [onlyId] = ids;
    const ok =
      ids.length === 1 && onlyId
        ? await deleteOne(onlyId)
        : await deleteMany(ids);
    // Dismiss the dialog regardless of outcome, matching this codebase's
    // established confirm-then-dismiss convention (see
    // `project-collaborators-panel.tsx`'s `handleRevoke`) — failures surface
    // via the persistent Alert above the list rather than staying pinned to
    // the (now-closed) dialog.
    setConfirmIds(null);
    if (ok) {
      setSelectedIds((current) => {
        const next = new Set(current);
        for (const id of ids) {
          next.delete(id);
        }
        return next;
      });
    }
  };

  return (
    <Stack spacing={1.5}>
      {error ? <Alert severity="error">{error}</Alert> : null}
      <RecordList
        title="Artifacts"
        count={artifacts.length}
        headerAction={
          canDelete && selectedIds.size > 0 ? (
            <Button
              size="small"
              variant="outlined"
              color="error"
              startIcon={<DeleteIcon fontSize="small" />}
              disabled={loading}
              onClick={() => {
                setConfirmIds(Array.from(selectedIds));
              }}
            >
              {`Delete selected (${String(selectedIds.size)})`}
            </Button>
          ) : undefined
        }
      >
        {artifacts.length === 0 ? (
          <RecordListEmpty
            title="No artifacts"
            description="Pipeline steps in this project haven't produced any downloadable artifacts yet."
          />
        ) : (
          artifacts.map((artifact, index) => {
            const isExpired = artifact.storeRef === null;
            const name = basename(artifact.relativeStorePath);
            return (
              <RecordListRow
                key={artifact.id}
                isFirst={index === 0}
                primary={
                  <Typography
                    variant="body2"
                    sx={{
                      fontWeight: 600,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      opacity: isExpired ? 0.5 : 1,
                    }}
                  >
                    {name}
                  </Typography>
                }
                secondary={
                  <Stack spacing={0.25}>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ opacity: isExpired ? 0.5 : 1 }}
                    >
                      {formatArtifactMeta(artifact)}
                    </Typography>
                    {artifact.nodeKey ? (
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ opacity: isExpired ? 0.5 : 1 }}
                      >
                        {`From: ${artifact.nodeKey}`}
                      </Typography>
                    ) : null}
                  </Stack>
                }
                trailing={
                  <>
                    {isExpired ? (
                      <Chip size="small" label="Expired" variant="outlined" />
                    ) : null}
                    {canDelete ? (
                      <>
                        <Checkbox
                          size="small"
                          checked={selectedIds.has(artifact.id)}
                          disabled={loading}
                          onChange={() => {
                            toggleSelected(artifact.id);
                          }}
                          aria-label={`Select ${name}`}
                        />
                        <IconButton
                          size="small"
                          color="error"
                          disabled={loading}
                          onClick={() => {
                            setConfirmIds([artifact.id]);
                          }}
                          aria-label={`Delete ${name}`}
                        >
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </>
                    ) : null}
                  </>
                }
              />
            );
          })
        )}
      </RecordList>
      {hasMore ? (
        <Typography variant="caption" color="text.secondary">
          More artifacts exist for this project than are shown here.
        </Typography>
      ) : null}
      <Dialog
        open={confirmIds !== null}
        onClose={() => {
          if (!loading) setConfirmIds(null);
        }}
      >
        <DialogTitle>
          {confirmIds
            ? `Delete ${String(confirmIds.length)} artifact${confirmIds.length === 1 ? "" : "s"}?`
            : ""}
        </DialogTitle>
        <DialogContent>
          <DialogContentText>This can&apos;t be undone.</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setConfirmIds(null);
            }}
            disabled={loading}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            color="error"
            loading={loading}
            onClick={() => {
              void handleConfirmDelete();
            }}
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
