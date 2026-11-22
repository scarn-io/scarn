import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { StepDefinitionContract } from "@scarn/api/frontend-contracts";
import {
  makeStep,
  projectId,
  setupDom,
  editTextInput,
  type SavedStepBody,
} from "./step-definition-dialog-test-helpers";

// Rendering MUI under jsdom is CPU-heavy; under a loaded machine
// (test-all-workspaces) a single test can overrun bun's 5s default.
// ─── API client mock ──────────────────────────────────────────────────────────

let mockPutResult: { data: unknown; error: unknown } = {
  data: null,
  error: null,
};
let mockPostResult: { data: unknown; error: unknown } = {
  data: null,
  error: null,
};

const putMock = mock((body: SavedStepBody) => {
  void body;
  return Promise.resolve(mockPutResult);
});
const postMock = mock((body: SavedStepBody) => {
  void body;
  return Promise.resolve(mockPostResult);
});

function firstCallBody(fn: typeof putMock): SavedStepBody {
  const call = fn.mock.calls[0];
  if (!call) throw new Error("Expected the mock to have been called");
  return call[0];
}

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      "step-definitions": {
        put: putMock,
        post: postMock,
      },
    },
  }),
}));

const { StepDefinitionDialog } = await import("./step-definition-dialog");

async function saveEdit(
  step: StepDefinitionContract,
  switchFrom?: string,
  switchTo?: RegExp,
  environmentName?: string,
): Promise<SavedStepBody> {
  mockPutResult = { data: step, error: null };
  const view = render(
    <StepDefinitionDialog
      open
      projectId={projectId}
      step={step}
      onSaved={() => {}}
      onClose={() => {}}
    />,
  );

  if (switchFrom && switchTo) {
    const select = Array.from(
      view.baseElement.querySelectorAll('[role="combobox"]'),
    ).find((element) => element.textContent === switchFrom);
    if (!select) throw new Error("Expected the runtime select");
    fireEvent.mouseDown(select);
    const option = await waitFor(() => {
      const found = Array.from(
        view.baseElement.querySelectorAll('[role="option"]'),
      ).find((element) => switchTo.test(element.textContent));
      if (!found) throw new Error("Expected the runtime option");
      return found;
    });
    fireEvent.click(option);
  }

  if (environmentName !== undefined) {
    const input = view.getByLabelText(/Environment name/) as HTMLInputElement;
    editTextInput(input, environmentName);
  }
  const form = view.baseElement.querySelector("form");
  if (!form) throw new Error("Expected a form element");
  fireEvent.submit(form);
  await waitFor(() => {
    expect(putMock).toHaveBeenCalledTimes(1);
  });
  return firstCallBody(putMock);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("StepDefinitionDialog", () => {
  beforeEach(() => {
    setupDom();
    putMock.mockClear();
    postMock.mockClear();
    mockPutResult = { data: null, error: null };
    mockPostResult = { data: null, error: null };
  });

  afterEach(() => {
    cleanup();
  });

  // Note: this dialog has no visual health-check editor (out of scope per
  // #117), so these tests exercise the save path without ever touching a
  // health-check-specific control — the point is that saving *any* edit,
  // through fields unrelated to health checks, must not drop them.

  test("saving an edit preserves the step's existing healthChecksJson in the PUT body", async () => {
    const step = makeStep();
    const body = await saveEdit(step);
    expect(body.healthChecksJson).toEqual(step.healthChecksJson);
  });

  test("saving a step with no healthChecksJson keeps it null rather than fabricating a value", async () => {
    const body = await saveEdit(makeStep({ healthChecksJson: null }));
    expect(body.healthChecksJson).toBeNull();
  });

  test("saving an edit preserves the step's existing envJson in the PUT body", async () => {
    const step = makeStep({
      environment: {
        kind: "inline",
        envJson: [
          {
            name: "ACCOUNT_ID",
            source: "value",
            value: "{{input.accountId}}",
            secret: false,
            applies: "agent",
          },
          {
            name: "WAREHOUSE_TOKEN",
            source: "inherit",
            from: "WAREHOUSE_TOKEN",
            secret: true,
            optional: false,
            applies: "setup",
          },
        ],
      },
    });
    const body = await saveEdit(step);
    expect(body.environment).toEqual(step.environment);
  });

  test("saving a step with no envJson keeps it null rather than fabricating a value", async () => {
    const body = await saveEdit(
      makeStep({ environment: { kind: "inline", envJson: null } }),
    );
    expect(body.environment).toEqual({ kind: "inline", envJson: null });
  });

  test("saving an edit preserves the step's existing devcontainerConfigPath in the PUT body", async () => {
    const step = makeStep({
      environment: {
        kind: "inline",
        runtime: {
          kind: "devcontainer",
          config: ".devcontainer/alt/devcontainer.json",
        },
      },
    });
    const body = await saveEdit(step);
    expect(body.environment).toEqual(step.environment);
    expect(body).not.toHaveProperty("executionMode");
  });

  test("saving a step with no environment keeps it null rather than fabricating a value", async () => {
    const body = await saveEdit(makeStep({ environment: null }));
    expect(body.environment).toBeNull();
  });

  test("switching to host clears devcontainerConfigPath in the PUT body", async () => {
    const step = makeStep({
      environment: {
        kind: "inline",
        runtime: {
          kind: "devcontainer",
          config: ".devcontainer/alt/devcontainer.json",
        },
      },
    });
    const body = await saveEdit(step, "Devcontainer", /^host$/i);
    expect(body.environment).toEqual({
      kind: "inline",
      runtime: { kind: "host" },
    });
  });

  test("saving an edit preserves the step's managedRuntime in the PUT body", async () => {
    const step = makeStep({
      environment: { kind: "inline", runtime: { kind: "managed", id: "bun1" } },
    });
    const body = await saveEdit(step);
    expect(body.environment).toEqual(step.environment);
  });

  test("saving an empty inline environment does not fabricate a managed runtime", async () => {
    const step = makeStep({ environment: { kind: "inline" } });
    const body = await saveEdit(step);
    expect(body.environment).toEqual({ kind: "inline" });
  });

  test("switching to host clears managedRuntime in the PUT body", async () => {
    const step = makeStep({
      environment: {
        kind: "inline",
        runtime: { kind: "managed", id: "node24" },
      },
    });
    const body = await saveEdit(step, "Managed container", /^host$/i);
    expect(body.environment).toEqual({
      kind: "inline",
      runtime: { kind: "host" },
    });
  });

  const customRepo = {
    mode: "readWrite",
    message: "fix: {{result.summary}}",
    onPushFailure: "warn",
    gitCredentials: "auto",
    baseBranch: "release/{{input.version}}",
    workBranch: { kind: "base" },
  } as const;
  const readOnlyRepo = {
    mode: "readOnly",
    gitCredentials: "none",
    baseBranch: "develop",
  } as const;

  test("saving an edit preserves the step's custom repo in the PUT body", async () => {
    const step = makeStep({ repo: customRepo });
    const body = await saveEdit(step);
    expect(body.repo).toEqual(customRepo);
  });

  test("a host step keeps its read-only repo in the PUT body", async () => {
    const step = makeStep({
      environment: { kind: "inline", runtime: { kind: "host" } },
      repo: readOnlyRepo,
    });
    const body = await saveEdit(step);
    expect(body.repo).toEqual(readOnlyRepo);
  });

  test("switching to host preserves the custom read-write repo policy", async () => {
    const step = makeStep({ repo: customRepo });
    const body = await saveEdit(step, "Repository default", /^host$/i);
    expect(body.environment).toEqual({
      kind: "inline",
      runtime: { kind: "host" },
    });
    expect(body.repo).toEqual(customRepo);
  });

  test("switching from host to devcontainer preserves the read-only repo policy", async () => {
    const step = makeStep({
      environment: { kind: "inline", runtime: { kind: "host" } },
      repo: readOnlyRepo,
    });
    const body = await saveEdit(step, "Host", /^devcontainer$/i);
    expect(body.environment).toEqual({
      kind: "inline",
      runtime: { kind: "devcontainer" },
    });
    expect(body.repo).toEqual(readOnlyRepo);
  });

  test("saving explicit pathless devcontainer keeps it distinct from repository default", async () => {
    const body = await saveEdit(
      makeStep({
        environment: { kind: "inline", runtime: { kind: "devcontainer" } },
      }),
    );
    expect(body.environment).toEqual({
      kind: "inline",
      runtime: { kind: "devcontainer" },
    });
  });

  test("switching to repository default clears runtime details without changing repo policy", async () => {
    const body = await saveEdit(
      makeStep({
        environment: {
          kind: "inline",
          runtime: { kind: "managed", id: "node24" },
        },
        repo: customRepo,
      }),
      "Managed container",
      /^repository default$/i,
    );
    expect(body.environment).toBeNull();
    expect(body.repo).toEqual(customRepo);
  });

  test("switching to managed picks a runtime and preserves the read-only repo policy", async () => {
    const body = await saveEdit(
      makeStep({ repo: readOnlyRepo }),
      "Repository default",
      /^managed container$/i,
    );
    expect(body.environment).toEqual({
      kind: "inline",
      runtime: { kind: "managed", id: "bun1" },
    });
    expect(body.repo).toEqual(readOnlyRepo);
  });

  test("runtime edits preserve variables", async () => {
    const envJson = [
      {
        name: "MODE",
        source: "value" as const,
        value: "test",
        secret: false,
        applies: "agent" as const,
      },
    ];
    const body = await saveEdit(
      makeStep({ environment: { kind: "inline", envJson } }),
      "Repository default",
      /^managed container$/i,
    );
    expect(body.environment).toEqual({
      kind: "inline",
      envJson,
      runtime: { kind: "managed", id: "bun1" },
    });
    expect(body).not.toHaveProperty("runtimeKind");
    expect(body).not.toHaveProperty("envJson");
  });

  test("repository-default runtime keeps inline variables", async () => {
    const environment = {
      kind: "inline" as const,
      envJson: [],
      runtime: { kind: "managed" as const, id: "bun1" as const },
    };
    const body = await saveEdit(
      makeStep({ environment }),
      "Managed container",
      /^repository default$/i,
    );
    expect(body.environment).toEqual({
      kind: "inline",
      envJson: [],
    });
  });

  test("incidental edits preserve a named environment reference", async () => {
    const environment = { kind: "named" as const, name: "shared" };
    const body = await saveEdit(makeStep({ environment }));
    expect(body.environment).toEqual(environment);
  });

  test("switching from named to repository default clears the reference", async () => {
    const body = await saveEdit(
      makeStep({ environment: { kind: "named", name: "shared" } }),
      "Named environment",
      /^repository default$/i,
    );
    expect(body.environment).toBeNull();
  });

  test("editing the free-text environment name saves the new reference", async () => {
    const body = await saveEdit(
      makeStep({ environment: { kind: "named", name: "shared" } }),
      undefined,
      undefined,
      "shared-build",
    );
    expect(body.environment).toEqual({ kind: "named", name: "shared-build" });
  });

  test("switching from inline to named clears inline fields and preserves MCP", async () => {
    const step = makeStep({
      environment: {
        kind: "inline",
        envJson: [],
        runtime: { kind: "devcontainer", config: ".devcontainer/alt.json" },
      },
      opencodeMcpJson: {
        browser: { type: "local", command: ["browser-mcp"] },
      },
    });
    const body = await saveEdit(
      step,
      "Devcontainer",
      /^named environment$/i,
      "shared-build",
    );
    expect(body.environment).toEqual({ kind: "named", name: "shared-build" });
    expect(body).toHaveProperty("opencodeMcpJson", step.opencodeMcpJson);
  });

  test("switching from named to inline starts with the selected runtime", async () => {
    const body = await saveEdit(
      makeStep({ environment: { kind: "named", name: "shared" } }),
      "Named environment",
      /^managed container$/i,
    );
    expect(body.environment).toEqual({
      kind: "inline",
      runtime: { kind: "managed", id: "bun1" },
    });
  });
});
