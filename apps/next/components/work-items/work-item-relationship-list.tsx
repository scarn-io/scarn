"use client";

import { useEffect, useState } from "react";
import { Typography } from "@mui/material";
import type { WorkItemContract } from "@scarn/api/frontend-contracts";
import { fetchWorkItem } from "@/app/(protected)/projects/_lib/project-work-items";

/** Mono uppercase eyebrow label for a relationship subsection. */
export function RelationshipEyebrow({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Typography
      component="span"
      sx={{
        fontFamily: "var(--font-mono)",
        fontSize: "0.6875rem",
        fontWeight: 600,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "text.disabled",
      }}
    >
      {children}
    </Typography>
  );
}

/**
 * Batch-resolves work item ids to their `WorkItemContract` (title + platform),
 * for rows whose backing relationship record only carries an id — mirrors the
 * "already under" title lookup in `WorkItemRelationshipPickerDialog`. A failed
 * lookup for one id is left unresolved rather than retried on every render;
 * `ids` should be a referentially-stable array (e.g. derived with `useMemo`
 * keyed on the source list) so this doesn't refetch on unrelated re-renders.
 */
export function useResolvedWorkItems(
  ids: string[],
): Record<string, WorkItemContract> {
  const [itemsById, setItemsById] = useState<Record<string, WorkItemContract>>(
    {},
  );

  useEffect(() => {
    const missing = ids.filter((id) => !(id in itemsById));
    if (missing.length === 0) return;
    let cancelled = false;
    void Promise.all(
      missing.map((id) =>
        fetchWorkItem(id)
          .then((item) => [id, item] as const)
          .catch(() => [id, null] as const),
      ),
    ).then((entries) => {
      if (cancelled) return;
      setItemsById((prev) => {
        const next = { ...prev };
        for (const [id, item] of entries) {
          if (item) next[id] = item;
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [ids, itemsById]);

  return itemsById;
}
