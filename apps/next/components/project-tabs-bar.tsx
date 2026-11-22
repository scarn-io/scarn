"use client";

import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import DashboardOutlinedIcon from "@mui/icons-material/DashboardOutlined";
import InboxOutlinedIcon from "@mui/icons-material/InboxOutlined";
import AccountTreeOutlinedIcon from "@mui/icons-material/AccountTreeOutlined";
import PlayCircleOutlineIcon from "@mui/icons-material/PlayCircleOutline";
import MoveToInboxOutlinedIcon from "@mui/icons-material/MoveToInboxOutlined";
import SettingsOutlinedIcon from "@mui/icons-material/SettingsOutlined";
import { Box, Menu, MenuItem, Tab, Tabs } from "@mui/material";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  useSetAppShellOrgId,
  useSetAppShellOwnerUsername,
  useSetAppShellTitle,
} from "./app-shell-context";
import { projectSubPath } from "@/app/(protected)/projects/_lib/project-routing";
import { InboxTabLabel } from "./inbox/inbox-tab-label";
import { useInboxBadgeCount } from "./inbox/use-project-inbox";

const TAB_ROUTES = [
  "tour",
  "work-items",
  "runs",
  "pipelines",
  "inbox",
  "settings",
] as const;
type TabRoute = (typeof TAB_ROUTES)[number];
/**
 * The only tabs a non-member viewer of a public project sees (issue #150).
 * Pipelines, Inbox, and Settings are all member-only areas — either
 * purely write affordances (Settings) or personal/config data never asked for
 * in the read-only spec (Pipelines, Inbox) — and
 * their pages independently 404 a non-member who navigates to them directly.
 * Tour is in both sets: it is the project's guest-facing landing page (the
 * landing site's CTA points straight at it), and it renders a member summary
 * for members — see {@link ProjectTabsBar}'s `isDemoProject` prop for why it
 * only ever actually appears on the demo project.
 */
const NON_MEMBER_TAB_ROUTES = [
  "tour",
  "work-items",
  "runs",
] as const satisfies readonly TabRoute[];
const TAB_LABELS: Record<TabRoute, string> = {
  tour: "Overview",
  "work-items": "Work Items",
  runs: "Runs",
  pipelines: "Pipelines & Automations",
  inbox: "Inbox",
  settings: "Settings",
};
const TAB_ICONS: Record<TabRoute, React.ReactElement> = {
  tour: <DashboardOutlinedIcon />,
  "work-items": <InboxOutlinedIcon />,
  runs: <PlayCircleOutlineIcon />,
  pipelines: <AccountTreeOutlinedIcon />,
  inbox: <MoveToInboxOutlinedIcon />,
  settings: <SettingsOutlinedIcon />,
};
const TAB_GAP_PX = 4;
const OFFSCREEN_MEASUREMENT_POSITION_PX = -9999;
const MORE_TAB_VALUE = "__more";
const createRouteRecord = <T,>(value: T): Record<TabRoute, T> =>
  Object.fromEntries(TAB_ROUTES.map((route) => [route, value])) as Record<
    TabRoute,
    T
  >;

const tabHref = (projectBasePath: string, route: TabRoute): string =>
  `${projectBasePath}/${route}`;

const isRouteActive = (
  pathname: string,
  projectBasePath: string,
  route: TabRoute,
): boolean => pathname.startsWith(`${projectBasePath}/${route}`);

function getActiveTab(
  pathname: string,
  projectBasePath: string,
  tabRoutes: readonly TabRoute[],
): TabRoute | false {
  for (const route of tabRoutes) {
    if (isRouteActive(pathname, projectBasePath, route)) return route;
  }
  return false;
}

