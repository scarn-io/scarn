
# Scarn pipeline authoring reference

Everything below is verified against the shipped SDK. Prefer these shapes over
anything you infer from memory.

Code fences are tagged. A plain `ts` fence is a complete file that compiles as
written. A `ts fragment` fence is a partial illustration of one field or one
call — it will not compile on its own, so read it, do not paste it.

## 0. The directory

You are working inside `.scarn/pipeline-builder/`. `scarn pipelines push`
scans **this directory only** — not subdirectories.

| File                             | Role                                                                 |
| --------------------------------- | --------------------------------------------------------------------- |
| `<pipeline-key>.ts`              | One pipeline. Must `export default definePipeline({ ... })`.          |
| `<pipeline-key>.json`            | Written by `scarn pipelines build` from the `.ts`. Never edit by hand; rebuild it. |
| `steps.ts`                       | Shared steps as **named** exports. Optional; steps may live inline.   |
| `default-pipeline-assignment.ts` | Reserved. Routes incoming work items to a pipeline. Never a pipeline. |
| `push.ts`                        | Generated on every push. Never edit. Skipped by the scanner and by the typecheck. |
| `package.json`, `tsconfig.json`  | Scaffolded. `@scarn/sdk` + `zod` are the only deps; import `z` from the SDK, not from `zod`. |

A pipeline has two halves. Its **steps** (`defineStep`, `codeStep`) are
pushed to the server with `scarn pipelines push`. Its **flow** (which step
runs after which, and with what) is compiled by `scarn pipelines build` into
`<key>.json`, a pipeline document that `push` also publishes.

Imports:

```ts
import {
  defineMcp,
  defineStep,
  Env,
  Features,
  Runtime,
  z,
} from "@scarn/sdk/definitions/steps";
import {
  definePipeline,
  decision,
  succeed,
  fail,
  equal,
} from "@scarn/sdk/pipelines";
import { defaultPipelineAssignment } from "@scarn/sdk/definitions/pipelines";
```

## 1. Steps — `defineStep`

A step is one unit of AI work: a prompt, an optional typed input, and a typed
result. Pipelines read the result directly (§3), so a step declares nothing
extra for routing.

```ts
import { defineStep, Env, Features, Runtime, z } from "@scarn/sdk/definitions/steps";

export const investigate = defineStep({
  key: "investigate", // stable identity; never reuse for a different job
  name: "Investigate",
  description: "Find the root cause from logs and data.",
  status: "active",
  version: 1, // optional, defaults to 1; bump for a breaking redefinition
  environment: {
    runtime: Runtime.host(), // default: Runtime.devcontainer()
    vars: () => ({ READONLY_DB_URL: Env.inherit() }),
  },

  agentPrompt: ({ input, env }) => `
Investigate the reported problem, scoped to ${input.accountRef}.
The read-only database is at ${env.READONLY_DB_URL}.
`,

  // Optional on purpose: a pipeline may call this step with no args at all
  // (see §3). A required field here forces every transition into the step
  // to supply it.
  additionalInput: z.object({
    accountRef: z.string().nullable().optional(),
  }),

  // A pipeline routes on `severity` and passes `findings` and `rootCause`
  // on to later steps, all straight from this result.
  result: z.object({
    findings: z.string(),
    rootCause: z.string(),
    severity: z.enum(["low", "high", "critical"]),
  }),

  // Failures this step can report by name, so a pipeline can retry or catch
  // them (§4). Built-in `Scarn.*` errors need no declaration.
  errors: ["NoAccess"],

  features: [Features.notifications()],
});
```

### Field notes

- **`agentPrompt`** — a string, or a function `({ input, env, scarn }) => string`.
  Interpolations compile to `{{input.x}}` / `{{env.X}}` / `{{scarn.artifactsDir}}`
  tokens that are substituted at execution time.
  - `input.x` only type-checks when `additionalInput` declares `x`. With no
    `additionalInput`, `input` is opaque and any property access is a type error.
  - The step's full resolved input JSON is shown to the agent regardless.
    Interpolation is for emphasis and for weaving a value into a sentence.
  - `scarn.artifactsDir` is the directory the execution collects artifacts
    from (traces, screenshots, reports). It already ends in a separator.
    Prefer telling the agent to submit files with `scarn-submit-artifact`
    (with `name` for an undeclared file), which needs no path.
- **`additionalInput`** — the args a pipeline passes when it calls this step
  (see §3). Each key is type-checked against the call. With no
  `additionalInput`, or only optional fields, the step can be used bare.
- **`result`** — the schema the agent's structured answer must satisfy. A
  pipeline reads it as `r.result` to route (§4) and to pass values on (§3).
  Pass a later step a whole earlier result (`r.result`) rather than copying it
  field by field, and share the `z.object` between the two steps.
