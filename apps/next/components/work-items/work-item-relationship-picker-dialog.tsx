"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { parseWorkItemId } from "@scarn/api/frontend-contracts";
import type { WorkItemContract } from "@scarn/api/frontend-contracts";
import type { WorkItemListItem } from "@/app/(protected)/projects/_lib/project-work-items";
import {
  fetchProjectWorkItems,
  fetchWorkItem,
} from "@/app/(protected)/projects/_lib/project-work-items";
import type { WorkItemBlockContract } from "@scarn/core/work-items/work-item-block/contracts/work-item-block-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { parseApiError } from "@/app/_lib/api-error";
import { PlatformIcon } from "./work-item-platform";

const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_PAGE_SIZE = 10;

export type RelationshipPickerMode =
  | { kind: "parent" }
  | { kind: "child" }
  | { kind: "block"; initialDirection: "blockedBy" | "blocking" };

export type WorkItemRelationshipPickerDialogProps = {
  open: boolean;
  onClose: () => void;
  projectId: string;
  /** The item currently being viewed — never selectable as its own relation. */
  workItem: WorkItemContract;
  mode: RelationshipPickerMode;
  /** Decision 10: pre-computed 1-hop-invalid candidate ids, supplied by the caller. */
  excludeIds: Set<string>;
  onLinked: (updated: WorkItemContract | WorkItemBlockContract) => void;
};

const DIALOG_COPY: Record<
  RelationshipPickerMode["kind"],
  { title: string; confirmLabel: string; searchLabel: string }
> = {
  parent: {
    title: "Change parent work item",
    confirmLabel: "Set parent",
    searchLabel: "Search work items",
  },
  child: {
    title: "Add child work item",
    confirmLabel: "Add child",
    searchLabel: "Search work items",
  },
  block: {
    title: "Link work item",
    confirmLabel: "Link",
    searchLabel: "Search work items",
  },
};

/**
 * Reusable `Dialog` + MUI `Autocomplete` for linking the currently-viewed work
 * item to another one — as its parent, as a new child, or as a blocking
 * relationship in either direction. One component covers all three triggers
 * (Decision 4/13) so the search/candidate-filtering logic lives in one place.
 *
 * Mutations are pessimistic (Decision 6): the confirm button shows a spinner
 * while in flight and the dialog only closes on success, matching
 * `RespondDialog`/`WorkItemCommentItem`.
 */
