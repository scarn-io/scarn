"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import {
  applyFilters,
  type WorkItemFilter,
} from "@/components/work-items/filters/work-item-filter-model";

/**
 * Write a complete filter set to the URL.
 *
 * Whole-set rather than per-clause: `applyFilters` owns every param the model
 * knows about, so the caller hands over the query it wants and never has to
 * remember which params a removed clause left behind. Shared by the filter bar
 * and by the table's empty state, which both remove clauses.
 */
export function useCommitFilters(): (filters: WorkItemFilter[]) => void {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  return useCallback(
    (filters: WorkItemFilter[]) => {
      const query = applyFilters(
        new URLSearchParams(searchParams.toString()),
        filters,
      ).toString();
      router.push(query.length > 0 ? `${pathname}?${query}` : pathname);
    },
    [pathname, router, searchParams],
  );
}