- **`errors`** — the names of failures this step can report, for a pipeline's
  `.retry` and `.catch` (§4). Omit it when nothing needs to handle a specific
  failure.
  - **Files a later step or a comment needs** are declared as artifact fields:
    `z.artifact({ accept: [...ArtifactTypes.video, ".gif"] }).nullable()`
    (`ArtifactTypes` is exported next to `z`; `accept` lists lower-case
    extensions with a dot). The agent fills the field by calling
    `scarn-submit-artifact` with `field: "<fieldName>"`; tell it to in the
    prompt, and never to write the path into its findings. Keep the field
    `.nullable()` so a run without the file still succeeds, and route on
    `exists(r.result.<fieldName>)`. An artifact field cannot be inside an
    array.
  - **Showing the file in a comment:** in a `work_item_platform_comment`
    body, `Artifact.embed({ step, path: "<fieldName>" }, { caption })` on its own
    paragraph shows it inline where the platform can (Jira) and links to it
    otherwise; `Artifact.link(..., { label })` always links. If the file is
    missing the comment is not drafted.
- **`features`** — `Features.notifications()` adds the `$scarn_notifications_v1`
  result field and the matching prompt section. Use it instead of
  hand-writing a notification schema.
- **`environment`** — `{ runtime?, vars?, repo? }`, how the step runs. Declare `vars`
  before `agentPrompt` so its keys are typed into the prompt's `env`.
  - `runtime`: `Runtime.devcontainer()` (default) clones the repo and runs inside
    the project devcontainer. `Runtime.devcontainer({ config: ".devcontainer/alt/devcontainer.json" })`
    launches that repo-relative file instead (full path, basename
    `devcontainer.json`; there is no fallback if it is missing).
    `Runtime.host()` runs with no repo and no Docker; use it for classification,
    scoring, and any investigation that only needs MCP tools.
  - `vars`: `({ input }) => ({ NAME: value })`, the env vars injected into the
    step. A plain string is a value, `Env.inherit()` reads the worker's own
    variable of that name, and `Env.value({ value, secret: true })` marks a
    secret. Never write a secret value into a step file.
    By default a variable reaches the agent only. `applies: "setup"` on
    `Env.value` or `Env.inherit` hands it to `devcontainer up` instead, so the
    repo's `initializeCommand` sees it (`"both"` does both). It is not added
    to the container; the repo's `devcontainer.json` forwards it with
    `${localEnv:NAME:default}` if the container needs it. For example, a step
    that never touches sub-repos sets
    `INIT_SUBREPOS: Env.value({ value: "false", applies: "setup" })` and the
    repo has `"containerEnv": { "INIT_SUBREPOS": "${localEnv:INIT_SUBREPOS:true}" }`.
    Not allowed on `Runtime.host()` steps or on a `defineMcp`'s variables.
  - `repo`: what the step does to the repository, from the `Repo` export of
    `@scarn/sdk/definitions/steps`. A devcontainer step defaults to
    `Repo.readWrite()` (work branch, commit and push when the step succeeds; a
    failed push fails the step). `Repo.readOnly()` still clones and checks out the
    base but creates no branch, commits and pushes nothing; use it for analysis,
    triage and review steps that only read code. `Repo.readWrite({ message,
    onPushFailure })` sets the commit message and, with `onPushFailure: "warn"`,
    lets a failed push be logged instead of failing the step. A message may
    use `input` and `result`, so it is a function:
    `repo: ({ result }) => Repo.readWrite({ message: \`fix: ${result.summary}\` })`.
    `Runtime.host()` has no clone, so it takes only `Repo.none()`, which is its
    default and never needs writing. Omit `repo` unless a step needs one of these.
- **Repo config first, step config second.** A step already runs with the
  repository's own `.devcontainer/`, `.opencode/` and `.scarn/`. Anything
  every step needs belongs there, not copied into each step. Put in a step only
  what is about that step: its runtime, its `vars`, its `repo`, the MCP servers
  it mounts and its health checks. Steps have no `plugins` option: OpenCode
  plugins go in the repository's `.opencode/opencode.json`, which every step
  loads. That file is outside this directory, so if a plugin is needed, tell
  the user what to add rather than editing it.
- **`mcps`** — the MCP servers this step runs with, each a `defineMcp` (see
  "MCP servers — `defineMcp`" below). A step gets **only** the servers it
  lists in `mcps`: every server the repository defines (see the files below)
  is turned off for a step that does not list it, even one in
  `.opencode/opencode.json`. `defineMcp` is the only way to give a step an MCP
  server or an MCP health check. `.opencode/tools/` custom tools are not MCP
  servers and still load for every `workspace` step. Skills are not chosen per
  step either: every skill under `.claude/skills/`, `.agents/skills/`,
  `.opencode/skill/` or `.opencode/skills/` in the repository is available to
  every `workspace` step.

### MCP servers — `defineMcp`

Every MCP server a step uses is a `defineMcp`: which server it is, the env
vars it needs, and its health checks, written once. Each step that uses it
mounts it under `mcps` in one line, and adjusts it for that step with the
builder methods below.

A `defineMcp` takes a `type`:

| `type`     | Use it for                                                        | Fields                                                              |
| ---------- | ----------------------------------------------------------------- | ------------------------------------------------------------------- |
| `"ref"`    | A server the repository already defines                           | `name`: its name in the repository's MCP config                     |
| `"local"`  | A server the repository does not define, launched as a subprocess | `name`, `command` (`[executable, ...args]`), `cwd?`, `environment?` |
| `"remote"` | A server the repository does not define, reached over HTTP        | `name`, `url`, `headers?`, `oauth?`                                 |

