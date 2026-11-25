/**
 * `context.workItems` for code steps: writes and reads of the run's project's
 * work items, typed from the step's `Features.workItems.*` grants on
 * `project`.
 *
 * - `upsert(items)`, with `create` or `update` on `project`;
 * - `create(item)`, with `create` on `project`;
 * - `latestSourceUpdate(source)`, with `read` on `project`.
 *
 * The real client posts to the worker's per-run step bridge
 * (`contracts/step-bridge.ts`), found through `SCARN_MCP_BRIDGE_URL` and
 * `SCARN_MCP_BRIDGE_TOKEN`, read on the first call. The worker adds the run's
 * claim token and forwards the call to the API, which checks the grants and
 * the claiming user's permissions. Arguments are validated here first.
 * Failures become the errors of `work-items-errors.ts`.
 */
import { prettifyError, type ZodType } from "zod";
import {
  STEP_BRIDGE_TOKEN_ENV,
  STEP_BRIDGE_URL_ENV,
  STEP_BRIDGE_WORK_ITEMS_CREATE_PATH,
  STEP_BRIDGE_WORK_ITEMS_METHOD,
  STEP_BRIDGE_WORK_ITEMS_SOURCE_CURSOR_PATH,
  STEP_BRIDGE_WORK_ITEMS_UPSERT_PATH,
  stepBridgeCreateRequestSchema,
  stepBridgeCreateResponseSchema,
  stepBridgeErrorResponseSchema,
  stepBridgeSourceCursorRequestSchema,
  stepBridgeSourceCursorResponseSchema,
  stepBridgeUpsertRequestSchema,
  stepBridgeUpsertResponseSchema,
  type CreatedWorkItem,
  type StepBridgeCreateRequest,
  type StepBridgeSourceCursorRequest,
  type StepBridgeSourceCursorResponse,
  type StepBridgeUpsertRequest,
  type StepBridgeUpsertResponse,
  type UpsertedWorkItem,
  type WorkItemCreateItem,
  type WorkItemSource,
  type WorkItemUpsertItem,
} from "../../contracts/step-bridge";
import type { Grant } from "./step-features";
import {
  WorkItemsInvalidError,
  WorkItemsRefusedError,
  WorkItemsUnavailableError,
} from "./work-items-errors";

/** Writes the items in one transaction and returns those written, in input order. */
export type WorkItemsUpsert = (
  items: readonly WorkItemUpsertItem[],
) => Promise<UpsertedWorkItem[]>;

/** Creates one top-level `custom` item, or returns the one the key already names. */
export type WorkItemsCreate = (
  item: WorkItemCreateItem,
) => Promise<CreatedWorkItem>;

/** The newest `sourceUpdatedAt` under the source's prefix, or null when there is none. */
export type WorkItemsLatestSourceUpdate = (
  source: WorkItemSource,
) => Promise<string | null>;

type HasProjectGrant<TGrants extends Grant, TAction extends Grant["action"]> = [
  Extract<TGrants, { action: TAction; scope: "project" }>,
] extends [never]
  ? false
  : true;

/**
 * `context.workItems` for a step whose grants are `TGrants`: each method is
 * present only when a grant on `project` allows it.
 */
export type WorkItemsClient<TGrants extends Grant> = (HasProjectGrant<
  TGrants,
  "create" | "update"
> extends true
  ? { readonly upsert: WorkItemsUpsert }
  : unknown) &
  (HasProjectGrant<TGrants, "create"> extends true
    ? { readonly create: WorkItemsCreate }
    : unknown) &
  (HasProjectGrant<TGrants, "read"> extends true
    ? { readonly latestSourceUpdate: WorkItemsLatestSourceUpdate }
    : unknown);

/** True when `TGrants` gives the step any `context.workItems` method. */
export type HasWorkItemsClient<TGrants extends Grant> = HasProjectGrant<
  TGrants,
  "read" | "create" | "update"
