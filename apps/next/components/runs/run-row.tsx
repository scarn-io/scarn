"use client";

/**
 * One row of the Runs list, and the column header above wide lists.
 *
 * At `lg` and up a row is: status mark · title over a one-line status ·
 * What ran · Work item · Started by · Updated. Below `lg` the middle columns
 * fold into a meta line under the title. `lg` is wide enough beside the
 * 240px sidebar: at 1200px the list gets ~910px, the fixed columns and gaps
 * take ~480px, which leaves the title ~400px (about 50 characters).
 *
 * The whole row is one link (the title's `::after` stretches over it), so
 * middle-click opens the run in a new tab while the work item keys stay
 * their own links on top.
 */

import { Box, Typography } from "@mui/material";
import { alpha } from "@mui/material/styles";
import Link from "next/link";
import type { ReactNode } from "react";
import { useProjectPath } from "@/components/project-route-context";
import { OutcomeChip, StatusLine, StatusMark } from "./run-status";
import {
  ItemKey,
  KindIcon,
  Mono,
  StartedBy,
  Updated,
  runStatusText,
  startedByText,
} from "./run-row-parts";
import type { ProjectRun } from "./runs-api";

/** How a list lays its rows out; shared by {@link RunRow} and {@link ColumnHeader}. */
export type RunColumns = {
  /** Show the What ran column; off when the list is scoped to one pipeline or step. */
  whatRan: boolean;
  /** Reserve a leading column, e.g. for a selection checkbox. */
  leading?: boolean;
};

const STACKED = "20px minmax(0, 1fr) 48px";

const columnsTemplate = ({ whatRan }: RunColumns) =>
  `20px minmax(0, 1fr) ${whatRan ? "140px " : ""}104px 104px 48px`;

const withLeading = (columns: RunColumns, template: string) =>
  columns.leading ? `auto ${template}` : template;

const onlyWide = { display: { xs: "none", lg: "block" } } as const;
const onlyStacked = { display: { xs: "block", lg: "none" } } as const;

const cellSx = {
  ...onlyWide,
  pt: 0.25,
  fontSize: 13,
  lineHeight: 1.6,
  color: "text.secondary",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 0,
} as const;

function Cell({
  column,
  title,
  children,
}: {
  column: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <Box data-column={column} title={title} sx={cellSx}>
      {children}
    </Box>
  );
}

/** Column labels over a wide list; hidden when rows fold back to stacked. */
export function ColumnHeader({
  columns,
  leading,
}: {
  columns: RunColumns;
  /** Rendered in the leading column when `columns.leading` is set. */
  leading?: ReactNode;
}) {
  const label = { fontSize: 11.5, fontWeight: 600, color: "text.disabled" };
  return (
    <Box
      data-testid="runs-column-header"
      sx={{
        display: { xs: "none", lg: "grid" },
        gridTemplateColumns: withLeading(columns, columnsTemplate(columns)),
        columnGap: 1.5,
        px: 2,
        py: 0.75,
        borderBottom: 1,
        borderColor: "divider",
        backgroundColor: (theme) => alpha(theme.palette.text.primary, 0.02),
      }}
    >
      {columns.leading ? <Box>{leading}</Box> : null}
      <span />
      <Box sx={label}>Run</Box>
      {columns.whatRan ? <Box sx={label}>What ran</Box> : null}
      <Box sx={label}>Work item</Box>
      <Box sx={label}>Started by</Box>
      <Box sx={{ ...label, textAlign: "right" }}>Updated</Box>
    </Box>
  );
}

export type RunRowProps = {
  run: ProjectRun;
  /** Lay the row out in columns at `lg`; see {@link ColumnHeader}. */
  columns: RunColumns;
  /** Whose runs read as "you"; `null` for a guest. */
  viewerUserId: string | null;
  divider?: boolean;
  /** Rendered in the leading column when `columns.leading` is set. */
  leading?: ReactNode;
};