All three also take `env?`, `optionalEnv?`, `healthChecks?`, and OpenCode's
`timeout` (`{ startup, catalog, execution }` in milliseconds), `protocol` and
`codemode`. Prefer a `ref` whenever the repository defines the server.

**Define each server once per file, and override it per step.** Never write
the same server's checks or env vars into two steps: copies drift.

```ts
import { defineMcp, defineStep, z } from "@scarn/sdk/definitions/steps";

const postgres = defineMcp({
  type: "ref",
  name: "postgres",
  healthChecks: {
    listSchemas: { tool: "list_schemas" },
    listTables: { tool: "list_tables", args: { schema: "public" }, enabled: false },
  },
});

export const triageData = defineStep({
  key: "triage-data",
  name: "Triage Data",
  status: "active",
  agentPrompt: "Use the postgres tools to find the rows behind this report.",
  mcps: { postgres },
  result: z.object({ summary: z.string() }),
});

export const explainData = defineStep({
  key: "explain-data",
  name: "Explain Data",
  status: "active",
  agentPrompt: "Explain the data problem. Query postgres if it helps.",
  mcps: {
    db: postgres
      .enableCheck("listTables")
      .overrideCheck("listSchemas", { timeoutSeconds: 30 }),
  },
  result: z.object({ summary: z.string() }),
});
```

A server the repository does not define is written inline as `local` or
`remote`. Use this for a `Runtime.host()` step too: it has no checkout, so it
cannot use a `ref`.

```ts
import { defineMcp, defineStep, Runtime, z } from "@scarn/sdk/definitions/steps";

const warehouse = defineMcp({
  type: "local",
  name: "warehouse",
  command: ["<launch command for the server, from the user>"],
  environment: { WAREHOUSE_URL: "{env:WAREHOUSE_URL}" },
  healthChecks: { listTables: { tool: "list_tables" } },
});

const tracker = defineMcp({
  type: "remote",
  name: "tracker",
  url: "https://mcp.internal.example/tracker",
  headers: { Authorization: "Bearer {env:TRACKER_TOKEN}" },
});

export const classify = defineStep({
  key: "classify",
  name: "Classify",
  status: "active",
  environment: { runtime: Runtime.host() },
  agentPrompt: "Classify the report. Check the warehouse and tracker if it helps.",
  mcps: { warehouse, tracker },
  result: z.object({ category: z.string() }),
});
```

- `name` — for a `ref`, the server's name in the repository's MCP config. The
  `mcps` key is the name the step runs it under; mounting it under a
  different key (`db` above) aliases it. For `local` and `remote`, `name`
  only labels the server in errors; the `mcps` key names it at runtime.
- `command`, `cwd`, `environment` (`local`) and `url`, `headers`, `oauth`
  (`remote`) are OpenCode v2's `mcp.servers.<name>` fields. A `local` command
  must be resolvable **inside the execution environment** (the devcontainer
  for `workspace` steps, the worker host for `Runtime.host()`), not on the
  user's laptop. For a Playwright or Postgres server, see §10 below — do not
  invent a command for either; there is no single correct invocation.
- Every `environment` and `headers` value must be written as `{env:VAR}`
  (`"Bearer {env:TOKEN}"` is fine); `defineMcp` throws on a literal value,
  because it would be stored in plaintext. Never put a secret in `command` or
  `url` either.
- Every `{env:VAR}` in a `local` server's `command`, `cwd` or `environment`,
  or a `remote` server's `url` or `headers`, becomes a **required** worker
  variable for that server — do not list it in `env`. When the server can run
  without it, list it in `optionalEnv`.
- `healthChecks` — a record keyed by check name: `{ tool, args?,
  timeoutSeconds?, severity?, serialGroup?, enabled? }`. `tool` is the bare
  tool name; there is no `mcp` field, the step's key supplies it. Checks on
  one server run one at a time; different servers run in parallel.
  `enabled: false` defines a check a step must turn on with `enableCheck`.
- `env` — only for a server that reads `process.env` directly. A variable the
  server's definition (the repository's, for a `ref`) references as
  `{env:VAR}` is required automatically; do not list it. `optionalEnv` is
  passed through when set.

Builder methods, each returning a new server and leaving the original
untouched, so chain them freely off a shared definition:

| Method | Effect |
| --- | --- |
| `.overrideCheck(name, patch)` | Changes `tool`, `args`, `timeoutSeconds`, `severity` or `serialGroup`; `args` is replaced whole |
| `.disableCheck(name)` / `.enableCheck(name)` | Turns one check off or on; the last of the two wins, and a disabled check stays off whatever is overridden |
| `.addCheck(name, check)` | Adds a check for this step only; the name must be new |
| `.disableAllChecks()` | Turns off every check defined so far |

Severity belongs to each check, not the server: a check is `required` unless
its `severity` is `"warn"`, set in `defineMcp` or for one step with
`.overrideCheck(name, { severity: "warn" })`. A server's variables are
required unless listed in `optionalEnv`; when one is missing on the worker,
the step fails before launch.

