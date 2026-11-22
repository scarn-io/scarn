import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  parseUuidV7,
  PROJECT_ROLES,
  type ProjectMemberContract,
} from "@scarn/api/frontend-contracts";
import { installDom } from "@/tests/support/install-dom";

/**
 * DOM globals go in before React DOM loads: it decides at import time whether
 * `input` events work.
 */
installDom();

type ApiResult = { data: unknown; error: unknown };

const PROJECT_ID = "01966a2c-9494-7db5-aa46-0f8f5cbbe000";
const OWNER_ID = parseUuidV7("0198f2c4-0000-7000-8000-0000000000aa");
const MEMBER_ID = parseUuidV7("0198f2c4-0000-7000-8000-0000000000bb");

const apiState = {
  roleResult: { data: null, error: null } as ApiResult,
  roleCalls: [] as { userId: string; body: { role: string } }[],
};

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      projects: () => ({
        members: ({ userId }: { userId: string }) => ({
          role: {
            put: (body: { role: string }) => {
              apiState.roleCalls.push({ userId, body });
              return Promise.resolve(apiState.roleResult);
            },
          },
        }),
      }),
    },
  }),
}));

const { cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { ProjectCollaboratorsPanel } =
  await import("./project-collaborators-panel");
const { ProjectRouteProvider } =
  await import("@/components/project-route-context");

const permissionsOf = (role: string) => [
  ...(PROJECT_ROLES.find((definition) => definition.name === role)
    ?.permissions ?? []),
];

const buildMember = (
  userId: ProjectMemberContract["userId"],
  username: string,
  role: string,
): ProjectMemberContract => ({
  userId,
  username,
  image: null,
  role,
  permissions: permissionsOf(role),
});

const renderPanel = (viewerPermissions: string[]) =>
  render(
    <ProjectRouteProvider
      username="tester"
      projectSlug="demo"
      projectId={PROJECT_ID}
      isMember
      permissions={viewerPermissions}
    >
      <ProjectCollaboratorsPanel
        projectId={PROJECT_ID}
        initialMembers={[
          buildMember(OWNER_ID, "ada", "admin"),
          buildMember(MEMBER_ID, "grace", "read"),
        ]}
        initialInvites={[]}
      />
    </ProjectRouteProvider>,
  );

describe("ProjectCollaboratorsPanel", () => {
  beforeEach(() => {
    apiState.roleCalls = [];
    apiState.roleResult = { data: null, error: null };
  });

  afterEach(() => {
    cleanup();
  });

  test("shows each member with their role", () => {
    const view = renderPanel(permissionsOf("admin"));

    expect(view.getByText("ada")).toBeTruthy();
    expect(view.getByText("grace")).toBeTruthy();
    expect(
      view.getByRole("combobox", { name: "Role for ada" }).textContent,
    ).toBe("Admin");
    expect(
      view.getByRole("combobox", { name: "Role for grace" }).textContent,
    ).toBe("Read");
  });

  test("changes a member's role through the role endpoint", async () => {
    apiState.roleResult = {
      data: {
        userId: MEMBER_ID,
        role: "write",
        permissions: permissionsOf("write"),
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
      },
      error: null,
    };
    const view = renderPanel(permissionsOf("admin"));

    fireEvent.mouseDown(view.getByRole("combobox", { name: "Role for grace" }));
    const options = Array.from(document.querySelectorAll('[role="option"]'));
    expect(
      options.map((option) => [
        option.querySelector(".MuiListItemText-primary")?.textContent,
        option.querySelector(".MuiListItemText-secondary")?.textContent,
      ]),
    ).toEqual(PROJECT_ROLES.map((role) => [role.label, role.description]));
    const writeOption = options.find(
      (option) =>
        option.querySelector(".MuiListItemText-primary")?.textContent ===
        "Write",
    );
    fireEvent.click(writeOption as Element);

    await waitFor(() => {
      expect(
        view.getByRole("combobox", { name: "Role for grace" }).textContent,
      ).toBe("Write");
    });
    expect(apiState.roleCalls).toEqual([
      { userId: MEMBER_ID, body: { role: "write" } },
    ]);
  });

  test("shows the API error when the role change is refused", async () => {
    apiState.roleResult = {
      data: null,
      error: {
        status: 409,
        value: {
          status: 409,
          code: "PROJECT_LAST_ADMIN",
          detail: "A project needs at least one admin.",
        },
      },
    };
    const view = renderPanel(permissionsOf("admin"));

    fireEvent.mouseDown(view.getByRole("combobox", { name: "Role for ada" }));
    const readOption = Array.from(
      document.querySelectorAll('[role="option"]'),
    ).find(
      (option) =>
        option.querySelector(".MuiListItemText-primary")?.textContent ===
        "Read",
    );
    fireEvent.click(readOption as Element);

    await waitFor(() => {
      expect(view.getByRole("alert").textContent).toContain(
        "at least one admin",
      );
    });
    expect(
      view.getByRole("combobox", { name: "Role for ada" }).textContent,
    ).toBe("Admin");
  });

  test("hides member management without members:write", () => {
    const view = renderPanel(permissionsOf("write"));

    expect(view.queryByRole("combobox")).toBeNull();
    expect(view.getByText(/only project admins/i)).toBeTruthy();
  });
});
