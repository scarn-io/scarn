"use client";

/**
 * Building blocks of the step thread: the collapsible section header, the
 * folded activity row, quiet system lines, and the run's start line.
 */

import { Box, Collapse, Stack, Typography, type Theme } from "@mui/material";
import { alpha } from "@mui/material/styles";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import { useRef, useState, type ReactNode } from "react";
import { shimmerTextSx, usePrefersReducedMotion } from "./activity-shimmer";
import { ReasoningBlock, ToolCard } from "./conversation-parts";
import { formatElapsedMs } from "./elapsed";
import { activitySummary, type ActivityItem } from "./thread-items";

/** Text under a section header lines up with the header text (past the chevron). */
export const SECTION_INDENT = 3;

const linkSx = {
  all: "unset",
  cursor: "pointer",
  color: "text.secondary",
  textDecoration: "underline",
  textUnderlineOffset: 3,
  textDecorationColor: (theme: Theme) => alpha(theme.palette.text.primary, 0.2),
  "&:hover": { color: "text.primary", textDecorationColor: "currentColor" },
  "&:focus-visible": { outline: 2, outlineColor: "divider" },
} as const;

/** An inline, underlined text button for links inside thread copy. */
export function TextLink({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Box component="button" type="button" onClick={onClick} sx={linkSx}>
      {children}
    </Box>
  );
}

/**
 * The one collapse affordance: a full-width row whose whole surface toggles,
 * with a chevron that rotates. `sticky` pins it to the top of the scroll
 * container while its section scrolls past; collapsing from there scrolls the
 * section back into view. `prominent` is the bordered bar used for runs.
 */
