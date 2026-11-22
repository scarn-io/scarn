"use client";

import { useState } from "react";
import {
  Alert,
  Button,
  Link as MuiLink,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import { BitbucketTokenHelp } from "@/components/integrations/bitbucket-token-help";
import { checkIssueTracker } from "@/components/integrations/check-issue-tracker";
import { GitHubTokenHelp } from "@/components/integrations/github-token-help";
import {
  JiraSiteFields,
  isJiraSiteComplete,
  parseJiraProjectKeys,
} from "@/components/integrations/jira-site-fields";
import { TokenCredentialForm } from "@/components/integrations/token-credential-form";
import { AutoSyncConsentField } from "./auto-sync-consent-field";
import {
  autoSyncCandidate,
  connectionSummary,
  issueTrackerOptions,
  type IssueTrackerChoice,
  type IssueTrackerOption,
} from "./issue-tracker-choice";
import { IssueTrackerOptionCard } from "./issue-tracker-option-card";
import { githubOwner, type RepoCheck } from "./repo-host";

function GitHubAppBody({
  check,
  repoName,
  installHref,
}: {
  check: RepoCheck;
  repoName: string;
  installHref: string;
}) {
  if (check.githubApp) {
    return (
      <Typography variant="body2">
        Connected through GitHub App
        {check.githubApp.accountLogin
          ? ` (${check.githubApp.accountLogin})`
          : ""}
        .
      </Typography>
    );
  }
  return (
    <Stack spacing={1}>
      <Button
        variant="outlined"
        href={installHref}
        sx={{ alignSelf: "flex-start" }}
      >
        Install the GitHub App on {repoName}
      </Button>
      <Typography variant="caption" color="text.secondary">
        Needs admin access to the repo or org. Don&apos;t have it? Use a
        personal access token instead.
      </Typography>
    </Stack>
  );
}

export const BITBUCKET_ISSUES_DISABLED_MESSAGE =
  "This repo's issue tracker is off. Many Bitbucket teams use Jira. Connect Jira instead?";

function BitbucketIssuesDisabledAlert({
  onConnectJira,
}: {
  onConnectJira: () => void;
}) {
  return (
    <Alert
      severity="info"
      action={
        <Button color="inherit" size="small" onClick={onConnectJira}>
          Connect Jira
        </Button>
      }
    >
      {BITBUCKET_ISSUES_DISABLED_MESSAGE}
    </Alert>
  );
}

/**
 * Step 3: where the project's issues come from. Options depend on the repo's
 * host. A token is checked (and optionally saved) before Create is offered;
 * an unsaved token lives only in this component's memory.
 */
export function IssueTrackerStep({
  gitUrl,
  check,
  repoName,
  githubAppConfigured,
  installHref,
  isCreating,
  createError,
  onBack,
  onCreate,
}: {
  gitUrl: string;
  check: RepoCheck;
  repoName: string;
  githubAppConfigured: boolean;
  installHref: string;
  isCreating: boolean;
  createError: string | null;
  onBack: () => void;
  onCreate: (
    choice: IssueTrackerChoice | null,
    firstSyncHorizonDays?: number,
  ) => void;
}) {
  const options = issueTrackerOptions(check.host, githubAppConfigured);
  const [selected, setSelected] = useState<IssueTrackerOption | null>(
    options[0] ?? null,
  );
  const [verified, setVerified] = useState<IssueTrackerChoice | null>(null);
  const [jiraBaseUrl, setJiraBaseUrl] = useState("");
  const [jiraProjectKeysRaw, setJiraProjectKeysRaw] = useState("");
  const [firstSyncHorizonDays, setFirstSyncHorizonDays] = useState(7);
  const [autoSync, setAutoSync] = useState(false);

  const appChoice: IssueTrackerChoice | null =
    selected === "github_app" && check.githubApp
      ? {
          type: "github_app",
          installationId: check.githubApp.installationId,
          accountLogin: check.githubApp.accountLogin,
        }
      : null;
  const choice =
    appChoice ?? (verified && verified.type === selected ? verified : null);
  const autoSyncIntegration = autoSyncCandidate(choice, repoName);
  const autoSyncOn = autoSyncIntegration !== null && autoSync;
  const createChoice: IssueTrackerChoice | null =
    autoSyncOn && (choice?.type === "jira" || choice?.type === "github_token")
      ? { ...choice, autoSync: true }
      : choice;

  const changeVerified = (next: IssueTrackerChoice | null) => {
    setVerified(next);
    setAutoSync(false);
  };

  const select = (option: IssueTrackerOption) => {
    if (option === selected) return;
    setSelected(option);
    changeVerified(null);
  };

  const optionBody = (option: IssueTrackerOption) => {
    if (option === "github_app") {
      return (
        <GitHubAppBody
          check={check}
          repoName={repoName}
          installHref={installHref}
        />
      );
    }
    if (verified && verified.type === option && "verified" in verified) {
      return (
        <Stack direction="row" spacing={1} alignItems="center">
          <Typography variant="body2">
            Checked as {verified.verified.account}.
          </Typography>
          <MuiLink
            component="button"
            type="button"
            variant="body2"
            onClick={() => {
              changeVerified(null);
            }}
          >
            Change
          </MuiLink>
        </Stack>
      );
    }
    if (option === "bitbucket") {
      return (
        <TokenCredentialForm
          platform="bitbucket"
          help={<BitbucketTokenHelp />}
          check={(credential) =>
            checkIssueTracker(gitUrl, { type: "bitbucket", credential })
          }
          onVerified={(result) => {
            changeVerified({ type: "bitbucket", verified: result });
          }}
          renderError={(failure) =>
            failure.code === "BITBUCKET_ISSUES_DISABLED" &&
            options.includes("jira") ? (
              <BitbucketIssuesDisabledAlert
                onConnectJira={() => {
                  select("jira");
                }}
              />
            ) : undefined
          }
        />
      );
    }
    if (option === "github_token") {
      return (
        <TokenCredentialForm
          platform="github"
          help={<GitHubTokenHelp owner={githubOwner(gitUrl)} />}
          check={(credential) =>
            checkIssueTracker(gitUrl, { type: "github_token", credential })
          }
          onVerified={(result) => {
            changeVerified({ type: "github_token", verified: result });
          }}
        />
      );
    }
    const projectKeys = parseJiraProjectKeys(jiraProjectKeysRaw);
    return (
      <Stack spacing={2}>
        <JiraSiteFields
          baseUrl={jiraBaseUrl}
          projectKeysRaw={jiraProjectKeysRaw}
          onBaseUrlChange={setJiraBaseUrl}
          onProjectKeysRawChange={setJiraProjectKeysRaw}
        />
        <TokenCredentialForm
          platform="jira"
          ready={isJiraSiteComplete(jiraBaseUrl, jiraProjectKeysRaw)}
          check={(credential) =>
            checkIssueTracker(gitUrl, {
              type: "jira",
              baseUrl: jiraBaseUrl.trim(),
              projectKeys,
              credential,
            })
          }
          onVerified={(result) => {
            changeVerified({
              type: "jira",
              baseUrl: jiraBaseUrl.trim(),
              projectKeys,
              verified: result,
            });
          }}
        />
      </Stack>
    );
  };

  return (
    <Stack spacing={2.5} sx={{ py: 1 }}>
      <Typography variant="body2" color="text.secondary">
        Choose where this project&apos;s issues come from.
      </Typography>
      <Stack spacing={1.5} role="radiogroup" aria-label="Issue tracking">
        {options.map((option) => (
          <IssueTrackerOptionCard
            key={option}
            option={option}
            selected={selected === option}
            recommended={option === "github_app"}
            onSelect={() => {
              select(option);
            }}
          >
            {optionBody(option)}
          </IssueTrackerOptionCard>
        ))}
      </Stack>

      {choice ? (
        <TextField
          select
          label="First sync: issues updated within"
          value={firstSyncHorizonDays}
          onChange={(event) => {
            setFirstSyncHorizonDays(Number(event.target.value));
          }}
          helperText="Only the first import is limited. Older issues are not imported automatically later."
          size="small"
        >
          <MenuItem value={7}>Last 7 days</MenuItem>
          <MenuItem value={30}>Last 30 days</MenuItem>
          <MenuItem value={180}>Last 180 days</MenuItem>
        </TextField>
      ) : null}

      {autoSyncIntegration ? (
        <AutoSyncConsentField
          integration={autoSyncIntegration}
          githubAppConfigured={githubAppConfigured}
          checked={autoSync}
          onChange={setAutoSync}
        />
      ) : null}

      {choice ? (
        <Typography variant="body2" aria-label="Connection summary">
          Issues will sync {connectionSummary(choice)}.
          {choice.type === "github_app"
            ? null
            : autoSyncOn
              ? " Syncs run every 5 minutes."
              : " Syncs run only when you ask for them."}
        </Typography>
      ) : null}
      {createError ? <Alert severity="error">{createError}</Alert> : null}

      <Stack direction="row" spacing={1.5}>
        <Button
          variant="text"
          color="inherit"
          startIcon={<ArrowBackIcon />}
          onClick={onBack}
          disabled={isCreating}
        >
          Back
        </Button>
        <Button
          variant="contained"
          loading={isCreating}
          disabled={!createChoice}
          onClick={() => {
            if (createChoice) onCreate(createChoice, firstSyncHorizonDays);
          }}
        >
          Create project
        </Button>
      </Stack>
      <MuiLink
        component="button"
        type="button"
        underline="hover"
        color="text.secondary"
        disabled={isCreating}
        onClick={() => {
          onCreate(null);
        }}
        sx={{ alignSelf: "flex-start", fontSize: "0.8125rem" }}
      >
        Skip for now
      </MuiLink>
    </Stack>
  );
}
