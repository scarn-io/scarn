"use client";

import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import type { PipelineDefinitionContract } from "@scarn/api/frontend-contracts";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  Menu,
  MenuItem,
} from "@mui/material";
import { useState } from "react";
import { parseApiError } from "@/app/_lib/api-error";
import type { PipelineExecutionTableApiClient } from "./pipeline-execution-table/types";

type Action = "archive" | "unarchive";

export function PipelineDefinitionArchiveMenu({
  definition,
  apiClient,
  onArchived,
  onUnarchived,
}: {
  definition: PipelineDefinitionContract;
  apiClient: PipelineExecutionTableApiClient;
  onArchived: (definition: PipelineDefinitionContract) => void;
  onUnarchived: (definition: PipelineDefinitionContract) => void;
}) {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [pendingAction, setPendingAction] = useState<Action | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const isArchived = definition.archivedAt !== null;

  const handleConfirm = async () => {
    if (!pendingAction) return;
    setSubmitting(true);
    setError("");
    try {
      const endpoint = apiClient.api["pipeline-definitions"]({
        pipelineDefinitionId: parseUuidV7(definition.id),
      });
      const response =
        pendingAction === "archive"
          ? await endpoint.archive.put()
          : await endpoint.unarchive.put();
      if (response.error) {
        setError(parseApiError(response.error, "Request failed"));
        return;
      }
      const updated = response.data;
      if (pendingAction === "archive") {
        onArchived(updated);
      } else {
        onUnarchived(updated);
      }
      setPendingAction(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <IconButton
        aria-label="Pipeline actions"
        size="small"
        onClick={(event) => {
          setAnchorEl(event.currentTarget);
        }}
      >
        <MoreVertIcon />
      </IconButton>
      <Menu
        anchorEl={anchorEl}
        open={Boolean(anchorEl)}
        onClose={() => {
          setAnchorEl(null);
        }}
      >
        {isArchived ? (
          <MenuItem
            onClick={() => {
              setAnchorEl(null);
              setPendingAction("unarchive");
            }}
          >
            Unarchive
          </MenuItem>
        ) : (
          <MenuItem
            onClick={() => {
              setAnchorEl(null);
              setPendingAction("archive");
            }}
          >
            Archive
          </MenuItem>
        )}
      </Menu>
      <Dialog
        open={pendingAction !== null}
        onClose={() => {
          if (!submitting) setPendingAction(null);
        }}
      >
        <DialogTitle>
          {pendingAction === "archive"
            ? "Archive pipeline?"
            : "Unarchive pipeline?"}
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            {pendingAction === "archive"
              ? `Archive "${definition.name}"? It will be hidden from the pipelines list but can be restored later.`
              : `Restore "${definition.name}" to the active pipelines list?`}
          </DialogContentText>
          {error ? (
            <DialogContentText sx={{ color: "error.main", mt: 2 }}>
              {error}
            </DialogContentText>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setPendingAction(null);
            }}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            onClick={() => {
              void handleConfirm();
            }}
            variant="contained"
            disabled={submitting}
          >
            {pendingAction === "archive" ? "Archive" : "Unarchive"}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
