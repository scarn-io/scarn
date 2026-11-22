# Connections

This domain holds a project's managed MCP connections: a project's link to a
hosted MCP server that an admin authorized through OAuth, the grants it holds,
the launches that use it and the relay that forwards a run's calls. See
`docs/adr/0013-managed-mcp-connections.md`, decisions 35–46 for how
connections own their server. User docs: `apps/docs/src/content/docs/connections/`.

## Adding a preset

A preset fills in a new connection's server for a well-known service and adds
what discovery can't tell Scarn. The connection row is the source of truth
after creation: changing a preset later doesn't move existing connections.
Adding one needs no SDK or CLI release.

### 1. The catalog entry

Add an entry to `MANAGED_CONNECTION_PRESETS` in
`managed-mcp-connection/infra/managed-connection-presets.ts`. The key is the
default connection name, so it must be lowercase kebab-case.

| Field                  | What to set                                                                                                                                                                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `label`                | What people see: the settings card, push output, error messages.                                                                                                                                                                                          |
| `resource`             | The MCP URL. It's normalized on create, and must be unique per project.                                                                                                                                                                                   |
| `issuerOrigin`         | The authorization server's origin. Discovery only confirms it; it never chooses one. Every endpoint must be on this origin.                                                                                                                               |
| `clientRegistration`   | `cimd` if the server advertises `client_id_metadata_document_supported`, else `dcr` (it must have a `registration_endpoint` and accept public clients, `token_endpoint_auth_method: none`). Presets never use `supplied`, which is only for a client ID from the user's own MCP config. |
| `removalUrl`           | Optional. The provider's page where people remove Scarn's access. Leave it unset until the staging gate has found it; the UI hides the link without it.                                                                                                   |
| `parseIdentity`        | Optional. Reads who signed in from the raw token response (see `infra/notion-identity.ts`). Without it identity is null and the UI says the account can't be verified. With it, a response it finds nothing in fails the connect with `missing_identity`. |
| `requireIssParameter`  | See below.                                                                                                                                                                                                                                                |
| `revokeReplacedGrants` | See below. Leave it `false`.                                                                                                                                                                                                                              |

Scarn never calls a provider API to find out who signed in, so only add a
parser for fields the token response itself carries.

#### `requireIssParameter`

The callback's `iss` is always required when the server advertises
`authorization_response_iss_parameter_supported`, and a wrong `iss` is always
rejected. `requireIssParameter: true` additionally makes discovery fail if the
server stops advertising it. Set it to `true` when the server advertises `iss`
today and a regression should stop connects rather than silently downgrade.
Set it to `false` when the server doesn't advertise it, or you haven't
confirmed the real callback carries it.

#### `revokeReplacedGrants`

ADR 0013 decision 45: a reconnect deletes the replaced grant without revoking
it, because some OAuth servers revoke the whole grant family on any
revocation, which would also kill the new grant. Turn it on only after the
staging gate shows revoking the replaced grant leaves the new one working.
Nothing reads this flag yet: wire it into confirm before relying on it.

### 2. A fake-backed test

The integration harness serves the catalog from `presetsWithFake`
(`packages/core/tests/connections/managed-mcp-connection/integration/managed-connection-fake-presets.ts`).
Pass `presetFakes: { "<key>": fake }` to `createManagedConnectionHarness` to
keep your preset's behaviour but point its `resource` and `issuerOrigin` at a
loopback `FakeMcpOAuth`, and add the fake's origin to `loopbackOrigins`.

Configure the fake (`tests/connections/support/fake-mcp-oauth-options.ts`) to
match the provider's real metadata: `clientRegistration`,
`issParameterSupported`, `revocation` and `identityShape`. Then cover connect,
confirm (including what the UI says about identity), refresh, a relay call,
the tool list and disconnect, alongside the harness's Notion connection.
`managed-connection.cloudflare.test.ts` is the model. Also extend
`tests/connections/managed-mcp-connection/unit/managed-connection-presets.test.ts`.

### 3. The staging gate

Before users rely on the preset, a person checks it on staging with a real
account, recording pass/fail and outcomes, never token or response values:

- Connect: consent works, and the confirm card shows the expected identity
  (or "can't be verified"). For DCR, exactly one `managed_oauth_clients` row
  is registered for the issuer.
- Connect a second project: for DCR, no new registration.
- The tool list loads, and a step with `auth: { connection: "<key>" }` runs a
  read-only tool through the relay.
- Force a refresh and check refresh-token rotation behaves as refresh
  expects.
- Disconnect: record the revocation outcome, and find where the provider
  lists Scarn's access. That page becomes `removalUrl`.
- If the real token response carries a stable account ID, add a
  `parseIdentity` in a follow-up.
- Regression: connect, run and disconnect Notion.

### 4. Docs

Add a page under `apps/docs/src/content/docs/connections/`, a row to the table
in `connections/index.md`, and a sidebar entry in `apps/docs/astro.config.mjs`.