export function SectionHeader({
  open,
  onToggle,
  children,
  meta,
  leading,
  sticky = false,
  prominent = false,
}: {
  open: boolean;
  onToggle: (open: boolean) => void;
  children: ReactNode;
  /** Right-aligned, e.g. the time. */
  meta?: ReactNode;
  /** Between the chevron and the label, e.g. a status icon. */
  leading?: ReactNode;
  sticky?: boolean;
  prominent?: boolean;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const toggle = () => {
    const button = ref.current;
    const section = button?.parentElement ?? null;
    const stuck =
      sticky &&
      open &&
      button !== null &&
      section !== null &&
      button.getBoundingClientRect().top - section.getBoundingClientRect().top >
        2;
    onToggle(!open);
    if (stuck && typeof section.scrollIntoView === "function") {
      requestAnimationFrame(() => {
        section.scrollIntoView({ block: "start" });
      });
    }
  };
  return (
    <Box
      ref={ref}
      component="button"
      type="button"
      aria-expanded={open}
      onClick={toggle}
      sx={[
        {
          all: "unset",
          boxSizing: "border-box",
          display: "flex",
          alignItems: "center",
          gap: 0.75,
          width: "calc(100% + 16px)",
          minHeight: 36,
          px: 1,
          transform: "translateX(-8px)",
          borderRadius: 1.5,
          cursor: "pointer",
          userSelect: "none",
          color: "text.secondary",
          backgroundColor: "background.default",
          "&:hover": { color: "text.primary" },
          "&:hover .section-chevron": { color: "text.primary" },
          "&:focus-visible": {
            outline: 2,
            outlineColor: "divider",
            outlineOffset: -2,
          },
        },
        sticky
          ? {
              position: "sticky",
              top: 0,
              zIndex: 2,
              "&::after": {
                content: '""',
                position: "absolute",
                left: 0,
                right: 0,
                top: "100%",
                height: 10,
                pointerEvents: "none",
                background: (theme) =>
                  `linear-gradient(${theme.palette.background.default}, transparent)`,
              },
            }
          : {},
        prominent
          ? {
              minHeight: 44,
              px: 1.5,
              width: "100%",
              transform: "none",
              gap: 1,
              border: 1,
              borderColor: "divider",
              color: "text.primary",
              backgroundImage: (theme) =>
                `linear-gradient(${theme.palette.action.hover}, ${theme.palette.action.hover})`,
              "&:hover": {
                color: "text.primary",
                borderColor: "text.disabled",
              },
            }
          : {},
      ]}
    >
      <ChevronRightIcon
        className="section-chevron"
        sx={{
          fontSize: prominent ? 22 : 18,
          flexShrink: 0,
          color: prominent ? "text.secondary" : "text.disabled",
          transition: "transform 120ms",
          transform: open ? "rotate(90deg)" : "none",
        }}
      />
      {leading}
      <Typography
        component="span"
        variant="body2"
        sx={{
          flex: 1,
          minWidth: 0,
          color: "inherit",
          fontSize: prominent ? 14.5 : 13.5,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {children}
      </Typography>
      {meta ? (
        <Typography
          component="span"
          variant="caption"
          sx={{
            flexShrink: 0,
            color: prominent ? "text.secondary" : "text.disabled",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {meta}
        </Typography>
      ) : null}
    </Box>
  );
}

/**
 * The tool calls and reasoning between two pieces of narration as one muted
 * row ("Read 4 files, ran 2 commands · 38s"). Expands to the individual
 * `ToolCard`s and `ReasoningBlock`s.
 */
export function ActivityRow({
  item,
  endMs,
}: {
  item: ActivityItem;
  /** Where the row's duration ends; the item's own `endMs` when it has one. */
  endMs: number | null;
}) {
  const [open, setOpen] = useState(false);
  const reducedMotion = usePrefersReducedMotion();
  const { label, headline } = activitySummary(item.events);
  const end = item.endMs ?? endMs;
  const duration =
    item.startMs !== null && end !== null ? end - item.startMs : 0;
  const meta = [label, duration >= 1000 ? formatElapsedMs(duration) : ""]
    .filter(Boolean)
    .join(" · ");
  return (
    <Box>
      <Stack
        component="button"
        type="button"
        aria-expanded={open}
        direction="row"
        alignItems="center"
        spacing={0.75}
        onClick={() => {
          setOpen((value) => !value);
        }}
        sx={{
          all: "unset",
          display: "flex",
          cursor: "pointer",
          userSelect: "none",
          color: "text.secondary",
          width: "fit-content",
          maxWidth: "100%",
          "&:hover": { color: "text.primary" },
        }}
      >
        <ChevronRightIcon
          sx={{
            fontSize: 18,
            ml: -0.25,
            transition: "transform 120ms",
            transform: open ? "rotate(90deg)" : "none",
          }}
        />
        <Typography
          variant="body2"
          sx={[
            { whiteSpace: "nowrap" },
            item.active && !reducedMotion
              ? shimmerTextSx((palette) => palette.text.secondary)
              : { color: "inherit" },
          ]}
        >
          {meta}
        </Typography>
        {headline ? (
          <Typography
            variant="body2"
            sx={{
              color: "text.disabled",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            · {headline}
          </Typography>
        ) : null}
      </Stack>
      <Collapse in={open} unmountOnExit>
        <Stack
          spacing={0.75}
          sx={{
            mt: 1.5,
            ml: 0.75,
            pl: 2,
            borderLeft: 1,
            borderColor: "divider",
          }}
        >
          {item.events.map((event) =>
            event.kind === "tool" ? (
              <ToolCard key={event.partId} tool={event} active={item.active} />
            ) : (
              <ReasoningBlock
                key={event.partId}
                text={event.text.replace(/\*\*/g, "")}
              />
            ),
          )}
        </Stack>
      </Collapse>
    </Box>
  );
}

/** A quiet one-line row for what the system did (not the agent or you). */
export function SystemLine({
  icon,
  shimmer = false,
  children,
}: {
  icon: string;
  shimmer?: boolean;
  children: ReactNode;
}) {
  const reducedMotion = usePrefersReducedMotion();
  return (
    <Typography
      variant="caption"
      component="div"
      sx={[
        {
          display: "flex",
          alignItems: "baseline",
          gap: 0.75,
          color: "text.disabled",
          letterSpacing: 0.1,
        },
        shimmer && !reducedMotion
          ? shimmerTextSx((palette) => palette.text.secondary)
          : {},
      ]}
    >
      <Box component="span" aria-hidden sx={{ fontSize: 13, lineHeight: 1 }}>
        {icon}
      </Box>
      <span>{children}</span>
    </Typography>
  );
}

/** "Started by … · show prompt", with the run's opening prompt revealed inline. */
export function StartLine({
  prompt,
  children,
}: {
  prompt: string | null;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Box>
      <Typography variant="body2" color="text.secondary">
        {children}
        {prompt ? (
          <>
            {" · "}
            <TextLink
              onClick={() => {
                setOpen((value) => !value);
              }}
            >
              {open ? "hide prompt" : "show prompt"}
            </TextLink>
          </>
        ) : null}
      </Typography>
      {prompt ? (
        <Collapse in={open} unmountOnExit>
          <Box
            component="pre"
            sx={{
              m: 0,
              mt: 1.5,
              p: 2,
              borderRadius: 2,
              backgroundColor: "action.hover",
              color: "text.secondary",
              fontFamily: "var(--font-mono)",
              fontSize: 12.5,
              lineHeight: 1.6,
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              maxHeight: 360,
              overflow: "auto",
            }}
          >
            {prompt}
          </Box>
        </Collapse>
      ) : null}
    </Box>
  );
}
