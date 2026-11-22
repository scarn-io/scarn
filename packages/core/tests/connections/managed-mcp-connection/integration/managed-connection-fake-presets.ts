import { DrizzleAuthSessionRepo } from "@scarn/identity";
import { parseUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import type {
  ManagedConnectionPreset,
  ManagedConnectionPresets,
} from "@/connections/managed-mcp-connection/application/managed-connection-preset";
import { startManagedConnection } from "@/connections/managed-mcp-connection/application/start-managed-connection";
import type { ManagedConnectionDefinition } from "@/connections/managed-mcp-connection/domain/managed-connection-server";
import { MANAGED_CONNECTION_PRESETS } from "@/connections/managed-mcp-connection/infra/managed-connection-presets";
import type { AppContext } from "@/lib/di";
import type { ProjectSecretsTestUser } from "tests/secrets/secret/integration/project-secret-test-support";

/** The harness catalog's extra preset, pointing at the loopback fake. */
export const FAKE_PRESET_KEY = "fake-docs";

type FakeServer = { resource: string; origin: string };

/**
 * The core catalog plus {@link FAKE_PRESET_KEY}: the fake with Notion's
 * identity parser and `iss` rule, and no removal URL. Each catalog preset
 * named in `presetFakes` keeps its behaviour but points at that fake.
 */
export const presetsWithFake = (
  fake: FakeServer,
  presetFakes: Readonly<Record<string, FakeServer>> = {},
): ManagedConnectionPresets => {
  const fakePreset: ManagedConnectionPreset = {
    label: "Fake Docs",
    resource: fake.resource,
    issuerOrigin: fake.origin,
    clientRegistration: "cimd",
    parseIdentity: MANAGED_CONNECTION_PRESETS.notion.parseIdentity,
    requireIssParameter: true,
    revokeReplacedGrants: false,
  };
  const catalog = [
    ...Object.entries(MANAGED_CONNECTION_PRESETS).map(([key, preset]) => {
      const pointed = presetFakes[key];
      return {
        key,
        preset: pointed
          ? {
              ...preset,
              resource: pointed.resource,
              issuerOrigin: pointed.origin,
            }
          : preset,
      };
    }),
    { key: FAKE_PRESET_KEY, preset: fakePreset },
  ];
  return {
    get: (key) => catalog.find((entry) => entry.key === key)?.preset ?? null,
    list: () => catalog,
  };
};

/**
 * Starts a connect from `definition` as `user`'s browser session. The route
 * only creates connections from presets, so connections without one start
 * through the use case.
 */
export const startConnectionFromDefinition = async (
  appContext: AppContext,
  user: ProjectSecretsTestUser,
  projectId: UuidV7,
  definition: ManagedConnectionDefinition,
) => {
  const session = await new DrizzleAuthSessionRepo().loadByToken(
    user.sessionToken,
  );
  if (!session) {
    throw new Error("expected the user's session");
  }
  return await startManagedConnection(
    {
      projectId,
      definition,
      binding: { kind: "browser", sessionId: session.id },
    },
    {
      ...appContext,
      userAuthz: appContext.createUserAuthorizationService(
        parseUuidV7(user.userId),
      ),
    },
  );
};
