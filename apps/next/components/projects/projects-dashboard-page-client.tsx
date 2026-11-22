"use client";

import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Link as MuiLink,
  Stack,
  Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import PeopleAltOutlinedIcon from "@mui/icons-material/PeopleAltOutlined";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ProjectContract } from "@scarn/core";
import {
  DEMO_ACCOUNT_USERNAME,
  DEMO_PROJECT_SLUG,
} from "@scarn/core/demo-project/demo-account";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { PageHeader } from "@/components/page-header";
import { CONTENT_MAX_WIDTH } from "@/components/theme-provider";
import { RecordListEmpty } from "@/components/common/record-list/record-list-empty";
import { CopyableCommand } from "@/components/common/copyable-command";
import { projectSubPath } from "@/app/(protected)/projects/_lib/project-routing";

const CLI_INIT_COMMAND = "npm i -g @scarn/cli && scarn init";

const DEMO_PROJECT_PATH = projectSubPath(
  DEMO_ACCOUNT_USERNAME,
  DEMO_PROJECT_SLUG,
  "work-items",
);

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; projects: ProjectContract[] };

const CREATED_DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
});

export function ProjectsDashboardPageClient({
  username,
  showDemoLink,
}: {
  username: string;
  /** Link to the seeded demo project; only when the deployment enables it. */
  showDemoLink: boolean;
}) {
  const router = useRouter();
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoadState({ status: "loading" });

      try {
        const scarnApiClient = getBrowserScarnApiClient();
        const { data, error } = await scarnApiClient.api.projects.get();

        if (cancelled) return;

        if (error) {
          throw new Error("Failed to load projects");
        }

        setLoadState({
          status: "ready",
          projects: Array.isArray(data) ? data : [],
        });
      } catch (error) {
        if (cancelled) return;

        setLoadState({
          status: "error",
          message:
            error instanceof Error ? error.message : "Failed to load projects",
        });
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, []);

  const projects = loadState.status === "ready" ? loadState.projects : [];

  return (
    <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
      <Stack
        spacing={0}
        sx={{
          maxWidth: CONTENT_MAX_WIDTH,
          mx: "auto",
          width: "100%",
          px: { xs: 2, md: 4 },
          py: 4,
        }}
      >
        <PageHeader
          title="Projects"
          description="Pick a project to open its work queue, or create a new one."
          actions={
            <Button
              color="primary"
              startIcon={<AddIcon />}
              variant="contained"
              onClick={() => {
                router.push("/projects/new");
              }}
            >
              New project
            </Button>
          }
        />
        {loadState.status === "loading" ? (
          <Stack
            spacing={2}
            alignItems="center"
            justifyContent="center"
            sx={{ minHeight: 240 }}
          >
            <CircularProgress size={24} />
            <Typography color="text.secondary">Loading projects…</Typography>
          </Stack>
        ) : loadState.status === "error" ? (
          <Alert severity="error">{loadState.message}</Alert>
        ) : projects.length === 0 ? (
          <Box
            sx={{
              border: 1,
              borderColor: "divider",
              borderRadius: 2,
              backgroundColor: "background.paper",
            }}
          >
            <RecordListEmpty
              icon={<FolderOutlinedIcon fontSize="medium" />}
              title="No projects yet"
              description={
                showDemoLink
                  ? "Projects connect a repository to an agent work queue. Create one to get started, or see what scarn can do in the public demo project."
                  : "Projects connect a repository to an agent work queue. Create one to get started."
              }
              action={
                <Stack spacing={2} alignItems="center">
                  <Stack
                    direction="row"
                    spacing={2}
                    alignItems="center"
                    flexWrap="wrap"
                    justifyContent="center"
                  >
                    <Button
                      color="primary"
                      variant="contained"
                      component={Link}
                      href="/projects/new"
                    >
                      Create a project
                    </Button>
                    {showDemoLink ? (
                      <MuiLink
                        component={Link}
                        href={DEMO_PROJECT_PATH}
                        underline="hover"
                      >
                        See the demo project
                      </MuiLink>
                    ) : null}
                  </Stack>
                  <Stack spacing={0.75} alignItems="center">
                    <Typography variant="body2" color="text.secondary">
                      Or from your repo:
                    </Typography>
                    <CopyableCommand command={CLI_INIT_COMMAND} />
                  </Stack>
                </Stack>
              }
            />
          </Box>
        ) : (
          <Box
            sx={{
              border: 1,
              borderColor: "divider",
              borderRadius: 2,
              overflow: "hidden",
              backgroundColor: "background.paper",
            }}
          >
            {projects.map((project, index) => {
              const memberCount = project.memberships.length;

              return (
                <Box
                  key={project.id}
                  sx={{
                    borderTop: index === 0 ? 0 : 1,
                    borderColor: "divider",
                    px: 2.5,
                    py: 2,
                    transition: "background-color 120ms ease",
                    "&:hover": { backgroundColor: "var(--color-bg-hover)" },
                  }}
                >
                  <Stack
                    direction="row"
                    spacing={2}
                    alignItems="flex-start"
                    justifyContent="space-between"
                  >
                    <Stack spacing={0.5} sx={{ minWidth: 0 }}>
                      <MuiLink
                        component={Link}
                        href={projectSubPath(
                          // Link to the OWNER's username (from the read model),
                          // not the viewer's — correct for shared projects owned
                          // by a different user. Falls back to the viewer's
                          // username only if the owner didn't resolve.
                          project.ownerUsername ?? username,
                          project.slug,
                          "work-items",
                        )}
                        underline="hover"
                        sx={{
                          fontSize: "1rem",
                          fontWeight: 600,
                          width: "fit-content",
                        }}
                      >
                        {project.name}
                      </MuiLink>
                      {project.description ? (
                        <Typography variant="body2" color="text.secondary">
                          {project.description}
                        </Typography>
                      ) : null}
                      <Typography
                        variant="caption"
                        color="text.disabled"
                        sx={{
                          fontFamily: "var(--font-mono)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {project.gitUrl}
                      </Typography>
                    </Stack>
                    <Stack
                      direction="row"
                      spacing={1.5}
                      alignItems="center"
                      sx={{ flexShrink: 0, pt: 0.25 }}
                    >
                      <Chip
                        size="small"
                        icon={<PeopleAltOutlinedIcon sx={{ fontSize: 14 }} />}
                        label={`${String(memberCount)} member${memberCount === 1 ? "" : "s"}`}
                      />
                      <Typography variant="caption" color="text.secondary">
                        Created{" "}
                        {CREATED_DATE_FORMAT.format(
                          new Date(project.createdAt),
                        )}
                      </Typography>
                    </Stack>
                  </Stack>
                </Box>
              );
            })}
          </Box>
        )}
      </Stack>
    </Box>
  );
}
