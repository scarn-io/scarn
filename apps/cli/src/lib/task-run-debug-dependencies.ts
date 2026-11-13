import { open, rm } from "node:fs/promises";
import type { FullLogSaver, TaskRunDebugClient } from "@scarn/shared-core";
import { resolveScarnBaseUrl } from "@scarn/worker";
import { connectApi, type AuthenticatedApi } from "./cli-api-client";
import { createFullLogSaver } from "./task-log-cache";

/**
 * How `scarn logs` and `scarn artifacts` reach the API, the task-log cache,
 * the clock and the disk; tests pass fakes.
 */
export interface TaskRunDebugDependencies {
  connect(args: { baseUrl: string | undefined }): Promise<{
    client: TaskRunDebugClient;
    headers: { Authorization: string };
  }>;
  saveFullLog: FullLogSaver;
  sleep(ms: number): Promise<void>;
  /** Streams `url`'s body to a new file at `outPath`; fails if it exists. */
  download(url: string, outPath: string): Promise<{ bytes: number }>;
}

/**
 * The generated `ScarnClient` types every nullable field as `unknown`, so it
 * matches {@link TaskRunDebugClient} at runtime but not structurally; this is
 * the one place it is asserted.
 */
const asDebugClient = (client: AuthenticatedApi["client"]) =>
  client as unknown as TaskRunDebugClient;

/** Fetches `url` and streams it to `outPath`, refusing to overwrite. */
export async function downloadToNewFile(
  url: string,
  outPath: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ bytes: number }> {
  const response = await fetchFn(url);
  if (!response.ok || response.body === null) {
    throw new Error(`Download failed (HTTP ${String(response.status)}).`);
  }
  const file = await open(outPath, "wx");
  const reader = response.body.getReader();
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await file.write(value);
      bytes += value.byteLength;
    }
  } catch (error) {
    await file.close();
    await rm(outPath, { force: true });
    throw error;
  }
  await file.close();
  return { bytes };
}

export const realTaskRunDebugDependencies: TaskRunDebugDependencies = {
  async connect(args) {
    const api = await connectApi(resolveScarnBaseUrl(args.baseUrl));
    return { client: asDebugClient(api.client), headers: api.headers };
  },
  saveFullLog: createFullLogSaver(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  download: (url, outPath) => downloadToNewFile(url, outPath),
};