The step's own `healthChecks` holds only `cli` checks and checks on tools that
are not MCP tools (no `mcp` field); every MCP check lives in its `defineMcp`.
A step file that also exports a
`codeStep` must keep its `defineMcp`s in that file: the code-step container
cannot resolve an extensionless relative import such as `./mcps`.

The worker resolves each `ref` against the repository only — never the user's
global OpenCode config — just before launch, first match wins:
`.opencode/opencode.json`, `.opencode/opencode.jsonc`, `opencode.json`,
`opencode.jsonc`, `.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`,
`.codex/config.toml` (all at the repository root). Each is converted to
OpenCode's shape, with `${VAR}` and `${env:VAR}` turned into `{env:VAR}`. A
`.vscode/mcp.json` server that reads an `${input:…}` prompt cannot be used,
and a literal credential in a source file is dropped. A `Runtime.host()` step
has no checkout, so it cannot use a `ref`: give it `local` or `remote`
servers. Push does not check that a ref exists; one that
matches nothing fails the step before launch, listing every file searched.
Only write a `ref` for a server you saw defined in one of those files.

### Secrets

Never write a secret **value** into a step file: it is pushed to the server,
persisted in the database, and rendered in the UI. Reference it as
`{env:VAR}` in a `local` server's `environment` or a `remote` server's
`headers` instead (`defineMcp` rejects anything else there). A `defineMcp`
server's variables (its `env`, `optionalEnv`, and every `{env:VAR}` in its
definition) are read from the worker — `.scarn/.env` at the repository root,
then the worker's own environment — always masked in logs, and never put in
the prompt. A required one that is missing fails the step before launch.

Whenever you introduce a `{env:VAR}` reference (or a `defineMcp` `env` name)
that is new to this directory:

1. Ask the user only for the **name** of the variable (or propose a sensible
   one yourself) and how a human obtains the real value — never for the value
   itself.
2. Create `.scarn/.env.example` — a file **one directory up** from here,
   sibling to `.scarn/pipeline-builder/`, not inside it — if it does not
   already exist.
3. Append `VAR=` (an empty value; never a placeholder that looks real) unless
   that exact key is already present.
4. Tell the user, by variable name, in your closing summary: they must copy
   this file to `.scarn/.env` and fill in the real value before any step
   that reads it can run.

`.scarn/.env` itself is never a file you create or edit — it holds real
secret values, and it is the user's alone to write.

## 2. Pipelines — `definePipeline` and `flow`

A pipeline says which step runs first, and for each node, where to go when it
finishes. It is written with `definePipeline` from `@scarn/sdk/pipelines`
and compiled by `scarn pipelines build` into a JSON document.

```ts
import { definePipeline, succeed } from "@scarn/sdk/pipelines";
import { investigate, writeFix } from "./steps";

const done = succeed("done");

export default definePipeline({
  key: "bug-repro-pipeline",
  title: "Bug Repro Pipeline",
  start: investigate,
  flow: [
    investigate.next((r) => writeFix({ investigate: r.result })),
    writeFix.next(done),
  ],
});
```

How to read it:

- **A step is callable.** `writeFix({ ... })` means "go to `writeFix` with
  these args". It runs nothing; it records a target. A step whose input has
  no required fields can also be used bare (`start: investigate`).
- **`start`** is the first node, with its args.
- **`flow`** lists at most one **chain** per node: what happens after that
  node finishes. `.next(target)` always goes to one place; `.next({ routes,
  otherwise })` branches (§4). A node with no chain ends its path when it
  finishes: the run ends or, inside a lane, the lane ends. Wiring a node twice
  fails the build.
- **A node's id is its step's `key`.** To run the same step twice in one
  pipeline, give the second one its own id: `investigate.as("re-investigate")`.
- **Terminals.** `succeed("id")` and `fail("id", { error: "NotReproduced" })`
  end the run. They are targets, never chains: they have nothing to wire.
- **`title`** is optional and shown in the dashboard.
- Chains are values. Building one never changes the step, so one step can be
  imported into two pipelines with different flows.

Per-node settings sit at the start of that node's chain:

```ts fragment
fix
  .settings({ timeoutSeconds: 3600, heartbeatSeconds: 300, maxRuns: 5 })
  .next(done),
```

`maxRuns` caps how many times the node may run in one execution (a loop back
to it counts); going over it raises `Scarn.MaxRunsExceeded` (§4).

## 3. Args and references

Every callback in a chain receives `r`, the values available at that point.
They are **references**, not the values themselves: `r.result.quality` stands
for "the `quality` field of this node's result, when the pipeline runs". The
build records the path; the server reads it at run time.

| Reference | What it is |
| --- | --- |
| `r.result` | The result of the node this chain belongs to |
| `r.input` | The args that node was called with |
| `r.node(step).result` / `r.node(step).input` | An earlier node's result or args |
| `r.error` | The error, in a `.catch` target only |
| `workItem.title` | The work item's title |
| `workItemField("alias", "Form label")` | One field from the work item's form |