function getVisibleRoutes(
  availableWidth: number,
  routeWidths: Record<TabRoute, number>,
  moreWidth: number,
  tabRoutes: readonly TabRoute[],
) {
  const totalWidth = tabRoutes.reduce((sum, route, index) => {
    const gapWidth = index === 0 ? 0 : TAB_GAP_PX;
    return sum + gapWidth + routeWidths[route];
  }, 0);

  if (availableWidth <= 0 || totalWidth <= availableWidth) {
    return {
      visibleRoutes: tabRoutes,
      overflowRoutes: [] as TabRoute[],
    };
  }

  const maxVisibleWidth = Math.max(availableWidth - moreWidth - TAB_GAP_PX, 0);
  const visibleRoutes: TabRoute[] = [];
  let usedWidth = 0;

  for (const route of tabRoutes) {
    const gapWidth = visibleRoutes.length === 0 ? 0 : TAB_GAP_PX;
    const nextWidth = usedWidth + gapWidth + routeWidths[route];
    if (visibleRoutes.length > 0 && nextWidth > maxVisibleWidth) break;
    visibleRoutes.push(route);
    usedWidth = nextWidth;
  }

  return {
    visibleRoutes,
    overflowRoutes: tabRoutes.filter((route) => !visibleRoutes.includes(route)),
  };
}

