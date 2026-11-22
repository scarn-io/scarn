"use client";

import { useState } from "react";
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
} from "@mui/material";
import { parseGitHost } from "@scarn/sdk/git-url";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { parseApiError } from "@/app/_lib/api-error";
import { checkIssueTracker } from "@/components/integrations/check-issue-tracker";
import {
  JiraSiteFields,
  isJiraSiteComplete,
} from "@/components/integrations/jira-site-fields";
import { BitbucketTokenHelp } from "@/components/integrations/bitbucket-token-help";
import { GitHubTokenHelp } from "@/components/integrations/github-token-help";
import { TokenCredentialForm } from "@/components/integrations/token-credential-form";
import { githubOwner } from "@/components/projects/new/repo-host";
import type { ProjectIntegrationView } from "./project-integration-card";

type ConnectJiraDialogProps = {
  open: boolean;
  jiraBaseUrl: string;
  jiraProjectKeysRaw: string;
  jiraConnecting: boolean;
  onClose: () => void;
  onConfirm: () => void;
  onJiraBaseUrlChange: (value: string) => void;
  onJiraProjectKeysRawChange: (value: string) => void;
};

export function ConnectJiraDialog({
  open,
  jiraBaseUrl,
  jiraProjectKeysRaw,
  jiraConnecting,
  onClose,
  onConfirm,
  onJiraBaseUrlChange,
  onJiraProjectKeysRawChange,
}: ConnectJiraDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Connect Jira</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <JiraSiteFields
            baseUrl={jiraBaseUrl}
            projectKeysRaw={jiraProjectKeysRaw}
            onBaseUrlChange={onJiraBaseUrlChange}
            onProjectKeysRawChange={onJiraProjectKeysRawChange}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          onClick={onConfirm}
          loading={jiraConnecting}
          disabled={!isJiraSiteComplete(jiraBaseUrl, jiraProjectKeysRaw)}
        >
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/**
 * Connects a project's GitHub repo with the caller's own token. The token is
 * checked against the repo first; the check returns the repo id the
 * integration's scope needs. Nothing is kept unless the user saves the token.
 */
export function ConnectGitHubTokenDialog({
  open,
  projectId,
  initialGitUrl,
  onClose,
  onConnected,
}: {
  open: boolean;
  projectId: string;
  initialGitUrl: string;
  onClose: () => void;
  onConnected: (integration: ProjectIntegrationView) => void;
}) {
  const [gitUrl, setGitUrl] = useState(initialGitUrl);
  const [error, setError] = useState<string | null>(null);

  const connect = async (repo: { id: number; fullName: string }) => {
    const { data, error: createError } = await getBrowserScarnApiClient()
      .api.projects({ projectId })
      .integrations.post({
        kind: "github_token",
        externalScope: { repos: [repo] },
      });
    if (createError) {
      setError(parseApiError(createError, "Could not connect GitHub."));
      return;
    }
    onConnected(data);
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Connect GitHub with a token</DialogTitle>
      <DialogContent>
        {open ? (
          <Stack spacing={2} sx={{ pt: 1 }}>
            <TextField
              label="Repository URL"
              placeholder="https://github.com/acme/api"
              value={gitUrl}
              onChange={(event) => {
                setGitUrl(event.target.value);
              }}
              fullWidth
              required
            />
            {error ? <Alert severity="error">{error}</Alert> : null}
            <TokenCredentialForm
              platform="github"
              ready={gitUrl.trim().length > 0}
              help={<GitHubTokenHelp owner={githubOwner(gitUrl)} />}
              submitLabel="Check and connect"
              check={(credential) =>
                checkIssueTracker(gitUrl.trim(), {
                  type: "github_token",
                  credential,
                })
              }
              onVerified={({ repo }) => {
                setError(null);
                if (!repo) {
                  setError("Could not read that repository.");
                  return;
                }
                void connect(repo);
              }}
            />
          </Stack>
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
      </DialogActions>
    </Dialog>
  );
}

/**
 * Connects a project's Bitbucket repo with the caller's Atlassian email and
 * API token. The token is checked against the repo first; nothing is kept
 * unless the user saves the token.
 */
export function ConnectBitbucketDialog({
  open,
  projectId,
  initialGitUrl,
  onClose,
  onConnected,
}: {
  open: boolean;
  projectId: string;
  initialGitUrl: string;
  onClose: () => void;
  onConnected: (integration: ProjectIntegrationView) => void;
}) {
  const [gitUrl, setGitUrl] = useState(initialGitUrl);
  const [error, setError] = useState<string | null>(null);

  const connect = async () => {
    const host = parseGitHost(gitUrl.trim());
    if (host.host !== "bitbucket") {
      setError("Enter a bitbucket.org repository URL.");
      return;
    }
    const { data, error: createError } = await getBrowserScarnApiClient()
      .api.projects({ projectId })
      .integrations.post({
        kind: "bitbucket",
        externalScope: {
          repos: [
            {
              workspace: host.workspace,
              slug: host.slug,
              fullName: `${host.workspace}/${host.slug}`,
            },
          ],
        },
      });
    if (createError) {
      setError(parseApiError(createError, "Could not connect Bitbucket."));
      return;
    }
    onConnected(data);
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Connect Bitbucket</DialogTitle>
      <DialogContent>
        {open ? (
          <Stack spacing={2} sx={{ pt: 1 }}>
            <TextField
              label="Repository URL"
              placeholder="https://bitbucket.org/team/api"
              value={gitUrl}
              onChange={(event) => {
                setGitUrl(event.target.value);
              }}
              fullWidth
              required
            />
            {error ? <Alert severity="error">{error}</Alert> : null}
            <TokenCredentialForm
              platform="bitbucket"
              ready={gitUrl.trim().length > 0}
              help={<BitbucketTokenHelp />}
              submitLabel="Check and connect"
              check={(credential) =>
                checkIssueTracker(gitUrl.trim(), {
                  type: "bitbucket",
                  credential,
                })
              }
              onVerified={() => {
                setError(null);
                void connect();
              }}
            />
          </Stack>
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
      </DialogActions>
    </Dialog>
  );
}