**Args.** Each arg is either a reference of a matching type or a plain JSON
value (`appUrl: "https://staging.example.com"`). Missing, extra and
wrongly-typed args are type errors. An array may mix references and plain
values (`reviews: [r.result]`); a literal object may not contain references,
so pass the reference itself (`evaluate: r.result`).

**Pass whole results.** The default is to give a later step every earlier
result it could use, each under a field named after the step that produced it,
and to declare each one in the consumer's `additionalInput` with the
producer's own `result` schema. Copy single fields only when a step needs one
value.

**`r.node(step)` only reaches nodes that ran on every path to this point.** A
node on another branch, or a later one, is a build error. When a value comes
from a node two hops back, either reach for it with `r.node(...)` or pass it
along through each step's input (`r.input.evaluate`).

`{ ...r.input }` passes every field of this node's args on to the next step
unchanged.

```ts
import { definePipeline, succeed, workItemField } from "@scarn/sdk/pipelines";
import { investigate } from "./steps";

const done = succeed("done");

export default definePipeline({
  key: "scoped-pipeline",
  title: "Scoped",
  // A form field from the work item, read straight into the step's args.
  start: investigate({ accountRef: workItemField("account", "Account") }),
  flow: [investigate.next(done)],
});
```

### Traps

- **Callbacks run once, at build time, with references.** JavaScript logic on
  a reference does not do what it looks like: `(r) => r.result.ok ? a() : b()`
  always picks `a`. Use `.next({ routes })` and the condition helpers (§4). A
  reference
  used in a template string, a comparison or arithmetic throws at build time,
  and a field read but never used fails the build.
- **`input.workItemComments` is not an arg.** The work item's pinned comments
  are added to every step's input at run time. Never pass them.
- **Nothing else is added for you.** A step that needs the work item's title
  or a form field gets it as an arg (`workItem.title`, `workItemField(...)`).

## 4. Branching, decisions, lanes and errors

### Conditions — `.next({ match?, routes, otherwise? })`

```ts fragment
evaluate.next({
  routes: [
    {
      when: (r) => lessThan(r.result.quality, 0.1),
      to: (r) => requestDetails({ evaluate: r.result }),
    },
    { when: (r) => equal(r.result.severity, "critical"), to: pageOncall },
  ],
  otherwise: (r) => investigate({ evaluate: r.result }),
}),
```

Routes are checked in order; the first whose `when` matches wins, and
`otherwise` catches the rest. `otherwise` is optional: when no route matches
and there is none, the path ends, as if the node had no chain. A route may
leave out `when` only when it is the only route. This is `match: "first"`,
the default (see Splits for `"all"`). A condition is built with a helper from `@scarn/sdk/pipelines`, never with a
JavaScript operator (`r.result.quality < 0.1` is a type error):

- Compare: `equal`, `notEqual`, `lessThan`, `lessThanInclusive`,
  `greaterThan`, `greaterThanInclusive`, `contains`, `startsWith`,
  `endsWith`, `matches`, `before`, `after`. The right side is typed against
  the left (`greaterThan` only on numbers, `before` only on dates).
- Presence: `exists(ref)` is true when the value is present and not null; use
  it on nullable fields, artifact fields above all. `isEmpty(ref)` for an
  empty string or array.
- Combine: `all(a, b, ...)`, `any(a, b, ...)`, `not(c)`.
- Over a list: `some(list, (x) => cond)`, `every(...)`, `none(...)`.
- Aggregate: `sum`, `avg`, `min`, `max`, `count` take a list of refs
  (`avg([r.result.a, r.result.b])`) or a list and a field
  (`avg(r.input.reviews, (x) => x.confidence)`), and go on the left of a compare.
  Prefer several narrow scores and an aggregate over one holistic number.

```ts fragment
all(
  greaterThanInclusive(r.result.reproductionConfidence, 0.8),
  exists(r.result.reproVideo),
)
```

### Decisions — `decision`

`decision("id", { actions })` is a node that waits for a person to pick one of
`actions` in the dashboard. Each action is a button, in key order, with a
`label`; the person can also write a body, which an action marks `body:
"required"` (the default is `"optional"`). The result is `{ action, body }`:
`action` is one of the keys, `body` the trimmed text or `null`. Route on
`r.result.action`; `r.result.body` can be passed on like any other value:

```ts fragment
const reviewFix = decision("review-fix", {
  actions: {
    approve: { label: "Approve" },
    revise: { label: "Request changes", body: "required" },
    reject: { label: "Reject" },
  },
});

proposeFix.next((r) => reviewFix({ proposal: r.result })),
reviewFix.next({
  routes: [
    {
      when: (r) => equal(r.result.action, "approve"),
      to: (r) => fix({ plan: r.node(proposeFix).result }),
    },
    {
      when: (r) => equal(r.result.action, "revise"),
      to: (r) =>
        proposeFix({ ...r.node(proposeFix).input, feedback: r.result.body }),
    },
  ],
  otherwise: fixRejected,
}),
```

`revise` loops back: `proposeFix` runs again with the feedback, and the
person decides again. A loop through a decision has no default limit; add
`maxRuns` (see Loops) only if the user asks for a cap. The args it is called
with are shown to the person deciding. `decision("id", { input:
z.object({...}), actions })` types them.

