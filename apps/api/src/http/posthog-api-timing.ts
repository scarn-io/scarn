import { ElysiaStatus, StatusMap, type AnyElysia, type Elysia } from "elysia";
import { readApiClient } from "@scarn/observability/analytics/api-client";
import { captureApiEndpointTiming } from "@scarn/observability/analytics/server";

const ANONYMOUS_DISTINCT_ID = "anonymous";
const DEFAULT_STATUS_CODE = 200;
const TIMING_PRECISION = 1000;

type RouteMetadata = {
  operationId?: string;
  tags?: string[];
};

type RouteRecord = {
  method: string;
  path: string;
  hooks?: {
    detail?: RouteMetadata;
  };
};

type RouteMetadataByKey = Map<string, RouteMetadata>;

type RouteMetadataRef = {
  current: RouteMetadataByKey;
};

/**
 * The slice of an Elysia request context that timing reads. Elysia 2 sets
 * `route` only for dynamic routes; static routes fall back to `path`, which
 * is tracked only when it is a registered route so unmatched URLs never
 * become route labels.
 */
type ApiTimingContext = {
  request: Request;
  path: string;
  route?: string;
  set: {
    status?: number | keyof typeof StatusMap;
  };
  auth?: {
    userId?: string;
    user?: {
      id?: string;
    } | null;
  };
};

type AfterHandleTimingContext = ApiTimingContext & {
  responseValue: unknown;
};

type ErrorProblem = {
  status: number;
  code?: string;
};

type TimingOutcome = {
  statusCode: number;
  errorCode?: string;
};

type RequestStart = {
  wallMs: number;
  cpu: NodeJS.CpuUsage | undefined;
};

type PosthogApiTiming<T> = {
  app: T;
  captureErrorTiming: (
    context: ApiTimingContext,
    problem: ErrorProblem,
  ) => void;
};

const shouldTrackRoute = (route: string): boolean =>
  route.startsWith("/api/") && !route.startsWith("/api/openapi");

const getRouteMetadataKey = (method: string, route: string): string =>
  `${method.toUpperCase()} ${route}`;

const roundMs = (ms: number): number =>
  Math.round(ms * TIMING_PRECISION) / TIMING_PRECISION;

const getRoundedDurationMs = (startTime: number): number =>
  roundMs(performance.now() - startTime);

const hasCpuUsage = ((): boolean => {
  try {
    process.cpuUsage();
    return true;
  } catch {
    return false;
  }
})();

/**
 * Process CPU usage, or undefined where the runtime has none (Cloudflare
 * Workers, whose `nodejs_compat` `process.cpuUsage` throws "not implemented").
 */
const readCpuUsage = (start?: NodeJS.CpuUsage): NodeJS.CpuUsage | undefined =>
  hasCpuUsage ? process.cpuUsage(start) : undefined;

/**
 * CPU time (user + system) the process spent since `start`. Process-wide, so
 * under Fluid compute concurrency it includes work from overlapping requests
 * on the same instance; aggregate it per route rather than trusting a single
 * sample.
 */
const getRoundedCpuMs = (
  start: NodeJS.CpuUsage | undefined,
): number | undefined => {
  const usage = start === undefined ? undefined : readCpuUsage(start);
  return usage === undefined
    ? undefined
    : roundMs((usage.user + usage.system) / 1000);
};

const getSetStatusCode = (
  status: ApiTimingContext["set"]["status"],
): number => {
  if (typeof status === "number") {
    return status;
  }
  return status === undefined ? DEFAULT_STATUS_CODE : StatusMap[status];
};

const getHandledStatusCode = (context: AfterHandleTimingContext): number => {
  const { responseValue } = context;
  if (responseValue instanceof Response) {
    return responseValue.status;
  }
  if (responseValue instanceof ElysiaStatus) {
    const status: unknown = responseValue.status;
    if (typeof status === "number") {
      return status;
    }
  }
  return getSetStatusCode(context.set.status);
};

const getDistinctId = (context: ApiTimingContext): string =>
  context.auth?.userId ?? context.auth?.user?.id ?? ANONYMOUS_DISTINCT_ID;

const captureTiming = (
  context: ApiTimingContext,
  { statusCode, errorCode }: TimingOutcome,
  routeMetadataRef: RouteMetadataRef,
  startedAtByRequest: WeakMap<Request, RequestStart>,
): void => {
  const startedAt = startedAtByRequest.get(context.request);
  startedAtByRequest.delete(context.request);

  const route = context.route ?? context.path;
  if (startedAt === undefined || !shouldTrackRoute(route)) {
    return;
  }

  const method = context.request.method.toUpperCase();
  const routeMetadata =
    routeMetadataRef.current.get(getRouteMetadataKey(method, route)) ??
    routeMetadataRef.current.get(getRouteMetadataKey("ALL", route));
  if (context.route === undefined && routeMetadata === undefined) {
    return;
  }

  const cpuMs = getRoundedCpuMs(startedAt.cpu);
  captureApiEndpointTiming(getDistinctId(context), {
    method,
    route,
    status_code: statusCode,
    duration_ms: getRoundedDurationMs(startedAt.wallMs),
    ...(cpuMs === undefined ? {} : { cpu_ms: cpuMs }),
    ok: statusCode < 400,
    ...(routeMetadata?.operationId
      ? { operation_id: routeMetadata.operationId }
      : {}),
    ...(routeMetadata?.tags?.length ? { tags: routeMetadata.tags } : {}),
    ...(errorCode ? { error_code: errorCode } : {}),
    ...readApiClient(context.request.headers),
  });
};

/** Indexes each tracked route's OpenAPI `detail` by `METHOD path`. */
export const buildRouteMetadata = (
  routes: readonly RouteRecord[],
): RouteMetadataByKey => {
  const routeMetadataByKey = new Map<string, RouteMetadata>();

  for (const route of routes) {
    if (!shouldTrackRoute(route.path)) {
      continue;
    }

    const detail = route.hooks?.detail;
    routeMetadataByKey.set(getRouteMetadataKey(route.method, route.path), {
      operationId: detail?.operationId,
      tags: detail?.tags,
    });
  }

  return routeMetadataByKey;
};

/**
 * Registers request-start and after-handle hooks on `app` (Elysia hooks
 * mutate the instance) and returns `captureErrorTiming` for the app's
 * `onError`, which receives the problem the error handler produced. The
 * after-handle hook returns nothing, so it never short-circuits later
 * after-handle hooks.
 */
export const applyPosthogApiTiming = <T extends AnyElysia>(
  app: T,
  routeMetadataRef: RouteMetadataRef,
): PosthogApiTiming<T> => {
  const startedAtByRequest = new WeakMap<Request, RequestStart>();
  (app as Elysia)
    .onRequest(({ request }) => {
      startedAtByRequest.set(request, {
        wallMs: performance.now(),
        cpu: readCpuUsage(),
      });
    })
    .onAfterHandle((context) => {
      captureTiming(
        context,
        { statusCode: getHandledStatusCode(context) },
        routeMetadataRef,
        startedAtByRequest,
      );
    });

  return {
    app,
    captureErrorTiming: (context, problem) => {
      captureTiming(
        context,
        { statusCode: problem.status, errorCode: problem.code },
        routeMetadataRef,
        startedAtByRequest,
      );
    },
  };
};
