"use client";

import { Link, Typography } from "@mui/material";
import { ATLASSIAN_API_TOKENS_URL } from "@/components/settings/api-key-form-shared";

export const BITBUCKET_TOKEN_SCOPES = [
  "read:repository:bitbucket",
  "read:issue:bitbucket",
  "write:issue:bitbucket",
  "read:user:bitbucket",
] as const;

/** The scopes an Atlassian API token needs to sync Bitbucket issues. */
export function BitbucketTokenHelp() {
  return (
    <Typography variant="body2" color="text.secondary" component="div">
      Create an API token with Bitbucket scopes on your{" "}
      <Link
        href={ATLASSIAN_API_TOKENS_URL}
        target="_blank"
        rel="noopener noreferrer"
      >
        Atlassian API tokens page
      </Link>
      , then enter the email of the Atlassian account it belongs to. Give it
      these scopes:
      <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>
        {BITBUCKET_TOKEN_SCOPES.map((scope) => (
          <li key={scope}>
            <code>{scope}</code>
          </li>
        ))}
      </ul>
    </Typography>
  );
}