>;

/** What a client sends once the arguments are validated; the real and fake clients share it. */
export type WorkItemsBackend = {
  readonly upsert: (
    request: StepBridgeUpsertRequest,
  ) => StepBridgeUpsertResponse | Promise<StepBridgeUpsertResponse>;
  readonly create: (
    request: StepBridgeCreateRequest,
  ) => CreatedWorkItem | Promise<CreatedWorkItem>;
  readonly sourceCursor: (
    request: StepBridgeSourceCursorRequest,
  ) => StepBridgeSourceCursorResponse | Promise<StepBridgeSourceCursorResponse>;
};

function parseArgs<T>(
  method: string,
  schema: ZodType<T>,
  // eslint-disable-next-line local/no-unknown-parameter-type -- runtime guard over author-supplied args
  value: unknown,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new WorkItemsInvalidError(
      `workItems.${method}: invalid arguments:\n${prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

const hasProjectGrant = (
  grants: readonly Grant[],
  actions: readonly Grant["action"][],
): boolean =>
  grants.some(
    (grant) => grant.scope === "project" && actions.includes(grant.action),
  );

/** True when `grants` give a code step any `context.workItems` method. */
export function grantsHaveWorkItemsClient(grants: readonly Grant[]): boolean {
  return hasProjectGrant(grants, ["read", "create", "update"]);
}

/** Builds `context.workItems` over any backend, with the methods `grants` allow. */
export function buildWorkItemsClient<TGrants extends Grant>(
  grants: readonly TGrants[],
  backend: WorkItemsBackend,
): WorkItemsClient<TGrants> {
  const client: Record<string, unknown> = {};
  if (hasProjectGrant(grants, ["create", "update"])) {
    const upsert: WorkItemsUpsert = async (items) => {
      const request = parseArgs("upsert", stepBridgeUpsertRequestSchema, {
        items,
      });
      return (await backend.upsert(request)).items;
    };
    client["upsert"] = upsert;
  }
  if (hasProjectGrant(grants, ["create"])) {
    const create: WorkItemsCreate = async (item) =>
      await backend.create(
        parseArgs("create", stepBridgeCreateRequestSchema, item),
      );
    client["create"] = create;
  }
  if (hasProjectGrant(grants, ["read"])) {
    const latestSourceUpdate: WorkItemsLatestSourceUpdate = async (source) => {
      const response = await backend.sourceCursor(
        parseArgs(
          "latestSourceUpdate",
          stepBridgeSourceCursorRequestSchema,
          source,
        ),
      );
      return response.sourceUpdatedAt;
    };
    client["latestSourceUpdate"] = latestSourceUpdate;
  }
  return Object.freeze(client);
}

export type WorkItemsBridgeFetch = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

export type CodeStepWorkItemsClientOptions = {
  /** Where the bridge env vars are read from; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: WorkItemsBridgeFetch;
};

type BridgeEndpoint = { readonly baseUrl: string; readonly token: string };

async function bridgeError(method: string, response: Response): Promise<Error> {
  const text = await response.text().catch(() => "");
  let body: { error: string; code?: string; meta?: Record<string, unknown> } = {
    error: text,
  };
  try {
    const parsed = stepBridgeErrorResponseSchema.safeParse(JSON.parse(text));
    if (parsed.success) body = parsed.data;
  } catch {
    // Not JSON: keep the raw text as the detail.
  }
  const name = `workItems.${method}`;
  const status = response.status;
  if (body.code === "WORK_ITEM_GRANT_MISSING" || status === 403) {
    const refused = body.meta?.["refused"];
    return new WorkItemsRefusedError(
      `${name} was refused: ${body.error}`,
      body.code ?? "PROJECT_FORBIDDEN",
      typeof refused === "number" ? refused : undefined,
    );
  }
  if (status === 413) {
    return new WorkItemsInvalidError(
      `${name}: the request is too large for the step bridge. Send fewer items per call.`,
    );
  }
  if (status === 400 || status === 422) {
    return new WorkItemsInvalidError(`${name} was rejected: ${body.error}`);
  }
  if (status === 401) {
    return new WorkItemsUnavailableError(
      `${name}: the step bridge rejected this run's token.`,
      "bridge",
      body.error,
    );
  }
  return new WorkItemsUnavailableError(
    `${name}: the step bridge answered HTTP ${String(status)}.`,
    "bridge",
    body.error,
  );
}

