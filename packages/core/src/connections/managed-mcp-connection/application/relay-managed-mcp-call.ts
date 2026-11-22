import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { isUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { getDb } from "@scarn/core/lib/db";
import { CoreError } from "@scarn/core/lib/errors";
import type { TaskRunRepo } from "@scarn/core/tasks/task-run/application/task-run-repo";
import type { TaskRunEntity } from "@scarn/core/tasks/task-run/domain/task-run-entity";
import {
  createManagedOperation,
  type ManagedLaunchConnectionEntity,
  type ManagedOperation,
} from "../domain/managed-launch-connection-entity";
import {
  launchClaimTokenDigest,
  mcpSessionIdDigest,
  relayCapabilityDigest,
} from "../domain/managed-launch-digests";
import {
  acquireManagedAccessToken,
  forceRefreshManagedAccessToken,
  type AcquireManagedAccessTokenDeps,
  type ManagedAccessToken,
} from "./acquire-managed-access-token";
import type { ManagedLaunchRepo } from "./managed-launch-repo";
import type {
  ManagedMcpPassthrough,
  ManagedMcpPassthroughResult,
} from "./managed-mcp-passthrough";

/** Request bodies larger than this are refused before admission (decision 14). */
export const MANAGED_RELAY_MAX_BODY_BYTES = 64 * 1024;
/** How long a relayed call waits out another caller's refresh (decision 14). */
export const MANAGED_RELAY_REFRESH_BUSY_WAIT_MS = 2_000;
/** An operation's lease outlives its call by this much (decision 15). */
export const MANAGED_OPERATION_DEADLINE_GRACE_MS = 5_000;

const REFRESH_BUSY_POLL_MS = 200;

export type RelayManagedMcpCallDeps = AcquireManagedAccessTokenDeps & {
  taskRunRepo: Pick<TaskRunRepo, "load">;
  managedLaunchRepo: Pick<
    ManagedLaunchRepo,
    | "loadByCapabilityDigest"
    | "insertOperation"
    | "deleteOperation"
    | "saveSessionBinding"
  >;
  managedMcpPassthrough: ManagedMcpPassthrough;
  /** Keeps the host alive for `task`, which settles after the response is sent. */
  runAfterResponse: (task: Promise<unknown>) => void;
  refreshBusyWaitMs?: number;
};

export type RelayManagedMcpCallInput = {
  /** The `:launchConnectionId` the caller addressed. */
  launchConnectionId: string;
  request: Request;
};

type RelayRequest = {
  method: "POST" | "DELETE";
  launchConnectionId: UuidV7;
  capability: string;
  sessionId: string | null;
  headers: Headers;
  body: Uint8Array<ArrayBuffer> | null;
  signal: AbortSignal;
};

/**
 * A relay refusal or provider failure. Its `meta` is public: it only ever
 * holds the launch's authority-loss reason or a provider status class.
 */
export class ManagedRelayError extends CoreError {
  constructor(
    code: string,
    message: string,
    status: number,
    meta?: Record<string, unknown>,
  ) {
    super({ code, message, status, meta });
  }
}

const relayError = (
  code: string,
  message: string,
  status: number,
  meta?: Record<string, unknown>,
) => new ManagedRelayError(code, message, status, meta);

const unauthorized = () =>
  relayError(
    "MANAGED_RELAY_UNAUTHORIZED",
    "The relay capability is missing or not valid for this URL",
    401,
  );

const tooLarge = () =>
  relayError(
    "MANAGED_RELAY_BODY_TOO_LARGE",
    `The request body exceeds ${String(MANAGED_RELAY_MAX_BODY_BYTES)} bytes`,
    413,
  );

/** The closed list a non-2xx or failed forward maps to; nothing the provider sent is kept. */
const providerFailure = (
  result: Exclude<ManagedMcpPassthroughResult, { kind: "forwarded" }>,
): CoreError => {
  if (result.kind === "failed") {
    return result.failure === "timeout"
      ? relayError(
          "MANAGED_PROVIDER_TIMEOUT",
          "The provider didn't answer in time",
          504,
        )
      : relayError(
          "MANAGED_PROVIDER_UNAVAILABLE",
          "The provider could not be reached",
          502,
        );
  }
  if (result.status === 401) {
    return relayError(
      "MANAGED_PROVIDER_UNAUTHORIZED",
      "The provider refused the connection's credentials",
      502,
    );
  }
  return relayError(
    "MANAGED_PROVIDER_ERROR",
    "The provider answered with an error",
    502,
    { providerStatusClass: `${String(Math.floor(result.status / 100))}xx` },
  );
};

const readCappedBody = async (
  request: Request,
): Promise<Uint8Array<ArrayBuffer> | null> => {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MANAGED_RELAY_MAX_BODY_BYTES) {
    await request.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!request.body) {
    return null;
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > MANAGED_RELAY_MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  return total === 0 ? null : Buffer.concat(chunks);
};

/** Step 1: everything that is refused without touching the database. */
const readRelayRequest = async ({
  launchConnectionId,
  request,
}: RelayManagedMcpCallInput): Promise<RelayRequest> => {
  if (request.method !== "POST" && request.method !== "DELETE") {
    throw relayError(
      "METHOD_NOT_ALLOWED",
      "The relay accepts only POST and DELETE",
      405,
    );
  }
  if (request.url.includes("?")) {
    throw relayError(
      "MANAGED_RELAY_QUERY_NOT_ALLOWED",
      "The relay URL takes no query string",
      400,
    );
  }
  if (request.headers.has("origin")) {
    throw relayError(
      "MANAGED_RELAY_ORIGIN_NOT_ALLOWED",
      "The relay doesn't accept browser requests",
      400,
    );
  }
  const body = await readCappedBody(request);
  const capability = request.headers
    .get("authorization")
    ?.match(/^Bearer ([\w-]+)$/u)?.[1];
  if (!capability || !isUuidV7(launchConnectionId)) {
    throw unauthorized();
  }
  return {
    method: request.method,
    launchConnectionId,
    capability,
    sessionId: request.headers.get("mcp-session-id"),
    headers: request.headers,
    body,
    signal: request.signal,
  };
};

const sameDigest = (a: Buffer, b: Buffer): boolean =>
  a.length === b.length && timingSafeEqual(a, b);

/** The run is `running` under the claim that registered the launch, with a live lease. */
const holdsLaunchClaim = (
  run: TaskRunEntity | null,
  launch: ManagedLaunchConnectionEntity,
  now: Date,
): boolean =>
  run?.status === "running" &&
  run.claimToken !== null &&
  sameDigest(launchClaimTokenDigest(run.claimToken), launch.claimTokenDigest) &&
  run.leaseExpiresAt instanceof Date &&
  run.leaseExpiresAt.getTime() > now.getTime();

/**
 * Step 2, one short transaction: authenticate the capability, require the
 * run and launch live, take the connection `FOR SHARE` and require the
 * pinned authority, check the session binding, and lease an operation.
 */
const admit = (
  request: RelayRequest,
  deps: RelayManagedMcpCallDeps,
): Promise<{
  launch: ManagedLaunchConnectionEntity;
  operation: ManagedOperation;
}> =>
  getDb().transaction(async (tx) => {
    const launch = await deps.managedLaunchRepo.loadByCapabilityDigest(
      relayCapabilityDigest(request.capability),
      tx,
    );
    if (launch?.id !== request.launchConnectionId) {
      throw unauthorized();
    }
    const now = deps.timeProvider.now();
    const run = await deps.taskRunRepo.load(launch.taskRunId, tx);
    if (launch.state !== "open" || !holdsLaunchClaim(run, launch, now)) {
      throw relayError(
        "MANAGED_LAUNCH_NOT_ACTIVE",
        "The run this launch belongs to is no longer running under its claim",
        409,
      );
    }
    const connection = await deps.managedConnectionRepo.loadForShare(
      launch.projectId,
      launch.connectionId,
      tx,
    );
    const reason = connection
      ? launch.authorityLossReason(connection)
      : "disconnected";
    if (reason !== null) {
      throw relayError(
        "MANAGED_CONNECTION_AUTHORITY_LOST",
        "The connection this launch uses was disconnected, replaced or needs reconnecting",
        409,
        { reason },
      );
    }
    if (
      request.sessionId !== null &&
      (launch.mcpSessionIdDigest === null ||
        !sameDigest(
          mcpSessionIdDigest(request.sessionId),
          launch.mcpSessionIdDigest,
        ))
    ) {
      throw relayError(
        "MANAGED_MCP_SESSION_NOT_FOUND",
        "This MCP session doesn't belong to this launch",
        404,
      );
    }
    const operation = createManagedOperation({
      launchConnectionId: launch.id,
      startedAt: now,
      deadlineAt: new Date(
        now.getTime() +
          deps.managedMcpPassthrough.callTimeoutMs +
          MANAGED_OPERATION_DEADLINE_GRACE_MS,
      ),
    });
    if (!(await deps.managedLaunchRepo.insertOperation(operation, tx))) {
      throw relayError(
        "MANAGED_RELAY_TOO_MANY_OPERATIONS",
        "This launch already has as many calls in flight as it may",
        429,
      );
    }
    return { launch, operation };
  });

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Step 3: retries while another caller holds the refresh claim, up to the busy wait. */
const waitingOutRefresh = async (
  acquire: () => Promise<ManagedAccessToken>,
  deps: RelayManagedMcpCallDeps,
): Promise<ManagedAccessToken> => {
  const giveUpAt =
    Date.now() + (deps.refreshBusyWaitMs ?? MANAGED_RELAY_REFRESH_BUSY_WAIT_MS);
  for (;;) {
    try {
      return await acquire();
    } catch (error) {
      const remaining = giveUpAt - Date.now();
      const busy =
        error instanceof CoreError &&
        error.code === "MANAGED_CONNECTION_REFRESH_BUSY";
      if (!busy || remaining <= 0) {
        throw error;
      }
      await sleep(Math.min(REFRESH_BUSY_POLL_MS, remaining));
    }
  }
};

const initializeRequestSchema = z.union([
  z.object({ method: z.literal("initialize") }),
  z
    .array(z.unknown())
    .refine((messages) =>
      messages.some(
        (message) =>
          z.object({ method: z.literal("initialize") }).safeParse(message)
            .success,
      ),
    ),
]);

const isInitializeRequest = (body: Uint8Array | null): boolean => {
  if (!body) {
    return false;
  }
  try {
    return initializeRequestSchema.safeParse(
      JSON.parse(Buffer.from(body).toString("utf8")),
    ).success;
  } catch {
    return false;
  }
};

/** Steps 3 to 5: token, forward (with one refresh and resend on 401), session binding. */
const forwardAdmitted = async (
  request: RelayRequest,
  launch: ManagedLaunchConnectionEntity,
  deps: RelayManagedMcpCallDeps,
): Promise<Extract<ManagedMcpPassthroughResult, { kind: "forwarded" }>> => {
  const target = {
    projectId: launch.projectId,
    connectionId: launch.connectionId,
  };
  const forward = ({ server, accessToken }: ManagedAccessToken) =>
    deps.managedMcpPassthrough.forward({
      server,
      method: request.method,
      headers: request.headers,
      body: request.body,
      accessToken,
      signal: request.signal,
    });

  const token = await waitingOutRefresh(
    () => acquireManagedAccessToken(target, deps),
    deps,
  );
  let result = await forward(token);
  if (result.kind === "rejected" && result.status === 401) {
    const refreshed = await waitingOutRefresh(
      () =>
        forceRefreshManagedAccessToken(
          { ...target, rejectedAccessToken: token.accessToken },
          deps,
        ),
      deps,
    );
    result = await forward(refreshed);
  }
  if (result.kind !== "forwarded") {
    throw providerFailure(result);
  }

  const providerSessionId = result.headers.get("mcp-session-id");
  if (providerSessionId !== null && isInitializeRequest(request.body)) {
    try {
      await deps.managedLaunchRepo.saveSessionBinding(
        launch.bindSession(mcpSessionIdDigest(providerSessionId)),
      );
    } catch (error) {
      await result.body?.cancel().catch(() => undefined);
      throw error;
    }
  }
  return result;
};

/**
 * `POST|DELETE /mcp-relay/:launchConnectionId`: relays one MCP request from
 * a run's agent to the connection's MCP resource with the server-held
 * access token (decisions 11, 14 and 15). A serving grant issued for another
 * resource than the connection's is refused before anything is sent. A
 * request refused by its shape never reaches the database; nothing reaches
 * the provider unless the
 * capability, the run's claim and lease, the launch and the connection's
 * pinned authority all hold and an operation was leased for the call.
 *
 * The capability is matched by its SHA-256 digest through a unique index,
 * which reveals nothing about the capability; the row it names must also be
 * the one in the URL. Either mismatch is the same 401, so a caller learns
 * nothing about which launch IDs exist. A run that isn't running under the
 * launch's claim with a live lease, or a closed launch, is 409
 * `MANAGED_LAUNCH_NOT_ACTIVE`; a connection that moved is 409
 * `MANAGED_CONNECTION_AUTHORITY_LOST` with the launch's loss reason.
 *
 * A 2xx body is streamed back unchanged (decision 8). Any other answer
 * becomes a fixed error with no provider body or header; a 401 first gets
 * one forced refresh and one resend of the buffered body. An open stream
 * isn't re-checked against authority: new calls are refused at admission
 * and the seal fence fails the run. The operation is deleted once the
 * stream ends, fails or is cancelled, through `runAfterResponse`; the
 * caller's abort (`request.signal`) ends the upstream request too.
 */
export const relayManagedMcpCall = async (
  input: RelayManagedMcpCallInput,
  deps: RelayManagedMcpCallDeps,
): Promise<Response> => {
  const request = await readRelayRequest(input);
  const { launch, operation } = await admit(request, deps);
  const releaseOperation = () =>
    deps.managedLaunchRepo.deleteOperation(operation.id);

  let result: Awaited<ReturnType<typeof forwardAdmitted>>;
  try {
    result = await forwardAdmitted(request, launch, deps);
  } catch (error) {
    await releaseOperation();
    throw error;
  }
  deps.runAfterResponse(result.closed.then(releaseOperation));
  return new Response(result.body, {
    status: result.status,
    headers: result.headers,
  });
};
