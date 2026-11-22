"use client";

import { useCallback } from "react";
import Link from "next/link";
import { Box } from "@mui/material";
import type { WorkItemStatusSummaryContract } from "@scarn/api/frontend-contracts";
import {
  ExternalProseLink,
  Prose,
  type ProseLink,
} from "@/components/executions/prose";
import { useProjectPath } from "@/components/project-route-context";
import { ChildWorkItemStatusIcon } from "./child-work-item-status-icon";
import { useWorkItemLinkStatuses } from "./use-work-item-link-statuses";
import { workItemIdFromHref } from "./work-item-links";

/**
 * A work item's description as Markdown. A link to a work item in this
 * project shows its status icon and live title and opens in the same tab.
 * Any other link, including one to an item this project doesn't have, opens
 * in a new tab as written. `knownWorkItems` (such as the loaded children)
 * are used as they are; only the other linked items are looked up, in one
 * request.
 */
export function WorkItemDescription({
  projectId,
  description,
  knownWorkItems,
}: {
  projectId: string;
  description: string;
  knownWorkItems: readonly WorkItemStatusSummaryContract[];
}) {
  const projectPath = useProjectPath();
  const statuses = useWorkItemLinkStatuses(
    projectId,
    description,
    knownWorkItems,
  );

  const renderLink = useCallback(
    ({ href, children }: ProseLink) => {
      const id = workItemIdFromHref(href);
      const item = id ? statuses.get(id) : undefined;
      if (!item) {
        return <ExternalProseLink href={href}>{children}</ExternalProseLink>;
      }
      return (
        <Box
          component="span"
          sx={{
            display: "inline-flex",
            alignItems: "baseline",
            gap: 0.5,
            "& [role=img]": { alignSelf: "center" },
          }}
        >
          <ChildWorkItemStatusIcon status={item.status} size={14} />
          <Link href={projectPath("work-items", item.id)}>{item.title}</Link>
        </Box>
      );
    },
    [statuses, projectPath],
  );

  return <Prose text={description} renderLink={renderLink} />;
}