function bridgeBackend(
  options: CodeStepWorkItemsClientOptions,
): WorkItemsBackend {
  let endpoint: BridgeEndpoint | undefined;
  const resolveEndpoint = (method: string): BridgeEndpoint => {
    if (endpoint !== undefined) return endpoint;
    const env =
      options.env ??
      (
        globalThis as {
          process?: { env?: Readonly<Record<string, string | undefined>> };
        }
      ).process?.env ??
      {};
    const url = env[STEP_BRIDGE_URL_ENV]?.trim();
    const token = env[STEP_BRIDGE_TOKEN_ENV]?.trim();
    if (!url || !token) {
      throw new WorkItemsUnavailableError(
        `workItems.${method} can't be called: ${STEP_BRIDGE_URL_ENV} and ${STEP_BRIDGE_TOKEN_ENV} aren't set, so this code isn't running inside a Scarn run. In a unit test, pass createFakeWorkItems(...) as context.workItems.`,
        "no_bridge",
        `missing ${[!url ? STEP_BRIDGE_URL_ENV : null, !token ? STEP_BRIDGE_TOKEN_ENV : null].filter((name) => name !== null).join(", ")}`,
      );
    }
    endpoint = { baseUrl: url.replace(/\/+$/, ""), token };
    return endpoint;
  };
  const doFetch: WorkItemsBridgeFetch =
    options.fetch ?? ((url, init) => fetch(url, init));

  const post = async <T>(
    method: string,
    path: string,
    body: object,
    schema: ZodType<T>,
  ): Promise<T> => {
    const { baseUrl, token } = resolveEndpoint(method);
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        method: STEP_BRIDGE_WORK_ITEMS_METHOD,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new WorkItemsUnavailableError(
        `workItems.${method}: couldn't reach the step bridge.`,
        "bridge",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (response.status !== 200) throw await bridgeError(method, response);
    const json: unknown = await response.json().catch(() => undefined);
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new WorkItemsUnavailableError(
        `workItems.${method}: the step bridge sent a response this SDK doesn't understand.`,
        "bridge",
        prettifyError(parsed.error),
      );
    }
    return parsed.data;
  };

  return {
    upsert: (request) =>
      post(
        "upsert",
        STEP_BRIDGE_WORK_ITEMS_UPSERT_PATH,
        request,
        stepBridgeUpsertResponseSchema,
      ),
    create: (request) =>
      post(
        "create",
        STEP_BRIDGE_WORK_ITEMS_CREATE_PATH,
        request,
        stepBridgeCreateResponseSchema,
      ),
    sourceCursor: (request) =>
      post(
        "latestSourceUpdate",
        STEP_BRIDGE_WORK_ITEMS_SOURCE_CURSOR_PATH,
        request,
        stepBridgeSourceCursorResponseSchema,
      ),
  };
}

/**
 * The real `context.workItems` of a code step with `grants`: calls go through
 * the worker's step bridge. Outside a run (no bridge env) every call throws
 * `WorkItemsUnavailableError`; use `createFakeWorkItems` in unit tests.
 */
export function createCodeStepWorkItemsClient<TGrants extends Grant>(
  grants: readonly TGrants[],
  options: CodeStepWorkItemsClientOptions = {},
): WorkItemsClient<TGrants> {
  return buildWorkItemsClient(grants, bridgeBackend(options));
}
