import { describe, expect } from "bun:test";
import {
  MANAGED_CONNECTION_PRESETS,
  managedConnectionDefinitionFromPreset,
  managedConnectionPresetCatalog,
  managedConnectionPresetFor,
} from "@/connections/managed-mcp-connection/infra/managed-connection-presets";
import { concurrentTest } from "tests/utils";

describe("managedConnectionPresetFor", () => {
  concurrentTest("finds a preset by key", () => {
    expect(managedConnectionPresetFor("notion")).toBe(
      MANAGED_CONNECTION_PRESETS.notion,
    );
  });

  concurrentTest(
    "Cloudflare Observability has no identity parser, removal URL or replaced-grant revocation",
    () => {
      const preset = managedConnectionPresetFor("cloudflare-observability");
      expect(preset?.parseIdentity).toBeUndefined();
      expect(preset?.removalUrl).toBeUndefined();
      expect(preset?.requireIssParameter).toBe(false);
      expect(preset?.revokeReplacedGrants).toBe(false);
    },
  );

  concurrentTest("returns null for an unknown key", () => {
    expect(managedConnectionPresetFor("acme")).toBeNull();
    expect(managedConnectionPresetFor("toString")).toBeNull();
    expect(managedConnectionPresetFor("")).toBeNull();
  });
});

describe("managedConnectionDefinitionFromPreset", () => {
  concurrentTest("names the connection after the preset by default", () => {
    expect(managedConnectionDefinitionFromPreset("notion")).toEqual({
      name: "notion",
      label: "Notion",
      preset: "notion",
      server: {
        resource: "https://mcp.notion.com/mcp",
        issuerOrigin: "https://mcp.notion.com",
        clientRegistration: "cimd",
      },
    });
  });

  concurrentTest("fills in a DCR server for Cloudflare Observability", () => {
    expect(
      managedConnectionDefinitionFromPreset("cloudflare-observability"),
    ).toEqual({
      name: "cloudflare-observability",
      label: "Cloudflare Observability",
      preset: "cloudflare-observability",
      server: {
        resource: "https://observability.mcp.cloudflare.com/mcp",
        issuerOrigin: "https://observability.mcp.cloudflare.com",
        clientRegistration: "dcr",
      },
    });
  });

  concurrentTest(
    "fills in Stripe's root-path resource and separate issuer",
    () => {
      expect(managedConnectionDefinitionFromPreset("stripe").server).toEqual({
        resource: "https://mcp.stripe.com",
        issuerOrigin: "https://access.stripe.com",
        clientRegistration: "dcr",
      });
    },
  );

  concurrentTest("every preset has a valid resource URL", () => {
    for (const key of Object.keys(MANAGED_CONNECTION_PRESETS)) {
      expect(() =>
        managedConnectionDefinitionFromPreset(
          key as keyof typeof MANAGED_CONNECTION_PRESETS,
        ),
      ).not.toThrow();
    }
  });

  concurrentTest(
    "every preset registers its own client, so none needs a pre-registered client ID or secret",
    () => {
      for (const preset of Object.values(MANAGED_CONNECTION_PRESETS)) {
        expect(["cimd", "dcr"]).toContain(preset.clientRegistration);
        expect(Object.keys(preset)).not.toContain("clientId");
        expect(Object.keys(preset)).not.toContain("clientSecret");
      }
    },
  );

  concurrentTest("uses the given name", () => {
    const definition = managedConnectionDefinitionFromPreset(
      "notion",
      "team-notion",
    );
    expect(definition.name).toBe("team-notion");
    expect(definition.label).toBe("Notion");
    expect(definition.preset).toBe("notion");
  });
});

describe("managedConnectionPresetCatalog", () => {
  concurrentTest("lists every preset under its key", () => {
    expect(managedConnectionPresetCatalog.list()).toEqual([
      { key: "notion", preset: MANAGED_CONNECTION_PRESETS.notion },
      {
        key: "cloudflare-observability",
        preset: MANAGED_CONNECTION_PRESETS["cloudflare-observability"],
      },
      { key: "linear", preset: MANAGED_CONNECTION_PRESETS.linear },
      { key: "sentry", preset: MANAGED_CONNECTION_PRESETS.sentry },
      { key: "neon", preset: MANAGED_CONNECTION_PRESETS.neon },
      { key: "posthog", preset: MANAGED_CONNECTION_PRESETS.posthog },
      { key: "stripe", preset: MANAGED_CONNECTION_PRESETS.stripe },
      { key: "netlify", preset: MANAGED_CONNECTION_PRESETS.netlify },
    ]);
  });

  concurrentTest("gets a preset like managedConnectionPresetFor", () => {
    expect(managedConnectionPresetCatalog.get("notion")).toBe(
      MANAGED_CONNECTION_PRESETS.notion,
    );
    expect(managedConnectionPresetCatalog.get("toString")).toBeNull();
  });
});