export function ProjectTabsBar({
  username,
  projectSlug,
  projectName,
  orgId,
  projectId,
  isMember = true,
  isDemoProject = false,
}: {
  username: string;
  projectSlug: string;
  projectName: string;
  orgId: string;
  /** Reads the Inbox tab's badge count; members only. */
  projectId?: string;
  /** Non-member viewers (issue #150) only get the Work Items and Runs
   * tabs — everything else is either write-only (Settings) or a member-only
   * area the read-only spec never asked to expose. Defaults to `true` so
   * every existing call site keeps its full tab set. */
  isMember?: boolean;
  /**
   * Only the seeded demo project keeps an Overview tab: every other
   * project's root now redirects straight to Work Items
   * (`(content)/page.tsx`), so a tab that just bounced through it would be
   * dead weight. Defaults to `false` so every other project simply drops it.
   */
  isDemoProject?: boolean;
}) {
  const memberOrGuestRoutes = isMember ? TAB_ROUTES : NON_MEMBER_TAB_ROUTES;
  const tabRoutes = isDemoProject
    ? memberOrGuestRoutes
    : memberOrGuestRoutes.filter((route) => route !== "tour");
  const inboxCount = useInboxBadgeCount(
    isMember && projectId ? projectId : null,
  );
  const tabLabel = (route: TabRoute) =>
    route === "inbox" ? (
      <InboxTabLabel count={inboxCount} />
    ) : (
      TAB_LABELS[route]
    );
  const pathname = usePathname();
  const projectBasePath = projectSubPath(username, projectSlug);
  const activeTab = getActiveTab(pathname, projectBasePath, tabRoutes);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const moreMeasureRef = useRef<HTMLDivElement | null>(null);
  const [menuAnchorEl, setMenuAnchorEl] = useState<HTMLElement | null>(null);
  const [availableWidth, setAvailableWidth] = useState(0);
  const measureRefs = useRef<Record<TabRoute, HTMLElement | null>>(
    createRouteRecord<HTMLElement | null>(null),
  );
  useSetAppShellTitle(projectName);
  useSetAppShellOrgId(orgId);
  // The URL owner segment IS the project owner's username (pretty URLs resolve
  // `/{ownerUsername}/{slug}`), so the breadcrumb owner label is correct even
  // for a shared project owned by a different user than the viewer.
  useSetAppShellOwnerUsername(username);

  useEffect(() => {
    const updateWidth = () => {
      setAvailableWidth(containerRef.current?.clientWidth ?? 0);
    };

    updateWidth();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateWidth);
      return () => {
        window.removeEventListener("resize", updateWidth);
      };
    }

    const observer = new ResizeObserver(updateWidth);
    if (containerRef.current) observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
    };
  }, []);

  const routeWidths = useMemo(
    () =>
      tabRoutes.reduce<Record<TabRoute, number>>((acc, route) => {
        acc[route] = measureRefs.current[route]?.offsetWidth ?? 0;
        return acc;
      }, createRouteRecord(0)),
    [availableWidth, tabRoutes, inboxCount],
  );
  const moreWidth = moreMeasureRef.current?.offsetWidth ?? 0;
  const { visibleRoutes, overflowRoutes } = useMemo(
    () => getVisibleRoutes(availableWidth, routeWidths, moreWidth, tabRoutes),
    [availableWidth, routeWidths, moreWidth, tabRoutes],
  );
  const isMoreActive =
    activeTab !== false && overflowRoutes.includes(activeTab);
  const tabsValue =
    activeTab !== false && visibleRoutes.includes(activeTab)
      ? activeTab
      : isMoreActive
        ? MORE_TAB_VALUE
        : false;

  return (
    <Box
      sx={{
        bgcolor: "var(--color-bg-header)",
        borderBottom: 1,
        borderColor: "divider",
        px: { xs: 2, md: 4 },
      }}
    >
      <Box
        ref={containerRef}
        data-testid="project-tabs-bar"
        sx={{ minHeight: 44 }}
      >
        <Tabs
          value={tabsValue}
          sx={{ minHeight: 44, "& .MuiTab-root": { minHeight: 44 } }}
        >
          {visibleRoutes.map((route) => (
            <Tab
              key={route}
              label={tabLabel(route)}
              icon={TAB_ICONS[route]}
              iconPosition="start"
              value={route}
              component={Link}
              href={tabHref(projectBasePath, route)}
            />
          ))}
          {overflowRoutes.length > 0 ? (
            <Tab
              aria-label="More project tabs"
              aria-controls={
                menuAnchorEl ? "project-tabs-more-menu" : undefined
              }
              aria-expanded={menuAnchorEl ? "true" : undefined}
              aria-haspopup="menu"
              icon={<KeyboardArrowDownIcon />}
              iconPosition="end"
              label="More"
              onClick={(event) => {
                setMenuAnchorEl(event.currentTarget);
              }}
              value={MORE_TAB_VALUE}
            />
          ) : null}
        </Tabs>
        <Menu
          id="project-tabs-more-menu"
          anchorEl={menuAnchorEl}
          open={Boolean(menuAnchorEl)}
          onClose={() => {
            setMenuAnchorEl(null);
          }}
          anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
          transformOrigin={{ vertical: "top", horizontal: "right" }}
        >
          {overflowRoutes.map((route) => (
            <MenuItem
              key={route}
              component={Link}
              href={tabHref(projectBasePath, route)}
              selected={activeTab === route}
              onClick={() => {
                setMenuAnchorEl(null);
              }}
            >
              {tabLabel(route)}
            </MenuItem>
          ))}
        </Menu>
        <Tabs
          aria-hidden
          value={false}
          sx={{
            position: "fixed",
            top: OFFSCREEN_MEASUREMENT_POSITION_PX,
            left: OFFSCREEN_MEASUREMENT_POSITION_PX,
            visibility: "hidden",
            pointerEvents: "none",
            whiteSpace: "nowrap",
            height: 0,
            overflow: "hidden",
            minHeight: 44,
            "& .MuiTab-root": { minHeight: 44 },
          }}
        >
          {TAB_ROUTES.map((route) => (
            <Tab
              key={route}
              label={tabLabel(route)}
              icon={TAB_ICONS[route]}
              iconPosition="start"
              component={Link}
              href={tabHref(projectBasePath, route)}
              ref={(element: HTMLElement | null) => {
                measureRefs.current[route] = element;
              }}
              value={route}
            />
          ))}
          <Tab
            icon={<KeyboardArrowDownIcon />}
            iconPosition="end"
            label="More"
            ref={(element) => {
              moreMeasureRef.current = element;
            }}
            value={MORE_TAB_VALUE}
          />
        </Tabs>
      </Box>
    </Box>
  );
}
