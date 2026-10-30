import { OpenCode, type OpenCodeClient } from "@opencode/client";
import {
  basicAuthHeader,
  type OpencodeServerHandle,
} from "../../../runtime/runtime-service/infra/opencode-server-contract";

export type ScarnOpencodeClient = OpenCodeClient;

/**
 * A v2 OpenCode client for one running server, authenticated with its
 * per-session basic-auth password. The directory is not baked in: v2 takes it
 * per call as `location: { directory }` (see {@link opencodeLocation}).
 */
export function createScarnOpencodeClient(
  handle: Pick<OpencodeServerHandle, "baseUrl" | "password">,
): ScarnOpencodeClient {
  return OpenCode.make({
    baseUrl: handle.baseUrl,
    headers: { authorization: basicAuthHeader(handle.password) },
  });
}

/** The v2 `location` argument scoping a call to the handle's workspace. */
export function opencodeLocation(
  handle: Pick<OpencodeServerHandle, "workspaceFolder">,
): { directory: string } {
  return { directory: handle.workspaceFolder };
}
