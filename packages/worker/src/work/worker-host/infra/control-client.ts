/**
 * The CLI's typed client for a background worker's control API. It talks to
 * `http://127.0.0.1:<port>` so the `Host` header matches what the server
 * accepts, and sends the bearer token from the discovery file.
 */
import { treaty } from "@elysia/eden";
import type { ControlApp } from "./control-app";
import { CONTROL_SERVER_HOSTNAME } from "./control-server";

export type ControlClient = ReturnType<typeof treaty<ControlApp>>;

export type ControlClientOptions = {
  port: number;
  token: string;
  /** Override `fetch`, e.g. to add a timeout signal. */
  fetcher?: typeof fetch | undefined;
};

export function createControlClient(
  options: ControlClientOptions,
): ControlClient {
  return treaty<ControlApp>(
    `http://${CONTROL_SERVER_HOSTNAME}:${String(options.port)}`,
    {
      parseDate: false,
      headers: { authorization: `Bearer ${options.token}` },
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    },
  );
}