export function WorkItemRelationshipPickerDialog({
  open,
  onClose,
  projectId,
  workItem,
  mode,
  excludeIds,
  onLinked,
}: WorkItemRelationshipPickerDialogProps) {
  const initialDirection = mode.kind === "block" ? mode.initialDirection : null;

  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<WorkItemListItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<WorkItemListItem | null>(null);
  const [direction, setDirection] = useState<"blockedBy" | "blocking">(
    initialDirection ?? "blockedBy",
  );
  const [parentTitles, setParentTitles] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(null);
    setError(null);
    setDirection(initialDirection ?? "blockedBy");
  }, [open, initialDirection]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSearching(true);
    const handle = setTimeout(() => {
      void fetchProjectWorkItems(projectId, {
        q: query,
        page: 1,
        pageSize: SEARCH_PAGE_SIZE,
      })
        .then((result) => {
          if (cancelled) return;
          setOptions(
            result.items.filter(
              (item) => item.id !== workItem.id && !excludeIds.has(item.id),
            ),
          );
        })
        .catch(() => {
          if (cancelled) return;
          setOptions([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [open, projectId, query, excludeIds, workItem.id]);

  // Decision 14: batch-resolve titles for candidates whose `parentWorkItemId`
  // would otherwise render as a bare id in the "already under" caption.
  const missingParentIds = useMemo(() => {
    if (mode.kind !== "child") return [];
    const currentId: string = workItem.id;
    const ids = new Set<string>();
    for (const option of options) {
      const parentId = option.parentWorkItemId;
      if (parentId && parentId !== currentId && !(parentId in parentTitles)) {
        ids.add(parentId);
      }
    }
    return Array.from(ids);
  }, [mode.kind, options, parentTitles, workItem.id]);

  useEffect(() => {
    if (missingParentIds.length === 0) return;
    let cancelled = false;
    void Promise.all(
      missingParentIds.map((id) =>
        fetchWorkItem(id)
          .then((item) => [id, item.title] as const)
          .catch(() => [id, null] as const),
      ),
    ).then((entries) => {
      if (cancelled) return;
      setParentTitles((prev) => {
        const next = { ...prev };
        for (const [id, title] of entries) {
          if (title !== null) next[id] = title;
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [missingParentIds]);

  const copy = DIALOG_COPY[mode.kind];

  const handleClose = () => {
    if (isPending) return;
    onClose();
  };

  const handleSubmit = () => {
    if (!selected) return;
    setError(null);
    startTransition(async () => {
      const client = getBrowserScarnApiClient();

      if (mode.kind === "parent") {
        const { data, error: err } = await client.api["work-items"]({
          workItemId: parseWorkItemId(workItem.id),
        }).parent.patch({ parentWorkItemId: parseWorkItemId(selected.id) });
        if (err) {
          setError(parseApiError(err, "Could not set parent. Try again."));
          return;
        }
        onLinked(data);
        onClose();
        return;
      }

      if (mode.kind === "child") {
        const { data, error: err } = await client.api["work-items"]({
          workItemId: parseWorkItemId(selected.id),
        }).parent.patch({ parentWorkItemId: parseWorkItemId(workItem.id) });
        if (err) {
          setError(
            parseApiError(err, "Could not add child work item. Try again."),
          );
          return;
        }
        onLinked(data);
        onClose();
        return;
      }

      const body =
        direction === "blockedBy"
          ? {
              blockedWorkItemId: parseWorkItemId(workItem.id),
              blockingWorkItemId: parseWorkItemId(selected.id),
            }
          : {
              blockedWorkItemId: parseWorkItemId(selected.id),
              blockingWorkItemId: parseWorkItemId(workItem.id),
            };
      const { data, error: err } =
        await client.api["work-item-blocks"].post(body);
      if (err) {
        setError(parseApiError(err, "Could not link work item. Try again."));
        return;
      }
      onLinked(data);
      onClose();
    });
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>{copy.title}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          {error ? <Alert severity="error">{error}</Alert> : null}

          {mode.kind === "block" ? (
            <ToggleButtonGroup
              size="small"
              exclusive
              value={direction}
              onChange={(_event, next: "blockedBy" | "blocking" | null) => {
                if (next) setDirection(next);
              }}
              disabled={isPending}
            >
              <ToggleButton value="blockedBy">Blocked by</ToggleButton>
              <ToggleButton value="blocking">Blocking</ToggleButton>
            </ToggleButtonGroup>
          ) : null}

          <Autocomplete
            options={options}
            loading={searching}
            value={selected}
            onChange={(_event, next) => {
              setSelected(next);
            }}
            onInputChange={(_event, next) => {
              setQuery(next);
            }}
            getOptionLabel={(option) => option.title}
            isOptionEqualToValue={(option, value) => option.id === value.id}
            disabled={isPending}
            renderInput={(params) => (
              <TextField {...params} label={copy.searchLabel} autoFocus />
            )}
            renderOption={(props, option) => {
              const parentTitle =
                mode.kind === "child" && option.parentWorkItemId
                  ? parentTitles[option.parentWorkItemId]
                  : undefined;
              return (
                <Box component="li" {...props} key={option.id}>
                  <Stack spacing={0.25} sx={{ width: "100%" }}>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Box
                        sx={{
                          display: "inline-flex",
                          color: "text.secondary",
                          "& svg": { fontSize: 16 },
                        }}
                      >
                        <PlatformIcon
                          platform={option.platform}
                          fontSize="inherit"
                        />
                      </Box>
                      <Typography variant="body2">{option.title}</Typography>
                    </Stack>
                    {parentTitle ? (
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ pl: 3 }}
                      >
                        already under: {parentTitle}
                      </Typography>
                    ) : null}
                  </Stack>
                </Box>
              );
            }}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={isPending}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handleSubmit}
          loading={isPending}
          disabled={isPending || !selected}
        >
          {copy.confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
