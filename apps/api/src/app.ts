import {
  runWithBackgroundTaskHost,
  type BackgroundTaskHost,
} from "@scarn/core/lib/background-tasks";
import { createAppContext } from "@scarn/core/lib/di";
import { runWithWorkNotifyScope } from "@scarn/core/tasks/task-run/application/work-notifier";
import { createLogger } from "@scarn/observability/logging";
import { createApp } from "./create-app";

export { createApp, type CreateAppOptions } from "./create-app";

const appContext = createAppContext({
  logger: createLogger({
    name: "api",
    level: process.env["LOG_LEVEL"] ?? "info",
  }),
});

export const app = createApp(appContext);

export type App = typeof app;

/**
 * Serves one request through `app` inside a work-notify scope, so every
 * `workNotifier.enqueued` during the request is flushed to the work-signal
 * Worker before the response is returned. Every HTTP entry point should call
 * this rather than `app.fetch`/`app.handle` directly. A host that freezes
 * once the response is returned passes `backgroundTasks` (Vercel's `after`)
 * so work finishing after the response, such as a relayed stream's cleanup,
 * keeps the invocation alive; a long-lived process needs none.
 */
export const handleRequest = (
  request: Request,
  backgroundTasks?: BackgroundTaskHost,
): Promise<Response> => {
  const handle = () =>
    runWithWorkNotifyScope(appContext.workSignal, appContext.logger, () =>
      app.handle(request),
    );
  return backgroundTasks
    ? runWithBackgroundTaskHost(backgroundTasks, handle)
    : handle();
};
