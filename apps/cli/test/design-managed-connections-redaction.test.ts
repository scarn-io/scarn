import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createScarnClient } from "@scarn/sdk/client";
import type { AgentToolsManifest } from "@scarn/worker";
import { ensureAgentToolsManifest } from "../src/lib/design-agent-tools";
import { createManagedConnectionsAdapters } from "../src/lib/design-managed-connections-adapters";
import {
  EMPTY_DISCOVERY,
  FAKE_AGENT_TOOLS_MANIFEST_PATH,
  fakeAgentToolsPorts,
} from "./design-agent-tools-fakes";
import { connection, notionServer } from "./design-managed-connections-fakes";
import { createReporterRecorder } from "./utils";

/**
 * Decision 11 for the designer: the manifest carries names, display names
 * and tool metadata only. A fake API seeds token-shaped canaries into every
 * field the preflight must not copy, through the real generated client.
 */

const CANARIES = {
  accessToken: "ntn_canary_access_token_9f3c1a",
  refreshToken: "ntn_canary_refresh_token_77be20",
  fingerprint: "sha256:canary_fingerprint_51d0",
  scope: "canary_scope_secret_e1",
  userId: "canary_user_id_c4b8",
  detail: "canary_problem_detail_Bearer_ntn_aa11",
  header: "canary_header_value_0d9e",
} as const;

const READY_ID = "0190a3f0-0000-7000-8000-000000000001";
const BROKEN_ID = "0190a3f0-0000-7000-8000-000000000002";

function connections(): unknown[] {
  const seeded = {
    connectedBy: { userId: CANARIES.userId, username: "dana" },
    grantedScopes: [CANARIES.scope],
    candidate: {
      id: CANARIES.refreshToken,
      account: { userName: null, workspaceName: null, identityVerified: true },
      grantedScopes: [CANARIES.scope],
      fingerprint: CANARIES.fingerprint,
      expiresAt: "2026-11-19T00:00:00Z",
      sameIdentityAsActive: true,
    },
    accessToken: CANARIES.accessToken,
  };
  return [
    { ...connection({ id: READY_ID }), ...seeded },
    {
      ...connection({ id: BROKEN_ID, state: "ready_with_pending_reconnect" }),
      ...seeded,
    },
  ];
}

function problem(status: number, meta: Record<string, unknown>): Response {
  return Response.json(
    {
      type: "about:blank",
      title: CANARIES.detail,
      status,
      detail: CANARIES.detail,
      meta: { ...meta, accessToken: CANARIES.accessToken },
    },
    {
      status,
      headers: {
        "Content-Type": "application/problem+json",
        "X-Debug": CANARIES.header,
      },
    },
  );
}

describe("managed connection manifest redaction", () => {
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const { pathname } = new URL(request.url);
        if (pathname.endsWith("/mcp-connections")) {
          return Response.json(connections());
        }
        if (pathname.endsWith(`/${READY_ID}/tools`)) {
          return Response.json({
            tools: [
              {
                name: "notion-search",
                description: "Search",
                inputSchema: { type: "object" },
              },
            ],
            listedAt: "2026-11-18T00:00:00Z",
            cached: false,
            accessToken: CANARIES.accessToken,
          });
        }
        if (pathname.endsWith(`/${BROKEN_ID}/tools`)) {
          return problem(502, { providerBody: CANARIES.refreshToken });
        }
        return new Response("not found", { status: 404 });
      },
    });
    baseUrl = `http://localhost:${String(server.port)}`;
  });

  afterAll(async () => {
    await server.stop(true);
  });

  test("no canary from the API reaches the manifest or the reporter", async () => {
    const written: AgentToolsManifest[] = [];
    const recorder = createReporterRecorder();
    await ensureAgentToolsManifest({
      baseUrl,
      projectId: "project-1",
      project: "acme/app",
      owner: "acme",
      slug: "app",
      reporter: recorder.reporter,
      ports: fakeAgentToolsPorts({
        discoverAgentTools: () =>
          Promise.resolve({ ...EMPTY_DISCOVERY, servers: [notionServer()] }),
        ...createManagedConnectionsAdapters((url) =>
          Promise.resolve({
            client: createScarnClient(url),
            fetch: globalThis.fetch,
          }),
        ),
        writeAgentToolsManifest: ({ manifest }) => {
          written.push(manifest);
          return Promise.resolve(FAKE_AGENT_TOOLS_MANIFEST_PATH);
        },
      }),
    });

    const [manifest] = written;
    expect(manifest?.connections?.map((c) => c.availability.status)).toEqual([
      "available",
      "failed",
    ]);
    const text = JSON.stringify({ written, calls: recorder.calls });
    for (const [label, canary] of Object.entries(CANARIES)) {
      expect({ label, leaked: text.includes(canary) }).toEqual({
        label,
        leaked: false,
      });
    }
    expect(text).not.toContain("cli-session");
    expect(text).not.toContain(READY_ID);
  });
});
