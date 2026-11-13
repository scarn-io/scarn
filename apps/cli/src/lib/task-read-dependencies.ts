import type { TaskReadClient } from "@scarn/shared-core";
import { resolveScarnBaseUrl } from "@scarn/worker";
import { connectApi, type AuthenticatedApi } from "./cli-api-client";
import { connectProject, type ProjectArguments } from "./connect-project";
import { PROJECT_ACTIONS } from "./resolve-project-ref";
import {
  createWorkItemRefPorts,
  resolveWorkItemRef,
  type ResolvedWorkItemRef,
} from "./resolve-work-item-ref";

/**
 * How `scarn tasks` and `scarn task-runs` reach the API; tests pass fakes.
 */

type ReadConnection = {
  client: TaskReadClient;
  headers: { Authorization: string };
};

export interface TaskReadDependencies {
  connect(args: { baseUrl: string | undefined }): Promise<ReadConnection>;
  connectProject(
    args: ProjectArguments,
  ): Promise<ReadConnection & { projectId: string }>;
  resolveRef(ref: string, args: ProjectArguments): Promise<ResolvedWorkItemRef>;
}

/**
 * The generated `ScarnClient` types every nullable field as `unknown`, so it
 * matches {@link TaskReadClient} at runtime but not structurally; this is
 * the one place it is asserted.
 */
const asReadClient = (client: AuthenticatedApi["client"]) =>
  client as unknown as TaskReadClient;

export const realTaskReadDependencies: TaskReadDependencies = {
  async connect(args) {
    const api = await connectApi(resolveScarnBaseUrl(args.baseUrl));
    return { client: asReadClient(api.client), headers: api.headers };
  },
  async connectProject(args) {
    const api = await connectProject(args, PROJECT_ACTIONS.inspect);
    return {
      client: asReadClient(api.client),
      headers: api.headers,
      projectId: api.projectId,
    };
  },
  resolveRef: (ref, args) =>
    resolveWorkItemRef(ref, createWorkItemRefPorts(args)),
};
