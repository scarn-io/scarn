import { describe, expect, test } from "bun:test";
import { createIdentityAuth } from "@/lib/auth";
import { getAppUrl } from "@/lib/env";
import { createTestUserAndSession } from "./helpers/create-test-user-and-session";
import { createAuthRequest, readJson } from "./helpers/auth-test-helpers";

const origin = "http://localhost";
const verificationBaseUrl =
  getAppUrl() ?? process.env["BETTER_AUTH_URL"] ?? origin;
const cliClientId = "scarn-cli";

type DeviceCodeResponse = {
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  device_code: string;
  interval: number;
};
type DeviceTokenErrorResponse = { error: string };
type DeviceTokenSuccessResponse = { token_type: string; access_token: string };

describe("device auth lifecycle", () => {
  test.concurrent(
    "requests, approves, exchanges, and restores a bearer session",
    async () => {
      const auth = createIdentityAuth();
      const signedInUser = await createTestUserAndSession();

      const deviceCodeResponse = await auth.handler(
        createAuthRequest("/device/code", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            client_id: cliClientId,
            scope: "openid profile email",
          }),
        }),
      );

      const deviceCodeBody =
        await readJson<DeviceCodeResponse>(deviceCodeResponse);

      expect(deviceCodeResponse.status).toBe(200);
      expect(deviceCodeBody.user_code).toBeTruthy();
      expect(deviceCodeBody.verification_uri).toBe(
        `${verificationBaseUrl}/cli-auth`,
      );
      expect(deviceCodeBody.verification_uri_complete).toContain(
        `/cli-auth?user_code=${deviceCodeBody.user_code}`,
      );

      const pendingTokenResponse = await auth.handler(
        createAuthRequest("/device/token", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code: deviceCodeBody.device_code,
            client_id: cliClientId,
          }),
        }),
      );

      expect(pendingTokenResponse.status).toBe(400);
      const pendingTokenBody =
        await readJson<DeviceTokenErrorResponse>(pendingTokenResponse);
      expect(pendingTokenBody.error).toBe("authorization_pending");

      // The user visits /device?user_code=... to claim (bind their userId to) the
      // device code before they can approve it.
      const claimResponse = await auth.handler(
        createAuthRequest(`/device?user_code=${deviceCodeBody.user_code}`, {
          method: "GET",
          headers: {
            ...signedInUser.authHeaders,
          },
        }),
      );

      expect(claimResponse.status).toBe(200);

      const approveResponse = await auth.handler(
        createAuthRequest("/device/approve", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...signedInUser.authHeaders,
          },
          body: JSON.stringify({
            userCode: deviceCodeBody.user_code,
          }),
        }),
      );

      expect(approveResponse.status).toBe(200);
      expect(await readJson<{ success: true }>(approveResponse)).toEqual({
        success: true,
      });

      await new Promise((resolve) => {
        setTimeout(resolve, deviceCodeBody.interval * 1000);
      });

      const tokenResponse = await auth.handler(
        createAuthRequest("/device/token", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code: deviceCodeBody.device_code,
            client_id: cliClientId,
          }),
        }),
      );

      const tokenBody =
        await readJson<DeviceTokenSuccessResponse>(tokenResponse);

      expect(tokenResponse.status).toBe(200);
      expect(tokenBody.token_type).toBe("Bearer");
      expect(typeof tokenBody.access_token).toBe("string");

      const session = await auth.api.getSession({
        headers: new Headers({
          authorization: `Bearer ${tokenBody.access_token}`,
        }),
      });

      expect(session?.user.id).toBe(signedInUser.userId);
    },
    10000,
  );

  test.concurrent(
    "points the verification URI at APP_URL when set",
    async () => {
      const originalAppUrl = process.env["APP_URL"];
      process.env["APP_URL"] = "https://app.example.test/";
      const auth = createIdentityAuth();
      if (originalAppUrl === undefined) {
        delete process.env["APP_URL"];
      } else {
        process.env["APP_URL"] = originalAppUrl;
      }

      const response = await auth.handler(
        createAuthRequest("/device/code", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ client_id: cliClientId }),
        }),
      );
      const body = await readJson<DeviceCodeResponse>(response);

      expect(response.status).toBe(200);
      expect(body.verification_uri).toBe("https://app.example.test/cli-auth");
      expect(body.verification_uri_complete).toBe(
        `https://app.example.test/cli-auth?user_code=${body.user_code}`,
      );
    },
  );
});
