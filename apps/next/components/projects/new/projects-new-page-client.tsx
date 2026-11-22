"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Stack,
  Typography,
} from "@mui/material";
import { useRouter, useSearchParams } from "next/navigation";
import { parseGitHost } from "@scarn/sdk/git-url";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { parseApiError } from "@/app/_lib/api-error";
import { PageHeader } from "@/components/page-header";
import { CONTENT_MAX_WIDTH } from "@/components/theme-provider";
import { projectSubPath } from "@/app/(protected)/projects/_lib/project-routing";
import { buildInstallFlash } from "./build-install-flash";
import { StepIndicator } from "./step-indicator";
import { RepoUrlStep } from "./repo-url-step";
import { ProjectDetailsStep } from "./project-details-step";
import { IssueTrackerStep } from "./issue-tracker-step";
import {
  issueTrackerInput,
  usesUnsavedToken,
  type IssueTrackerChoice,
} from "./issue-tracker-choice";
import { repoFullName, type RepoCheck } from "./repo-host";
import { githubInstallHref } from "@/app/_lib/scarn-api-url";
import {
  readWizardParams,
  wizardHref,
  type WizardParams,
} from "./wizard-params";

type RepoCheckState =
  | { status: "idle" }
  | { status: "loading"; gitUrl: string }
  | { status: "ready"; gitUrl: string; result: RepoCheck }
  | { status: "error"; gitUrl: string; message: string };

/**
 * Loads `POST /projects/repo-check` for the URL in the address bar when the
 * wizard opens past the first step (CLI hand-off, App install return, reload).
 */
function useRepoCheck(gitUrl: string | null, needed: boolean) {
  const [state, setState] = useState<RepoCheckState>({ status: "idle" });
  const current =
    state.status !== "idle" && state.gitUrl === gitUrl ? state : null;

  useEffect(() => {
    if (!needed || gitUrl === null || current !== null) return;
    setState({ status: "loading", gitUrl });
    void getBrowserScarnApiClient()
      .api.projects["repo-check"].post({ gitUrl })
      .then(({ data, error }) => {
        setState(
          error
            ? {
                status: "error",
                gitUrl,
                message: parseApiError(
                  error,
                  "Couldn't check that repository URL.",
                ),
              }
            : { status: "ready", gitUrl, result: data },
        );
      })
      .catch(() => {
        setState({
          status: "error",
          gitUrl,
          message: "Couldn't check that repository URL.",
        });
      });
  }, [gitUrl, needed, current]);

  return {
    state: current ?? ({ status: "idle" } as const),
    remember: (url: string, result: RepoCheck) => {
      setState({ status: "ready", gitUrl: url, result });
    },
  };
}

function createdDestination(
  username: string,
  slug: string,
  initialSyncFailed: boolean,
  unsavedToken: boolean,
): string {
  const query = new URLSearchParams();
  if (initialSyncFailed) query.set("syncFailed", "1");
  if (unsavedToken) query.set("connectedWithUnsavedToken", "1");
  const destination = projectSubPath(username, slug, "work-items");
  return query.size > 0 ? `${destination}?${query.toString()}` : destination;
}

export function ProjectsNewPageClient({
  username,
  githubAppConfigured,
}: {
  username: string;
  githubAppConfigured: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const params = useMemo(() => readWizardParams(searchParams), [searchParams]);
  const flash = useMemo(() => buildInstallFlash(searchParams), [searchParams]);
  const repoCheck = useRepoCheck(params.gitUrl, params.step !== "repository");
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const goTo = (next: WizardParams, step: WizardParams["step"]) => {
    setCreateError(null);
    router.push(wizardHref(next, step));
  };

  const handleCreate = (
    choice: IssueTrackerChoice | null,
    firstSyncHorizonDays?: number,
  ) => {
    if (!params.gitUrl || !params.name) return;
    setIsCreating(true);
    setCreateError(null);
    const client = getBrowserScarnApiClient();
    void client.api.projects
      .post({
        name: params.name,
        description: params.description || null,
        gitUrl: params.gitUrl,
        origin: params.origin,
        ...(choice
          ? {
              issueTracker: {
                ...issueTrackerInput(choice),
                firstSyncHorizonDays,
              },
            }
          : {}),
      })
      .then(({ data, error }) => {
        if (error) {
          setCreateError(parseApiError(error, "Could not create the project."));
          setIsCreating(false);
          return;
        }
        router.push(
          createdDestination(
            username,
            data.slug,
            data.initialSyncFailed,
            usesUnsavedToken(choice),
          ),
        );
      })
      .catch(() => {
        setCreateError("Could not create the project.");
        setIsCreating(false);
      });
  };

  const renderStep = () => {
    if (params.step === "repository" || params.gitUrl === null) {
      return (
        <RepoUrlStep
          initialGitUrl={params.gitUrl ?? ""}
          onContinue={(gitUrl, result) => {
            repoCheck.remember(gitUrl, result);
            const sameRepo = gitUrl === params.gitUrl;
            goTo(
              {
                ...params,
                gitUrl,
                name: sameRepo ? params.name : null,
                description: sameRepo ? params.description : null,
              },
              "details",
            );
          }}
        />
      );
    }
    const { state } = repoCheck;
    if (state.status === "error") {
      return (
        <Stack spacing={2} sx={{ py: 1 }}>
          <Alert severity="error">{state.message}</Alert>
          <Button
            variant="outlined"
            onClick={() => {
              goTo(params, "repository");
            }}
            sx={{ alignSelf: "flex-start" }}
          >
            Change the repository URL
          </Button>
        </Stack>
      );
    }
    if (state.status !== "ready") {
      return (
        <Stack alignItems="center" spacing={2} sx={{ py: 4 }}>
          <CircularProgress size={24} />
          <Typography color="text.secondary">
            Checking the repository…
          </Typography>
        </Stack>
      );
    }
    const gitUrl = params.gitUrl;
    if (params.step === "details" || !params.name) {
      return (
        <ProjectDetailsStep
          key={gitUrl}
          gitUrl={gitUrl}
          check={state.result}
          initialName={params.name}
          initialDescription={params.description}
          onBack={() => {
            goTo(params, "repository");
          }}
          onContinue={(details) => {
            goTo(
              {
                ...params,
                name: details.name,
                description: details.description || null,
              },
              "issues",
            );
          }}
        />
      );
    }
    return (
      <IssueTrackerStep
        key={gitUrl}
        gitUrl={gitUrl}
        check={state.result}
        repoName={repoFullName(parseGitHost(gitUrl)) ?? gitUrl}
        githubAppConfigured={githubAppConfigured}
        installHref={githubInstallHref({
          returnTo: wizardHref(params, "issues"),
        })}
        isCreating={isCreating}
        createError={createError}
        onBack={() => {
          goTo(params, "details");
        }}
        onCreate={handleCreate}
      />
    );
  };

  const visibleStep =
    params.step === "issues" && !params.name ? "details" : params.step;

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
        <Box sx={{ maxWidth: 640, mx: "auto", width: "100%" }}>
          <PageHeader
            title="New project"
            description="Point Scarn at a repository, then choose where its issues come from."
          />
          <StepIndicator current={visibleStep} />
          {flash ? (
            <Alert severity={flash.severity} sx={{ mb: 2 }}>
              {flash.text}
            </Alert>
          ) : null}
          <Box
            sx={{
              border: 1,
              borderColor: "divider",
              borderRadius: 2,
              backgroundColor: "background.paper",
              px: 2.5,
              py: 2.5,
            }}
          >
            {renderStep()}
          </Box>
        </Box>
      </Stack>
    </Box>
  );
}
