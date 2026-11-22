import { createScarnTreaty } from "./scarn-treaty";
import { headers } from "next/headers";

export const resolveScarnApiBaseUrl = ({
  serverEnvApiUrl,
  publicEnvApiUrl,
  host,
  forwardedHost,
  forwardedProto,
  protocol,
}: {
  serverEnvApiUrl?: string | null | undefined;
  publicEnvApiUrl?: string | null | undefined;
  host?: string | null | undefined;
  forwardedHost?: string | null | undefined;
  forwardedProto?: string | null | undefined;
  protocol?: string | null | undefined;
}): string => {
  const baseUrl = serverEnvApiUrl?.trim() || publicEnvApiUrl?.trim();

  if (baseUrl) return baseUrl;

  const resolvedHost = forwardedHost?.trim() || host?.trim();
  const resolvedProtocol =
    forwardedProto?.trim() ||
    protocol?.trim() ||
    (process.env.NODE_ENV === "production" ? "https" : "http");

  if (resolvedHost) {
    return `${resolvedProtocol}://${resolvedHost}`;
  }

  if (process.env.NODE_ENV !== "production") {
    return "http://127.0.0.1:3000";
  }

  throw new Error(
    "SCARN_API_URL or NEXT_PUBLIC_SCARN_API_URL must be set in production.",
  );
};

const getScarnApiBaseUrl = async (): Promise<string> => {
  const requestHeaders = await headers();

  return resolveScarnApiBaseUrl({
    serverEnvApiUrl: process.env["SCARN_API_URL"],
    publicEnvApiUrl: process.env.NEXT_PUBLIC_SCARN_API_URL,
    host: requestHeaders.get("host"),
    forwardedHost: requestHeaders.get("x-forwarded-host"),
    forwardedProto: requestHeaders.get("x-forwarded-proto"),
  });
};

export async function getScarnApiRequestHeaders(): Promise<
  Record<string, string>
> {
  const requestHeaders = await headers();
  const forwardedHeaders: Record<string, string> = {};

  const cookieHeader = requestHeaders.get("cookie");
  const authorizationHeader = requestHeaders.get("authorization");

  if (cookieHeader) {
    forwardedHeaders["cookie"] = cookieHeader;
  }

  if (authorizationHeader) {
    forwardedHeaders["authorization"] = authorizationHeader;
  }

  return forwardedHeaders;
}

export async function getScarnApiClient() {
  return createScarnTreaty(await getScarnApiBaseUrl());
}
