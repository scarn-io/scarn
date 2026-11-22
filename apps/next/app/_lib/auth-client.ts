"use client";

import { createAuthClient } from "better-auth/react";
import {
  deviceAuthorizationClient,
  inferAdditionalFields,
} from "better-auth/client/plugins";
import { getConfiguredPublicScarnApiOrigin } from "./scarn-api-url";

export const authClient = createAuthClient({
  plugins: [
    deviceAuthorizationClient(),
    // Mirror the server-side `additionalFields` (see `@scarn/identity`
    // `lib/auth.ts`) so the client session `user` is typed with `username` and
    // `usernameChosen`. Declared inline (not via `typeof serverAuth`) to keep
    // server-only code out of this "use client" bundle. Keep in sync with the
    // server config.
    inferAdditionalFields({
      user: {
        // `required: false` mirrors the server config and types the session
        // `username` as `string | null` for un-onboarded users.
        username: { type: "string", required: false },
        usernameChosen: { type: "boolean", input: false },
        githubLogin: { type: "string", required: false, input: false },
      },
    }),
  ],
  baseURL: getConfiguredPublicScarnApiOrigin(),
  basePath: "/api/auth",
  fetchOptions: { credentials: "include" },
});
