import { signGitHubAppJwt } from "./github-app-jwt";

export type MintInstallationTokenInput = {
  appId: string;
  privateKey: string;
  installationId: string;
  now?: Date;
  fetchImpl?: typeof fetch;
};

export type InstallationToken = {
  token: string;
  expiresAt: Date;
};

type InstallationTokenResponseBody = {
  token?: string;
  expires_at?: string;
  message?: string;
};

export class GitHubInstallationTokenError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "GitHubInstallationTokenError";
  }
}

export const mintGitHubInstallationToken = async ({
  appId,
  privateKey,
  installationId,
  now = new Date(),
  fetchImpl = fetch,
}: MintInstallationTokenInput): Promise<InstallationToken> => {
  const jwt = signGitHubAppJwt({ appId, privateKey, now });
  const response = await fetchImpl(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${jwt}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "scarn",
      },
    },
  );

  if (!response.ok) {
    const errorBody = (await response
      .json()
      .catch(() => null)) as InstallationTokenResponseBody | null;
    throw new GitHubInstallationTokenError(
      `GitHub returned ${String(response.status)} while minting installation token` +
        (errorBody?.message ? `: ${errorBody.message}` : ""),
      response.status,
    );
  }

  const body = (await response.json()) as InstallationTokenResponseBody;
  if (!body.token || !body.expires_at) {
    throw new GitHubInstallationTokenError(
      "GitHub installation token response missing token or expires_at",
      response.status,
    );
  }

  return {
    token: body.token,
    expiresAt: new Date(body.expires_at),
  };
};