### Loops

A transition may point back at an earlier node. A loop has no default limit.
To cap one, set `maxRuns` in that node's `.settings` and catch
`Scarn.MaxRunsExceeded`:

```ts fragment
fix
  .settings({ maxRuns: 3 })
  .catch(["Scarn.MaxRunsExceeded"], gaveUp)
  .next({
    routes: [{ when: (r) => equal(r.result.testsPass, true), to: done }],
    otherwise: (r) => fix({ ...r.input, previousAttempt: r.result }),
  }),
```

### Retry and catch

`.retry({ on, maxAttempts })` re-runs the node when it fails with one of the
named errors. `.catch(on, target)` goes somewhere else instead; its callback's
`r` has `error` and `input`, and no `result`. Both come after `.settings` and
before `.next`. `on` lists built-in errors (`Scarn.All`,
`Scarn.StepFailed`, `Scarn.HealthCheckFailed`, `Scarn.Timeout`, `Scarn.HeartbeatTimeout`,
`Scarn.MaxRunsExceeded`, `Scarn.ConditionError`, `Scarn.ArgsError`) and
the names in the step's own `errors`; anything else is a type error.

```ts fragment
investigate
  .retry({ on: ["Scarn.HeartbeatTimeout"], maxAttempts: 2 })
  .catch(["NoAccess"], (r) => askForAccess({ reason: r.error.message }))
  .next(done),
```

### Splits and merges — `match: "all"`, `each` and `.partial`

A **split** runs work side by side in **lanes**. `.next({ match: "all",
routes, otherwise? })` takes **every** matching route as a lane; a route with
no `when` always runs, `otherwise` only if no `when` matched.
`each(list, { maxConcurrency?, toleratedFailures? }?, (item) => target)` runs
a lane per item, only as a `next` target. A lane ends at a **merge**:
`step.partial(args)` hands `step` part of its args, and `step` runs **once**,
after every lane that can reach it:

```ts fragment
triage.next({
  match: "all",
  routes: [
    { to: (r) => reproduce({ summary: r.result.summary }) },
    {
      when: (r) => equal(r.result.category, "security"),
      to: (r) => notifySecurity({ summary: r.result.summary }),
    },
    { to: (r) => each(r.result.pages, {}, (url) => screenshot({ url })) },
  ],
}),
reproduce.next((r) => report.partial({ observed: r.result.observed })),
notifySecurity.next((r) => report.partial({ securityNotes: r.result.notes })),
screenshot.next((r) => report.partial({ screenshots: [r.result.url] })),
report.next(done),
```

- Item-lane fields are arrays, `[]` if none arrive; other fields are copied,
  each from one route only. A required field must arrive on every path from
  a `when`-less route (paths to `fail` aside): `observed` may be required,
  `securityNotes` must be optional.
- Every route into a merge is `.partial`. A merge every lane reaches closes
  the split; one only some `all` lanes reach becomes a lane. An `each`
  split's merge must close it.
- No route, no chain, or `succeed` ends a lane quietly; a lane reaching no
  merge is fire-and-forget. A failed `all` lane fails the run; failed item
  lanes count against `toleratedFailures` (`{ count: 0 }` by default).

Build errors: `.partial` outside a split, or a plain route into a merge; lanes
of two routes meeting without `.partial`; a merge field from two routes, maybe
missing yet required, or not an array from item lanes; a node inside and
outside a split; `r.node(x)` past the merge of `x`'s lanes; a `.partial`
route of an `all` node. Type errors: `.partial`/`each` in `start` or
`.catch`, or `.partial` from `each`. No `toleratedFailures` on `all`.

## 5. `default-pipeline-assignment.ts`

Decides which pipeline starts when a work item arrives. Without it, nothing
runs automatically — this file is what makes a pipeline real.

```ts
import { defaultPipelineAssignment } from "@scarn/sdk/definitions/pipelines";

export default defaultPipelineAssignment(
  ({ workItem, context, all, assign, skip }) => ({
    default: skip(),
    rules: [
      workItem.field("status").eq("resolved").then(skip()),
      all(
        workItem.field("issueType").eq("Bug"),
        context.isNew.eq(true),
      ).then(assign("bug-pipeline")),
    ],
  }),
);
```

- `assign()` takes a pipeline **key**, or the value a pipeline file's
  `definePipeline()` returns.
- The pipeline must be published (§9) before a work item can run it.
- Rules are ordered; first match wins; unmatched fall through to `default`.
- `context.isNew` is `true` on first ingestion of the work item.

## 6. Invariants — the things that actually break

1. Each node has at most one chain in `flow`; `succeed` and `fail` have none.
   A node wired twice fails the build. A node with no chain ends its path.
2. A chain is finished by `.next(target)` or `.next({ match?, routes,
   otherwise? })`. `routes` needs at least one entry. When no route is taken
   and there is no `otherwise`, the path ends without failing.
3. Args are type-checked against the step's `additionalInput`: a required field
   must be passed, and an unknown one is an error.
