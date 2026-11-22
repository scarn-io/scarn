import { describe, expect } from "bun:test";
import { parseNotionIdentity } from "@/connections/managed-mcp-connection/infra/notion-identity";
import { concurrentTest } from "tests/utils";

const NO_IDENTITY = {
  userId: null,
  userName: null,
  workspaceId: null,
  workspaceName: null,
};

describe("parseNotionIdentity", () => {
  concurrentTest("reads the user and workspace", () => {
    expect(
      parseNotionIdentity({
        access_token: "token",
        workspace_id: "ws-1",
        workspace_name: "Workspace",
        owner: { type: "user", user: { id: "user-1", name: "User" } },
      }),
    ).toEqual({
      userId: "user-1",
      userName: "User",
      workspaceId: "ws-1",
      workspaceName: "Workspace",
    });
  });

  concurrentTest("leaves fields Notion didn't send null", () => {
    expect(parseNotionIdentity({ workspace_id: "ws-1" })).toEqual({
      ...NO_IDENTITY,
      workspaceId: "ws-1",
    });
    expect(
      parseNotionIdentity({
        owner: { user: { id: "user-1" } },
        workspace_name: null,
      }),
    ).toEqual({ ...NO_IDENTITY, userId: "user-1" });
  });

  concurrentTest("treats blank values as missing", () => {
    expect(
      parseNotionIdentity({
        workspace_id: "  ",
        workspace_name: "",
        owner: { user: { id: "", name: " " } },
      }),
    ).toEqual(NO_IDENTITY);
  });

  concurrentTest("returns all nulls when there is no identity", () => {
    expect(parseNotionIdentity({})).toEqual(NO_IDENTITY);
    expect(parseNotionIdentity({ owner: null })).toEqual(NO_IDENTITY);
  });

  concurrentTest("returns null for malformed identity fields", () => {
    expect(parseNotionIdentity({ owner: { user: { id: 1 } } })).toBeNull();
    expect(parseNotionIdentity({ workspace_id: ["ws-1"] })).toBeNull();
    expect(parseNotionIdentity("token")).toBeNull();
    expect(parseNotionIdentity(null)).toBeNull();
  });
});
