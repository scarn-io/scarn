import type { AppContext as CoreAppContext } from "@scarn/core/lib/di";
import { createAppCore, type CreateAppCoreOptions } from "./create-app-core";
import { openApiPlugin } from "./http/openapi";

export type CreateAppOptions = Omit<CreateAppCoreOptions, "openApi">;

/** Builds the `/api` Elysia app with live OpenAPI docs at `/api/openapi`. */
export const createApp = (
  appContext: CoreAppContext,
  options: CreateAppOptions = {},
) => createAppCore(appContext, { ...options, openApi: openApiPlugin });