4. Conditions are built with the helpers in §4. JavaScript logic on a
   reference compiles to the wrong thing; the build catches most of it, not
   all of it.
5. `r.node(step)` only reaches a node that ran on every path to this point.
6. Every node must be reachable from `start`.
7. Node ids are unique. Using a step twice needs `.as("other-id")`.
8. A pipeline file must use `export default`. A pipeline assigned to a named
   export is not built.
9. **Order: push, then build, then publish.** `push` sends the steps; `build`
   checks the flow against them and writes `<key>.json`; `publish` uploads
   that JSON. A published pipeline that calls a step the server does not have
   is rejected.
10. The scanner skips `push.ts` / `push.mjs` / `push.js` and
    `default-pipeline-assignment.ts`, ignores subdirectories, and only reads
    `.ts` / `.js` files.
11. Use `status: "active"` on steps. `"draft"` steps do not execute.
12. Never edit `<key>.json` by hand. Change the `.ts` and rebuild.

## 7. The default pipeline

Every new pipeline starts from one compile-verified file, `bug-pipeline.ts`.
The scaffold has already written it into this directory, with its built
`bug-pipeline.json` next to it, and it is reproduced in *The default pipeline
file* at the end of this section. Do not author the steps or the `flow` from
scratch and do not pick a different shape: edit that file in place and adapt
it to this repository, then rebuild the JSON. It is an opinionated starting
point, not a fixed one: when the user asks to change the shape, change it.
What the agent can reach changes how `investigateAndReproduce` is configured,
not which pipeline you build.

| Node | Kind | What it produces |
| --- | --- | --- |
| `evaluate` | step, `Runtime.host()` | `quality` (0–1), `missingDetails[]`, a restated summary |
| `request-details` | `codeStep`, then `insufficient-detail` (`fail`) | a comment draft asking for the missing details |
| `investigate-and-reproduce` | step, devcontainer, `Repo.readOnly()` | report, `reproduced`, `reproductionConfidence` (0–1), a `reproVideo` recording (or null), suspected root cause, evidence |
| `report-reproduction` | `codeStep` | a comment draft embedding the recording |
| `failing-test` | step, devcontainer | a failing test, or `testWritten: false` with a reason |
| `propose-fix` | step, devcontainer, `Repo.readOnly()` | a fix proposal for a human to review |
| `approve-fix` | `decision` (approve / reject) | the reviewer's `action`; `reject` ends at `fix-rejected` (`fail`) |
| `fix` | step, devcontainer | the approved fix applied, with a stated confidence |

How it is wired, and why:

- **A low bar to start.** `evaluate`'s chain only stops reports with nothing
  to start from (`quality` below `0.1`), so a user's first run almost always
  reaches the investigation. `requestDetails` is code, not an agent: it turns
  `missingDetails` into a `feedback_request` notification suggesting
  `work_item_platform_comment`, which becomes a draft a human approves before
  it is posted on the work item. The run then ends at `insufficientDetail`.
  Leave the `0.1` threshold alone.
- **Investigation is the step that matters.** Everything after it works from
  its evidence. Give it every tool the user picked in phase 3 — the browser,
  logs, a read-only database, error tracking, internal APIs — and name in its
  prompt what each one is for.
- **A high bar to write a test.** `reproductionConfidence` is the step's own
  judgement of whether it reproduced the bug and understands its cause. Only
  a confident reproduction (at least `0.8`) goes on towards `failingTest`;
  anything less ends the run at `notReproduced`, with the investigation report
  as its result.
- **The recording is an optional artifact.** `reproVideo` is a nullable
  `z.artifact` field the agent fills with `scarn-submit-artifact`. The first
  route of `investigateAndReproduce`'s chain needs both the confidence and
  `exists` on `reproVideo`: only a run that recorded the failure goes through
  `reportReproduction`, a code step whose comment draft embeds the recording
  with `Artifact.embed({ step: investigateAndReproduce, path: "reproVideo" }, ...)`,
  and then on to `failingTest`. A confident run without a recording goes
  straight to `failingTest`.
- **A human approves the fix.** `proposeFix` reads the code but changes
  nothing, and always goes to `approveFix`, a `decision` node with `approve`
  and `reject` actions. Approving it in the dashboard lets `fix` apply the
  proposal; rejecting it ends the run at `fixRejected`. Keep it unless the
  user asks to remove it; add a `revise` action that loops back to
  `proposeFix` only if they ask for one.
- **Whole results, passed forward.** Each step gets every earlier result it
  can use as an arg named after the step that produced it, and declares those
  fields in `additionalInput` with the producer's schema. Each chain reads
  them from `r.result`, `r.input` or `r.node(...)`.
- **Branches.** `investigateAndReproduce` and `proposeFix` are read-only, so
  they push nothing. `failingTest` commits its test on a work branch, and
  `proposeFix` and `fix` start from that branch, so the fix lands on top of the
  test.

Adapting `investigateAndReproduce` to what the agent can reach:

