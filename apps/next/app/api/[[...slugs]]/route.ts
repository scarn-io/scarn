import { after } from "next/server";
import { flush } from "@scarn/observability/analytics/server";
import { handleRequest } from "@scarn/api/app";

// Pin to the Node.js runtime. The API's pino logger writes NDJSON to stdout
// (captured by Vercel's runtime logs); pino relies on Node APIs and would be
// silently broken on the Edge runtime. This guards against an accidental switch
// to Edge silencing all server logs.
export const runtime = "nodejs";

const handler = async (request: Request): Promise<Response> => {
  const response = await handleRequest(request, {
    waitUntil: (task) => {
      after(task);
    },
  });

  // Analytics captures (api_endpoint_timed, user_signed_up) hand the event to
  // posthog-node, which delivers it over the network asynchronously. Vercel
  // freezes the function the instant this handler returns, killing any request
  // still in flight — which is why server-side events never reached PostHog.
  // after() keeps the invocation alive until the flush resolves without adding
  // that latency to the user's response.
  after(async () => {
    await flush();
  });

  return response;
};

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
