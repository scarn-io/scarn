import { resolveScarnBaseUrl } from "@scarn/worker";
import { connectApi, describeApiError } from "./cli-api-client";
import { CliError } from "./cli-error";
import {
  WORK_ITEM_PICKER_LIMIT,
  parseWorkItemReference,
} from "./design-work-item";
import { findWorkItemByUrl } from "./design-work-item-adapters";
import { connectProject, type ProjectArguments } from "./connect-project";
import { PROJECT_ACTIONS, type ProjectAction } from "./resolve-project-ref";

/**
 * One way for every command to accept a work item: its UUID, its tracker
 * URL, or its platform key (`owner/repo#123` for GitHub, `PROJ-123` for
 * Jira). A UUID needs no project; a URL or platform key is looked up in the
 * project from `--project` or `.scarn/scarn.jsonc`.
 */

export type WorkItemRef =
  | { kind: "id"; value: string }
  | { kind: "url"; value: string }
  | { kind: "platformKey"; platform: "github" | "jira"; value: string };

export interface ResolvedWorkItemRef {
  workItemId: string;
  projectId: string;
}

const GITHUB_KEY_PATTERN = /^[\w.-]+\/[\w.-]+#\d+$/;
const JIRA_KEY_PATTERN = /^[A-Z][A-Z0-9_]+-\d+$/;

/** What `text` names, or `undefined` when it is none of the accepted forms. */
export function parseWorkItemRef(text: string): WorkItemRef | undefined {
  const reference = parseWorkItemReference(text);
  if (reference !== undefined) return reference;
  const trimmed = text.trim();
  if (GITHUB_KEY_PATTERN.test(trimmed)) {
    return { kind: "platformKey", platform: "github", value: trimmed };
  }
  if (JIRA_KEY_PATTERN.test(trimmed)) {
    return { kind: "platformKey", platform: "jira", value: trimmed };
  }
  return undefined;
}

/** The lookups {@link resolveWorkItemRef} needs; faked in tests. */
export interface WorkItemRefPorts {
  /** The project an id belongs to, or `undefined` on 404. */
  projectIdOfWorkItem(workItemId: string): Promise<string | undefined>;
  /** The project from `--project` or `.scarn/scarn.jsonc`. */
  currentProjectId(): Promise<string>;
  findIdByUrl(projectId: string, url: string): Promise<string | undefined>;
  findIdByPlatformKey(
    projectId: string,
    platform: string,
    platformKey: string,
  ): Promise<string | undefined>;
}

/** Resolves `text` to a work item and its project, or throws a
 * {@link CliError} naming what was wrong. */
export async function resolveWorkItemRef(
  text: string,
  ports: WorkItemRefPorts,
): Promise<ResolvedWorkItemRef> {
  const ref = parseWorkItemRef(text);
  if (ref === undefined) {
    throw new CliError(
      "invalid_usage",
      `"${text}" is not a work item. Pass its id, its tracker URL, or its platform key (e.g. owner/repo#123).`,
    );
  }

  if (ref.kind === "id") {
    const projectId = await ports.projectIdOfWorkItem(ref.value);
    if (projectId === undefined) {
      throw new CliError("no_work_item", `No work item with id ${ref.value}.`);
    }
    return { workItemId: ref.value, projectId };
  }

  const projectId = await ports.currentProjectId();
  const workItemId =
    ref.kind === "url"
      ? await ports.findIdByUrl(projectId, ref.value)
      : await ports.findIdByPlatformKey(projectId, ref.platform, ref.value);
  if (workItemId === undefined) {
    const label = ref.kind === "url" ? "URL" : "key";
    throw new CliError(
      "no_work_item",
      `No work item with ${label} ${ref.value} in this project.`,
    );
  }
  return { workItemId, projectId };
}

/** The real {@link WorkItemRefPorts}, backed by the API. */
export function createWorkItemRefPorts(
  args: ProjectArguments,
  action: ProjectAction = PROJECT_ACTIONS.inspect,
): WorkItemRefPorts {
  let project: ReturnType<typeof connectProject> | undefined;
  const connect = () => (project ??= connectProject(args, action));

  return {
    async projectIdOfWorkItem(workItemId) {
      const { client, headers } = await connectApi(
        resolveScarnBaseUrl(args.baseUrl),
      );
      const { data, error } = await client.workItems.getWorkItem({
        path: { workItemId },
        headers,
      });
      if (error === undefined) return data.projectId;
      if (error.status === 404) return undefined;
      throw new CliError(
        "work_item_lookup_failed",
        `Could not load work item ${workItemId}: ${describeApiError(error)}`,
      );
    },
    async currentProjectId() {
      return (await connect()).projectId;
    },
    async findIdByUrl(projectId, url) {
      const { baseUrl } = await connect();
      return (await findWorkItemByUrl({ baseUrl, projectId, url }))?.id;
    },
    async findIdByPlatformKey(projectId, platform, platformKey) {
      const { client, headers } = await connect();
      const { data, error } = await client.projects.listProjectWorkItems({
        path: { projectId },
        query: {
          page: 1,
          pageSize: WORK_ITEM_PICKER_LIMIT,
          platform,
          q: platformKey,
        },
        headers,
      });
      if (error !== undefined) {
        throw new CliError(
          "work_item_lookup_failed",
          `Could not search work items: ${describeApiError(error)}`,
        );
      }
      return data.items.find((item) => item.platformKey === platformKey)?.id;
    },
  };
}