- **A running app it can sign in to.** Keep the Playwright server and the trace
  choreography in its prompt: set the viewport before starting the trace,
  wait after the final triggering action, stop the trace last. **Keep that
  ordering.** Stopping the trace immediately after the triggering action is
  the single most common way to lose the evidence, because delayed redirects,
  toasts, validation errors and forced logouts are the actual bug more often
  than not. Replace `APP_URL` and the sign-in instructions: tell the agent
  exactly how to obtain credentials (a named tool, named env vars, or a
  documented test account), and if it cannot, it must report auth as blocked
  rather than guess.
- **No reachable app.** There is no trace. Remove the Playwright `defineMcp`
  and its `mcps` entry, `APP_URL`, the `appUrl` arg and the browser procedure;
  have it reproduce from the code, the tests and the other tools, and remove
  `reproVideo`, `reportReproduction` and its chain, and the first route of
  `investigateAndReproduce`'s chain, leaving the confidence check that goes
  straight to `failingTest`. Rewrite what earns a `reproductionConfidence`
  above 0.8 for this case (a code path the evidence pins down, a test it could
  run), or nothing will ever reach `failingTest`.
- **Other tools the user picked** (a read-only database, logs, an internal
  API). Define each once with `defineMcp` next to `playwright`, mount it in
  the `mcps` of every step that uses it, and name in the prompt what it is
  for and when to use it.
- **Off-limits systems.** Write what must never be touched into every step's
  prompt, not just this one.

Health checks, per §10's rules: every `defineMcp` gets a `tool` check calling
the tool the user chose. Keep a server's checks `required` when the step
cannot work without it, and set its checks to `warn` when it only helps;
change a check for one step with the builder, never by copying the server.
`investigateAndReproduce` also checks the Playwright CLI (`warn`), and
`failingTest` and `fix` each check the test runner (`required`), in their own
`healthChecks`. Replace the template's `vitest` with this repository's runner,
keeping `npx --no-install` and a flag that does no work. Drop the Playwright
CLI check along with the server when there is no reachable app.

Rename keys only if the user asks; a step's `key` is its node id, so renaming
one renames the node in `bug-pipeline.json` too. Rewrite every prompt for this
repository's test framework, vocabulary and conventions — never for the seeded
work item's feature, symptom or data. The pipeline runs on every item of its
kind.

## 8. Writing a good `agentPrompt`

Most of a pipeline's quality lives here.

- **Name the tools.** "Use the browser MCP tools" beats "investigate the page".
  If a specific tool exists for a specific job, say which and when.
- **Say what to do when blocked, instead of leaving it to improvisation.** An
  agent that lacks a credential, a workflow, or a term will invent one. Give it
  an explicit escape hatch: check a named source first, otherwise emit a
  `feedback_request` notification with a concrete question — never guess.
- **Ask for an honest "could not".** A step that could not reproduce the bug
  or write the test should say so in a field (`reproduced: false`,
  `testWritten: false` with a `reason`) rather than produce something that
  looks like success. The next step reads that and adjusts.
- **Demand structured evidence.** Paths, URLs, query results, log excerpts —
  concrete artifacts the next step can consume, not a narrative.
- **Explain the inputs.** For each bound field, say what it means and what to do
  when it is null or empty ("say so in your summary rather than guessing at
  scope").
- **Write for the next step.** Say who consumes each result field and what they
  need from it, in enough detail to act on.
- **Keep it operational.** Numbered procedures where order matters; prose where
  judgement matters.
- **Keep it generic.** A prompt runs on every item routed to its pipeline. It
  says how to work the item in front of it, which the agent already sees; it
  never names the ticket the pipeline was designed around.

## 9. Validate, then push

### Typecheck

The scaffolded `package.json` has a `typecheck` script and the scaffolded
`tsconfig.json` is already configured for it. Run one of these from
`.scarn/pipeline-builder/` — whichever matches the lockfile in that directory:

```sh
# bun
bun run typecheck

# npm / pnpm / yarn
npm run typecheck
pnpm run typecheck
yarn run typecheck

# deno
deno check *.ts
```

A clean directory typechecks with zero output, so **every error you see is
yours**. `push.ts` is generated and is excluded from the typecheck.

### Push

The CLI resolves `.scarn/pipeline-builder` relative to the **current working
directory**, so every command below runs from the repository root. Run them in
this order:

```sh
# 1. Send the steps to the server.
cd ../.. && "$SCARN_CLI" pipelines push

# 2. Compile every pipeline file into <key>.json, and check it against the steps.
cd ../.. && "$SCARN_CLI" pipelines build

# 3. Upload a built pipeline. Repeat for each pipeline you changed.
cd ../.. && "$SCARN_CLI" pipelines publish .scarn/pipeline-builder/bug-pipeline.json
```

`$SCARN_CLI` is the absolute path to the running CLI. If it is unset, fall
back to plain `scarn pipelines ...`.

- `push` sends steps, publishes every built `<key>.json`, then the assignment.
- `build` writes `<key>.json` next to each pipeline file and validates it. A
  build error names the `.ts` line and the JSON path; fix the `.ts` and build
  again. `build bug-pipeline.ts` builds one file.
- `publish` uploads one document as that pipeline's new active version.

A successful publish is the finish line: the pipeline is live.
