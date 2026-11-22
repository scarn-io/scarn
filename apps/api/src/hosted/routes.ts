import { Elysia } from "elysia";
import type { AppContext } from "@scarn/core/lib/di";

/**
 * Open-source build of `routes.ts`: the public mirror copies this file over
 * it, so `createAppCore` mounts no hosted-only routes.
 */
export const createHostedRoutes: (appContext: AppContext) => Elysia = () =>
  new Elysia();
