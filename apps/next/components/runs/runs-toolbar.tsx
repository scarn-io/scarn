"use client";

/**
 * Above the Runs list: the status tabs with their counts, the search box,
 * and removable chips for filters a deep link narrowed the list with.
 */

import { Box, ButtonBase, IconButton, InputBase, Stack } from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import CloseIcon from "@mui/icons-material/Close";
import SearchIcon from "@mui/icons-material/Search";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  projectRunStatusTabValues,
  type ProjectRunStatusTab,
} from "@scarn/core/pipeline-executions/project-runs/contracts/project-runs-contracts";
import { RUN_STATUS_LABEL, runStatusColor } from "./run-status";
import type { RunsCounts } from "./runs-api";
import { RUNS_SEARCH_DEBOUNCE_MS, type RunsNav } from "./runs-params";
import { narrowedRunsStatus, runsTabOf } from "./runs-scope";

const TAB_LABEL: Record<ProjectRunStatusTab, string> = {
  "needs-you": "Needs you",
  open: "In progress",
  finished: "Finished",
  all: "All",
};

type NavPatch = Partial<Record<keyof RunsNav, string | undefined>>;

export type RunsToolbarProps = {
  nav: RunsNav;
  counts: RunsCounts | null;
  /** The work item key for the `item` chip, when the rows name it. */
  itemKey: string | null;
  /** The list URL with `patch` applied. */
  hrefFor: (patch: NavPatch) => string;
  /** Writes `q`; called once typing settles. */
  onSearch: (q: string | undefined) => void;
  /** Controls shown beside the search box, e.g. batch selection. */
  actions?: ReactNode;
};

export function RunsToolbar({
  nav,
  counts,
  itemKey,
  hrefFor,
  onSearch,
  actions,
}: RunsToolbarProps) {
  const theme = useTheme();
  const tab = runsTabOf(nav.status);
  const narrowed = narrowedRunsStatus(nav.status);
  const chips: {
    key: string;
    color?: string;
    clear: string;
    label: ReactNode;
  }[] = [];
  if (narrowed) {
    chips.push({
      key: "status",
      color: runStatusColor(theme, narrowed),
      clear: hrefFor({ status: tab }),
      label: `${RUN_STATUS_LABEL[narrowed]} only`,
    });
  }
  if (nav.at !== undefined) {
    chips.push({
      key: "at",
      clear: hrefFor({ at: undefined }),
      label: (
        <>
          At node <code>{nav.at}</code> now
        </>
      ),
    });
  }
  if (nav.item !== undefined) {
    chips.push({
      key: "item",
      clear: hrefFor({ item: undefined }),
      label: `On ${itemKey ?? "this work item"} or its children`,
    });
  }

  return (
    <>
      <Box
        sx={{
          display: "flex",
          alignItems: "flex-end",
          flexWrap: "wrap",
          gap: 2,
          mb: 2,
          borderBottom: 1,
          borderColor: "divider",
        }}
      >
        <Stack
          direction="row"
          spacing={0.5}
          flexWrap="wrap"
          useFlexGap
          role="tablist"
          aria-label="Run status"
          sx={{ flex: 1, minWidth: 0 }}
        >
          {projectRunStatusTabValues.map((key) => (
            <StatusTab
              key={key}
              label={TAB_LABEL[key]}
              count={counts?.tabs[key]}
              color={
                key === "needs-you"
                  ? runStatusColor(theme, "needs-you")
                  : undefined
              }
              active={key === tab}
              href={hrefFor({ status: key })}
            />
          ))}
        </Stack>
        <Stack
          direction="row"
          alignItems="center"
          spacing={1}
          sx={{ pb: 0.75 }}
        >
          {actions}
          <SearchBox value={nav.q ?? ""} onSearch={onSearch} />
        </Stack>
      </Box>
      {chips.length > 0 ? (
        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1, mb: 1.5 }}>
          {chips.map((chip) => (
            <FilterChip
              key={chip.key}
              color={chip.color}
              clearHref={chip.clear}
            >
              {chip.label}
            </FilterChip>
          ))}
        </Box>
      ) : null}
    </>
  );
}

function StatusTab({
  label,
  count,
  color,
  active,
  href,
}: {
  label: string;
  count: number | undefined;
  color: string | undefined;
  active: boolean;
  href: string;
}) {
  return (
    <ButtonBase
      LinkComponent={Link}
      href={href}
      role="tab"
      aria-selected={active}
      sx={{
        px: 1.25,
        py: 0.75,
        gap: 0.75,
        fontSize: 13.5,
        fontWeight: active ? 600 : 400,
        color: active ? "text.primary" : "text.secondary",
        borderBottom: 2,
        mb: "-1px",
        borderColor: active ? "primary.main" : "transparent",
      }}
    >
      {color ? (
        <Box
          sx={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            backgroundColor: color,
          }}
        />
      ) : null}
      {label}
      <Box
        component="span"
        data-testid="runs-tab-count"
        sx={{
          px: 0.75,
          minWidth: 18,
          borderRadius: 99,
          fontSize: 11.5,
          color: "text.secondary",
          backgroundColor: (theme) => alpha(theme.palette.text.primary, 0.08),
        }}
      >
        {count ?? "–"}
      </Box>
    </ButtonBase>
  );
}

/**
 * Holds what is typed and writes it to the URL once typing settles. A `q`
 * that changes from outside (Back, a cleared chip) replaces the text.
 */
function SearchBox({
  value,
  onSearch,
}: {
  value: string;
  onSearch: (q: string | undefined) => void;
}) {
  const [text, setText] = useState(value);
  const [seen, setSeen] = useState(value);
  const onSearchRef = useRef(onSearch);
  onSearchRef.current = onSearch;

  if (value !== seen) {
    setSeen(value);
    setText(value);
  }

  useEffect(() => {
    if (text.trim() === value) return;
    const timer = setTimeout(() => {
      onSearchRef.current(text.trim() || undefined);
    }, RUNS_SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [text, value]);

  return (
    <Stack
      direction="row"
      alignItems="center"
      spacing={0.75}
      sx={{
        px: 1.25,
        height: 32,
        width: 240,
        borderRadius: 1.5,
        border: 1,
        borderColor: "divider",
        color: "text.secondary",
        "&:focus-within": { borderColor: "primary.main" },
      }}
    >
      <SearchIcon sx={{ fontSize: 16 }} />
      <InputBase
        fullWidth
        value={text}
        placeholder="Search runs…"
        inputProps={{ "aria-label": "Search runs" }}
        onChange={(event) => {
          setText(event.target.value);
        }}
        sx={{ fontSize: 13 }}
      />
    </Stack>
  );
}

function FilterChip({
  children,
  color,
  clearHref,
}: {
  children: ReactNode;
  color?: string | undefined;
  clearHref: string;
}) {
  return (
    <Box
      data-testid="runs-filter-chip"
      sx={{
        display: "inline-flex",
        alignItems: "center",
        gap: 0.5,
        pl: 1.25,
        pr: 0.25,
        py: 0.25,
        borderRadius: 99,
        fontSize: 12.5,
        border: 1,
        borderColor: color ?? "divider",
        color: color ?? "text.primary",
      }}
    >
      {children}
      <IconButton
        size="small"
        aria-label="Clear filter"
        LinkComponent={Link}
        href={clearHref}
      >
        <CloseIcon sx={{ fontSize: 14 }} />
      </IconButton>
    </Box>
  );
}
