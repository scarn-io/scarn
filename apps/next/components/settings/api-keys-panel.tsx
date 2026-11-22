"use client";

import { useEffect, useState } from "react";
import {
  Alert,
  Card,
  CardContent,
  Chip,
  IconButton,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import DeleteIcon from "@mui/icons-material/Delete";
import EditIcon from "@mui/icons-material/Edit";
import type { SecretContract } from "@scarn/core/secrets/secret/contracts/secret-contracts";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { parseApiError } from "@/app/_lib/api-error";
import {
  formatAbsoluteTime,
  formatRelativeTime,
} from "@/components/work-items/comment-presentation";
import { AddJiraApiKeyForm } from "./add-jira-api-key-form";
import { AddGitHubTokenForm } from "./add-github-token-form";
import { AddBitbucketApiTokenForm } from "./add-bitbucket-api-token-form";
import { ApiKeyUsedBy } from "./api-key-used-by";
import {
  DeleteApiKeyDialog,
  RenameApiKeyDialog,
} from "./api-keys-panel-dialogs";

const STATUS_CHIP: Record<
  SecretContract["status"],
  { label: string; color: "success" | "warning" | "error" }
> = {
  active: { label: "Active", color: "success" },
  expiring_soon: { label: "Expiring soon", color: "warning" },
  expired: { label: "Expired", color: "error" },
};

const PROVIDER_LABEL: Record<SecretContract["kind"], string> = {
  jira_api_key: "Jira",
  github_token: "GitHub",
  bitbucket_api_token: "Bitbucket",
};

const ADD_FORMS: Record<
  SecretContract["kind"],
  typeof AddJiraApiKeyForm
> = {
  jira_api_key: AddJiraApiKeyForm,
  github_token: AddGitHubTokenForm,
  bitbucket_api_token: AddBitbucketApiTokenForm,
};

const keyAccount = (key: SecretContract): string | null => {
  switch (key.kind) {
    case "jira_api_key":
    case "bitbucket_api_token":
      return key.metadata.email;
    case "github_token":
      return key.metadata.login;
  }
};

const formatDate = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

type ListState =
  | { status: "loading" }
  | { status: "loaded" }
  | { status: "failed"; message: string };

const expiryText = (key: SecretContract): string => {
  if (key.expiresAt === null) return "Never expires";
  return `${key.status === "expired" ? "Expired" : "Expires"} ${formatDate(key.expiresAt)}`;
};

/**
 * Account settings "API keys": the signed-in user's saved Jira API keys,
 * GitHub tokens and Bitbucket API tokens, with add, rename, and delete.
 * Values are write-only — the list only ever shows the last four characters.
 */
export function ApiKeysPanel() {
  const [keys, setKeys] = useState<SecretContract[]>([]);
  const [listState, setListState] = useState<ListState>({ status: "loading" });
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<SecretContract | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const [deleting, setDeleting] = useState<SecretContract | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [addKind, setAddKind] = useState<SecretContract["kind"]>("jira_api_key");
  const AddForm = ADD_FORMS[addKind];

  useEffect(() => {
    let cancelled = false;
    const fail = (message: string) => {
      if (!cancelled) setListState({ status: "failed", message });
    };
    void getBrowserScarnApiClient()
      .api.me.secrets.get()
      .then(({ data, error }) => {
        if (error) {
          fail(parseApiError(error, "Couldn't load your API keys."));
          return;
        }
        if (cancelled) return;
        setKeys(data);
        setListState({ status: "loaded" });
      })
      .catch(() => {
        fail("Couldn't load your API keys.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const clearMessages = () => {
    setErrorMessage(null);
    setSuccessMessage(null);
  };

  const handleRename = (name: string) => {
    if (!renaming) return;
    clearMessages();
    setIsRenaming(true);
    void getBrowserScarnApiClient()
      .api.me.secrets({ secretId: parseUuidV7(renaming.id) })
      .patch({ name })
      .then(({ data, error }) => {
        if (error) {
          setErrorMessage(
            parseApiError(error, "Couldn't rename that API key. Try again."),
          );
          return;
        }
        setKeys((current) =>
          current.map((key) => (key.id === data.id ? data : key)),
        );
        setRenaming(null);
      })
      .catch(() => {
        setErrorMessage("Couldn't rename that API key. Try again.");
      })
      .finally(() => {
        setIsRenaming(false);
      });
  };

  const handleDelete = () => {
    if (!deleting) return;
    const target = deleting;
    clearMessages();
    setIsDeleting(true);
    void getBrowserScarnApiClient()
      .api.me.secrets({ secretId: parseUuidV7(target.id) })
      .delete()
      .then(({ error }) => {
        if (error) {
          setErrorMessage(
            parseApiError(error, "Couldn't delete that API key. Try again."),
          );
          return;
        }
        setKeys((current) => current.filter((key) => key.id !== target.id));
        setDeleting(null);
      })
      .catch(() => {
        setErrorMessage("Couldn't delete that API key. Try again.");
      })
      .finally(() => {
        setIsDeleting(false);
      });
  };

  return (
    <Stack spacing={2}>
      <Typography variant="h6">API keys</Typography>
      <Typography variant="body2" color="text.secondary">
        Save your Jira API keys, GitHub tokens and Bitbucket API tokens so you
        can pick one when syncing an integration or posting a comment, instead
        of pasting it each time. Keys are encrypted and can&apos;t be viewed
        again after you save them.
      </Typography>
      {errorMessage ? <Alert severity="error">{errorMessage}</Alert> : null}
      {successMessage ? (
        <Alert severity="success">{successMessage}</Alert>
      ) : null}
      {listState.status === "failed" ? (
        <Alert severity="error">{listState.message}</Alert>
      ) : null}
      {listState.status === "loaded" && keys.length === 0 ? (
        <Card variant="outlined">
          <CardContent>
            <Typography variant="body2">No saved API keys yet.</Typography>
          </CardContent>
        </Card>
      ) : null}
      {keys.length > 0 ? (
        <Stack spacing={1.5} component="ul" sx={{ p: 0, m: 0 }}>
          {keys.map((key) => {
            const chip = STATUS_CHIP[key.status];
            const account = keyAccount(key);
            return (
              <Card
                key={key.id}
                variant="outlined"
                component="li"
                aria-label={`API key ${key.name}`}
                sx={{ listStyle: "none" }}
              >
                <CardContent>
                  <Stack
                    direction={{ xs: "column", md: "row" }}
                    spacing={2}
                    justifyContent="space-between"
                    alignItems={{ md: "center" }}
                  >
                    <Stack spacing={0.5}>
                      <Stack direction="row" spacing={1} alignItems="center">
                        <Typography variant="subtitle1">{key.name}</Typography>
                        <Chip
                          size="small"
                          variant="outlined"
                          label={PROVIDER_LABEL[key.kind]}
                        />
                        <Chip
                          size="small"
                          color={chip.color}
                          label={chip.label}
                        />
                      </Stack>
                      <Typography variant="body2" color="text.secondary">
                        {account ? `${account} · ` : ""}••••{key.lastFour}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {expiryText(key)} ·{" "}
                        {key.lastUsedAt ? (
                          <Tooltip title={formatAbsoluteTime(key.lastUsedAt)}>
                            <span>
                              Last used {formatRelativeTime(key.lastUsedAt)}
                            </span>
                          </Tooltip>
                        ) : (
                          "Never used"
                        )}
                      </Typography>
                      <ApiKeyUsedBy
                        apiKey={key}
                        onStart={clearMessages}
                        onError={setErrorMessage}
                        onUpdated={(updated) => {
                          setKeys((current) =>
                            current.map((existing) =>
                              existing.id === updated.id ? updated : existing,
                            ),
                          );
                        }}
                      />
                    </Stack>
                    <Stack direction="row" spacing={1}>
                      <IconButton
                        aria-label={`Rename ${key.name}`}
                        onClick={() => {
                          setRenaming(key);
                        }}
                      >
                        <EditIcon />
                      </IconButton>
                      <IconButton
                        aria-label={`Delete ${key.name}`}
                        color="error"
                        onClick={() => {
                          setDeleting(key);
                        }}
                      >
                        <DeleteIcon />
                      </IconButton>
                    </Stack>
                  </Stack>
                </CardContent>
              </Card>
            );
          })}
        </Stack>
      ) : null}

      <ToggleButtonGroup
        exclusive
        size="small"
        aria-label="Kind of API key to add"
        value={addKind}
        onChange={(_event, kind: SecretContract["kind"] | null) => {
          if (kind) setAddKind(kind);
        }}
        sx={{ alignSelf: "flex-start" }}
      >
        <ToggleButton value="jira_api_key">Jira</ToggleButton>
        <ToggleButton value="github_token">GitHub</ToggleButton>
        <ToggleButton value="bitbucket_api_token">Bitbucket</ToggleButton>
      </ToggleButtonGroup>
      <AddForm
        key={addKind}
        onSubmitStart={clearMessages}
        onError={setErrorMessage}
        onCreated={(secret) => {
          setKeys((current) => [secret, ...current]);
          setListState({ status: "loaded" });
          setSuccessMessage(`Saved "${secret.name}".`);
        }}
      />

      <RenameApiKeyDialog
        apiKey={renaming}
        isSaving={isRenaming}
        onClose={() => {
          setRenaming(null);
        }}
        onConfirm={handleRename}
      />
      <DeleteApiKeyDialog
        apiKey={deleting}
        isDeleting={isDeleting}
        onClose={() => {
          setDeleting(null);
        }}
        onConfirm={handleDelete}
      />
    </Stack>
  );
}
