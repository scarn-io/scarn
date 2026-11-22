import { Elysia, type Context } from "elysia";
import { getIdentityAuth } from "@scarn/identity";

const betterAuthView = (context: Context) => {
  const BETTER_AUTH_ACCEPT_METHODS = ["POST", "GET"];
  // validate request method
  if (BETTER_AUTH_ACCEPT_METHODS.includes(context.request.method)) {
    return getIdentityAuth().handler(context.request);
  } else {
    return context.status(405);
  }
};
export const createAuthRoutes = () =>
  // `parse: "none"` keeps Elysia from consuming the body — Better Auth reads it
  // itself, and a double-read throws "Body has already been read".
  new Elysia().all("/auth/*", { parse: "none" }, betterAuthView);