export function RunRow({
  run,
  columns,
  viewerUserId,
  divider = false,
  leading,
}: RunRowProps) {
  const buildPath = useProjectPath();
  const { workItem } = run;
  const parent = workItem?.parent ?? null;
  const itemHref = (id: string) => buildPath("work-items", id);
  const started = startedByText(run.startedBy, viewerUserId);

  return (
    <Box
      data-testid="run-row"
      data-run-id={run.id}
      sx={{
        position: "relative",
        display: "grid",
        gridTemplateColumns: {
          xs: withLeading(columns, STACKED),
          lg: withLeading(columns, columnsTemplate(columns)),
        },
        alignItems: "start",
        columnGap: 1.5,
        px: 2,
        py: 1.5,
        borderTop: divider ? 1 : 0,
        borderColor: "divider",
        transition: "background-color 100ms",
        "&:hover": {
          backgroundColor: (theme) => alpha(theme.palette.text.primary, 0.04),
        },
        "&:has(a[data-run-link]:focus-visible)": {
          outline: "2px solid",
          outlineColor: "primary.main",
          outlineOffset: -2,
        },
      }}
    >
      {columns.leading ? (
        <Box sx={{ position: "relative", zIndex: 1 }}>{leading}</Box>
      ) : null}
      <StatusMark status={run.status} />
      <Box sx={{ minWidth: 0 }}>
        <Typography
          noWrap
          sx={{ fontSize: 15, fontWeight: 600, lineHeight: 1.35 }}
        >
          <Box
            component={Link}
            href={buildPath(...run.href.split("/"))}
            data-run-link
            sx={{
              color: "inherit",
              textDecoration: "none",
              outline: "none",
              "&::after": { content: '""', position: "absolute", inset: 0 },
            }}
          >
            {run.title}
          </Box>
          <OutcomeChip status={run.status} outcome={run.outcome} />
        </Typography>
        <Typography
          data-testid="run-row-meta"
          noWrap
          component="div"
          sx={{
            fontSize: 12,
            color: "text.disabled",
            mt: 0.25,
            ...onlyStacked,
          }}
        >
          <KindIcon kind={run.type} />
          {columns.whatRan ? `${run.whatRan.name} · ` : ""}
          {workItem ? (
            <>
              <ItemKey
                itemKey={workItem.platformKey}
                href={itemHref(workItem.id)}
              />
              {parent ? (
                <>
                  {" in "}
                  <ItemKey
                    itemKey={parent.platformKey}
                    href={itemHref(parent.id)}
                  />
                </>
              ) : null}
              {" · "}
            </>
          ) : null}
          {started}
        </Typography>
        <StatusLine status={run.status}>{runStatusText(run)}</StatusLine>
      </Box>
      {columns.whatRan ? (
        <Cell column="what-ran" title={run.whatRan.name}>
          <KindIcon kind={run.type} />
          {run.whatRan.name}
        </Cell>
      ) : null}
      <Cell
        column="work-item"
        title={
          workItem
            ? `${workItem.platformKey} ${workItem.title}${parent ? `, in ${parent.platformKey}` : ""}`
            : undefined
        }
      >
        {workItem ? (
          <>
            <Mono>
              <ItemKey
                itemKey={workItem.platformKey}
                href={itemHref(workItem.id)}
              />
            </Mono>
            {parent ? (
              <Box sx={{ fontSize: 11.5, color: "text.disabled" }}>
                {"in "}
                <ItemKey
                  itemKey={parent.platformKey}
                  href={itemHref(parent.id)}
                />
              </Box>
            ) : null}
          </>
        ) : (
          <Box component="span" sx={{ color: "text.disabled" }}>
            —
          </Box>
        )}
      </Cell>
      <Cell column="started-by" title={started}>
        <StartedBy startedBy={run.startedBy} viewerUserId={viewerUserId} />
      </Cell>
      <Updated value={run.updatedAt} />
    </Box>
  );
}
