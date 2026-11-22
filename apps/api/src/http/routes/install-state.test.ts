import { describe, expect, test, beforeAll } from "bun:test";

beforeAll(() => {
  process.env["BETTER_AUTH_SECRET"] = "test-secret-for-install-state";
});

const importHelpers = async () => {
  return await import("./install-state");
};

describe("install state", () => {
  test("signs and verifies a round-trip for intent 'link'", async () => {
    const { signInstallState, verifyInstallState } = await importHelpers();
    const projectId = "01968a47-3c4d-7e8f-9a0b-1c2d3e4f5061";

    const state = signInstallState({ intent: "link", projectId });
    const claims = verifyInstallState(state);

    expect(claims.intent).toBe("link");
    expect(claims.projectId).toBe(projectId);
    expect(typeof claims.iat).toBe("number");
  });

  test("signs and verifies a round-trip for intent 'create' (no projectId)", async () => {
    const { signInstallState, verifyInstallState } = await importHelpers();

    const state = signInstallState({ intent: "create" });
    const claims = verifyInstallState(state);

    expect(claims.intent).toBe("create");
    expect(claims.projectId).toBeUndefined();
    expect(typeof claims.iat).toBe("number");
  });

  test("rejects a tampered payload", async () => {
    const { signInstallState, verifyInstallState, InstallStateError } =
      await importHelpers();
    const state = signInstallState({
      intent: "link",
      projectId: "01968a47-3c4d-7e8f-9a0b-1c2d3e4f5061",
    });
    const [payload, signature] = state.split(".");
    const forged = Buffer.from(
      JSON.stringify({
        intent: "link",
        projectId: "01968a47-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        iat: Date.now(),
      }),
    ).toString("base64url");
    const tampered = `${forged}.${signature ?? ""}`;
    void payload;

    expect(() => verifyInstallState(tampered)).toThrow(InstallStateError);
  });

  test("rejects a malformed state", async () => {
    const { verifyInstallState, InstallStateError } = await importHelpers();
    expect(() => verifyInstallState("not-a-real-state")).toThrow(
      InstallStateError,
    );
  });

  test("rejects an expired state (intent 'link')", async () => {
    const { signInstallState, verifyInstallState, InstallStateError } =
      await importHelpers();
    const state = signInstallState({
      intent: "link",
      projectId: "01968a47-3c4d-7e8f-9a0b-1c2d3e4f5061",
    });

    expect(() =>
      verifyInstallState(state, Date.now() + 16 * 60 * 1000),
    ).toThrow(InstallStateError);
  });

  test("rejects an expired state (intent 'create')", async () => {
    const { signInstallState, verifyInstallState, InstallStateError } =
      await importHelpers();
    const state = signInstallState({ intent: "create" });

    expect(() =>
      verifyInstallState(state, Date.now() + 16 * 60 * 1000),
    ).toThrow(InstallStateError);
  });

  test("rejects an unknown intent", async () => {
    const { verifyInstallState, InstallStateError } = await importHelpers();
    // Build a state by hand since signInstallState only accepts known intents.
    const payload = Buffer.from(
      JSON.stringify({ intent: "delete", iat: Date.now() }),
    ).toString("base64url");
    const secret = process.env["BETTER_AUTH_SECRET"] ?? "";
    const { createHmac } = await import("node:crypto");
    const signature = createHmac("sha256", secret)
      .update(payload)
      .digest("base64url");

    expect(() => verifyInstallState(`${payload}.${signature}`)).toThrow(
      InstallStateError,
    );
  });

  test("rejects intent 'link' without a projectId", async () => {
    const { verifyInstallState, InstallStateError } = await importHelpers();
    const payload = Buffer.from(
      JSON.stringify({ intent: "link", iat: Date.now() }),
    ).toString("base64url");
    const secret = process.env["BETTER_AUTH_SECRET"] ?? "";
    const { createHmac } = await import("node:crypto");
    const signature = createHmac("sha256", secret)
      .update(payload)
      .digest("base64url");

    expect(() => verifyInstallState(`${payload}.${signature}`)).toThrow(
      InstallStateError,
    );
  });

  test("rejects intent 'create' with an unexpected projectId", async () => {
    const { verifyInstallState, InstallStateError } = await importHelpers();
    const payload = Buffer.from(
      JSON.stringify({
        intent: "create",
        projectId: "01968a47-3c4d-7e8f-9a0b-1c2d3e4f5061",
        iat: Date.now(),
      }),
    ).toString("base64url");
    const secret = process.env["BETTER_AUTH_SECRET"] ?? "";
    const { createHmac } = await import("node:crypto");
    const signature = createHmac("sha256", secret)
      .update(payload)
      .digest("base64url");

    expect(() => verifyInstallState(`${payload}.${signature}`)).toThrow(
      InstallStateError,
    );
  });

  test("round-trips a same-origin returnTo for intent 'create'", async () => {
    const { signInstallState, verifyInstallState } = await importHelpers();
    const returnTo =
      "/projects/new?gitUrl=git%40github.com%3Aacme%2Frepo.git&source=cli";

    const claims = verifyInstallState(
      signInstallState({ intent: "create", returnTo }),
    );

    expect(claims.intent).toBe("create");
    expect(claims.intent === "create" ? claims.returnTo : undefined).toBe(
      returnTo,
    );
  });

  test("refuses to sign an off-origin returnTo", async () => {
    const { signInstallState, InstallStateError } = await importHelpers();

    for (const returnTo of [
      "https://evil.example/projects/new",
      "//evil.example/projects/new",
      "/\\evil.example/projects/new",
      "projects/new",
      "/projects/new\n",
    ]) {
      expect(() => signInstallState({ intent: "create", returnTo })).toThrow(
        InstallStateError,
      );
    }
  });

  test("rejects a signed state whose returnTo is off-origin", async () => {
    const { verifyInstallState, InstallStateError } = await importHelpers();
    const payload = Buffer.from(
      JSON.stringify({
        intent: "create",
        returnTo: "//evil.example/projects/new",
        iat: Date.now(),
      }),
    ).toString("base64url");
    const secret = process.env["BETTER_AUTH_SECRET"] ?? "";
    const { createHmac } = await import("node:crypto");
    const signature = createHmac("sha256", secret)
      .update(payload)
      .digest("base64url");

    expect(() => verifyInstallState(`${payload}.${signature}`)).toThrow(
      InstallStateError,
    );
  });
});
