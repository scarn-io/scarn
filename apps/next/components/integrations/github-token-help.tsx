"use client";

import { Link, Typography } from "@mui/material";
import { githubTokenUrl } from "@/components/settings/github-token-url";

/**
 * How to make a GitHub personal access token that can sync issues. The link
 * opens GitHub's token form with the permissions and expiry filled in, and
 * the resource owner too when `owner` is known.
 */
export function GitHubTokenHelp({ owner }: { owner?: string }) {
  return (
    <Typography variant="body2" color="text.secondary" component="div">
      <Link
        href={githubTokenUrl(owner ? { owner } : {})}
        target="_blank"
        rel="noopener noreferrer"
      >
        Create a GitHub token
      </Link>{" "}
      with the permissions already filled in (Metadata read, Issues read &amp;
      write).
      <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>
        <li>
          Under Repository access, choose Only select repositories and pick
          this repository.
        </li>
        <li>
          Using a classic token instead? Give it the <code>repo</code> scope.
        </li>
        <li>
          Your organization may need to approve the token or authorize it for
          SSO.
        </li>
      </ul>
    </Typography>
  );
}
