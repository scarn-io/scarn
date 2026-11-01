import { describe, expect, test } from "bun:test";
import type { Plugin } from "@opencode/plugin";
import type { Info as ToolInfo } from "@opencode/plugin/promise/tool";
import ScarnOpencodePlugin from "./plugin";
import {
  SCARN_LIST_TOOLS_METHOD,
  SCARN_RPC_ID,
  type ScarnListToolsOutput,
} from "./scarn-rpc";
import { SCARN_END_CONVERSATION_TOOL } from "./tools/scarn-end-conversation";
import { SCARN_SUBMIT_ARTIFACT_TOOL } from "./tools/scarn-submit-artifact";
import { SCARN_SUBMIT_STEP_FINDINGS_TOOL } from "./tools/scarn-submit-step-findings";
import { workItemTestWorkspace } from "./tools/_shared/work-item-test-workspace";
import { SCARN_CREATE_WORK_ITEM_TOOL } from "./tools/scarn-create-work-item";
import { SCARN_GET_WORK_ITEM_TOOL } from "./tools/scarn-get-work-item";
import {
  SCARN_BLOCK_WORK_ITEM_TOOL,
  SCARN_CLOSE_WORK_ITEM_TOOL,
  SCARN_COMMENT_ON_WORK_ITEM_TOOL,
  SCARN_SET_WORK_ITEM_DESCRIPTION_TOOL,
  SCARN_START_TASK_TOOL,
} from "./tools/scarn-work-item-change-tools";
import { SCARN_WAIT_FOR_WORK_TOOL } from "./tools/scarn-wait-for-work";

const BASE_TOOLS = [
  "playwright-trace-analyzer",
  SCARN_END_CONVERSATION_TOOL,
  SCARN_SUBMIT_ARTIFACT_TOOL,
  SCARN_SUBMIT_STEP_FINDINGS_TOOL,
];

const SELF_WORK_ITEM_TOOLS = [
  SCARN_BLOCK_WORK_ITEM_TOOL,
  SCARN_CLOSE_WORK_ITEM_TOOL,
  SCARN_COMMENT_ON_WORK_ITEM_TOOL,
  SCARN_GET_WORK_ITEM_TOOL,
  SCARN_SET_WORK_ITEM_DESCRIPTION_TOOL,
  SCARN_START_TASK_TOOL,
  SCARN_WAIT_FOR_WORK_TOOL,
];

async function registeredToolNames(directory: string): Promise<string[]> {
  const { context, added } = createFakeContext(directory);
  await ScarnOpencodePlugin.setup(context);
  return added.map((tool) => tool.name).sort();
}

type RegisteredRpc = {
  definition: { id: string; methods: Record<string, unknown> };
  handlers: Record<string, (input: object) => Promise<ScarnListToolsOutput>>;
};

function createFakeContext(directory: string) {
  const added: ToolInfo[] = [];
  const rpcs: RegisteredRpc[] = [];
  const registration = { dispose: () => Promise.resolve() };

  const context = {
    location: { directory },
    tool: {
      transform: (
        callback: (editor: { add(tool: ToolInfo): void }) => void,
      ) => {
        callback({ add: (tool) => added.push(tool) });
        return Promise.resolve(registration);
      },
      list: () =>
        Promise.resolve(added.map((tool) => ({ ...tool, id: tool.name }))),
    },
    rpc: {
      register: (
        definition: RegisteredRpc["definition"],
        handlers: RegisteredRpc["handlers"],
      ) => {
        rpcs.push({ definition, handlers });
        return Promise.resolve(registration);
      },
    },
  };

  return {
    context: context as unknown as Plugin.Context,
    added,
    rpcs,
  };
}

describe("ScarnOpencodePlugin", () => {
  test("setup registers the Scarn tools outside Code Mode", async () => {
    const { context, added } = createFakeContext("/workspace");

    await ScarnOpencodePlugin.setup(context);

    expect(ScarnOpencodePlugin.id).toBe("scarn");
    expect(added.map((tool) => tool.name).sort()).toEqual(BASE_TOOLS.sort());
    for (const tool of added) {
      expect(tool.options?.codemode).toBe(false);
      expect(tool.input).toMatchObject({ type: "object" });
    }
  });

  test("setup registers the listTools RPC reporting each tool's input schema", async () => {
    const { context, added, rpcs } = createFakeContext("/workspace");

    await ScarnOpencodePlugin.setup(context);

    expect(rpcs).toHaveLength(1);
    const [rpc] = rpcs;
    expect(rpc?.definition.id).toBe(SCARN_RPC_ID);
    const listTools = rpc?.handlers[SCARN_LIST_TOOLS_METHOD];
    expect(listTools).toBeDefined();

    const output = await listTools?.({});
    expect(output?.tools.map((tool) => tool.id).sort()).toEqual(
      added.map((tool) => tool.name).sort(),
    );
    const submit = output?.tools.find(
      (tool) => tool.id === SCARN_SUBMIT_STEP_FINDINGS_TOOL,
    );
    expect(submit?.inputSchema).toMatchObject({
      type: "object",
      required: ["findingsJson"],
    });
  });

  test("setup registers no work item tools for a run not on a work item", async () => {
    const directory = await workItemTestWorkspace({ workItemId: null });

    expect(await registeredToolNames(directory)).toEqual(BASE_TOOLS.sort());
  });

  test("setup registers the self work item tools with the self permission", async () => {
    const directory = await workItemTestWorkspace({
      workItemPermissions: ["self"],
    });

    expect(await registeredToolNames(directory)).toEqual(
      [...BASE_TOOLS, ...SELF_WORK_ITEM_TOOLS].sort(),
    );
  });

  test("setup also registers create-work-item with the children permission", async () => {
    const directory = await workItemTestWorkspace({
      workItemPermissions: ["self", "children"],
    });

    expect(await registeredToolNames(directory)).toEqual(
      [
        ...BASE_TOOLS,
        ...SELF_WORK_ITEM_TOOLS,
        SCARN_CREATE_WORK_ITEM_TOOL,
      ].sort(),
    );
  });
});
