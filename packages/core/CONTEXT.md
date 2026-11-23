# Core

The domain library behind Scarn: work items, the Tasks agents run on them, pipelines, and the conversations between agents and people.

## Language

### Tasks and their context

**Task context**:
What a Task's agent is told about beyond its own instructions. It is held as references and fetched fresh for each run.
_Avoid_: step input, task input (those are the step's arguments)

**Context reference**:
A pointer from a Task to something it gets context from, made of a kind and an id. A Task on a work item always has that work item as one of them; a chat and a scheduled Task have none (see **Chat**, **Scheduled Task**).
_Avoid_: context link, subject id

**Context provider**:
The code that turns one kind of context reference into the summary, files and branch a run receives.

**Concurrency group**:
The live Tasks that share a limit on how many can run at once and how many may wait behind them. It is keyed either by one step on one work item, when that step sets the limit, or by one schedule, whose rule sets it (see **Schedule**); a step's own limit doesn't apply when a schedule starts it, and a chat is never in one. A Task holds its place from when it's let in until it ends, including while it waits for a person, for work or for a retry. Tasks beyond both limits are dropped. It limits only live Tasks: whether the work is done is decided by its work item closing, not by an earlier Task succeeding.
_Avoid_: lock, mutex, queue, singleton, claim

### Environments

**Environment**:
The runtime and variables a Task run uses. A step can name a shared environment or define one inline; omitted settings use their defaults. It has no branch (see **Base branch**).
_Avoid_: instance, profile

**Named environment**:
An environment stored in Scarn under a name and defined in code with `defineEnvironment`, so steps using it pick up pushed changes without being published again.
_Avoid_: environment profile, preset

**Environment version**:
One pushed copy of a named environment. A run uses the latest version when it's claimed; a continuation keeps the version its Task already used.
_Avoid_: revision, snapshot

**Environment handle**:
What `defineEnvironment` returns. A step can use it in place of the name.
_Avoid_: environment ref (that's the stored `named | inline | null` value)

**Inline environment**:
An environment defined directly on a step rather than shared by name.
_Avoid_: anonymous environment, embedded profile

**Repo default**:
The environment used when a step names or defines none, or a Task has no step: the repo's devcontainer if present, otherwise managed `bun1`, with the usual branch choice and no added variables.
_Avoid_: default profile, host default

**Environment override**:
A named environment chosen for one Task in place of its step's own or the repo default.
_Avoid_: environment swap

**Environment selection**:
What a Task stores about its environment: the override and extra connectors.

**Runtime**:
Where a Task run executes: a repo devcontainer, a managed runtime or the worker's host. Every runtime runs against a fresh clone of the repo.
_Avoid_: execution mode

**Project secret**:
A named value saved in a project's settings that an environment refers to by name. A worker's own `.scarn/.env` value for that name wins; Scarn's saved value is used otherwise.
_Avoid_: token, credential (credential means a user's integration secret)

**Connector**:
A pre-built MCP server an environment turns on by id. It names the variables it needs, and the environment's variables provide them.
_Avoid_: integration (integration means Scarn's own sync)

**Connector catalog**:
The fixed list of connectors Scarn ships in code. An environment can only turn on connectors from it.
_Avoid_: marketplace, registry

**Extra connector**:
A catalog connector added to one Task on top of its environment's.
_Avoid_: ad-hoc connector

**Startup gate**:
The check before a run's first prompt that every connector and step MCP server reports `connected`. Any other status stops the run.
_Avoid_: health check (that's a step's own declared check)

### Managed connections

**Managed connection**:
A project's link to a hosted MCP server that a project admin authorized through OAuth, such as Notion. Scarn keeps its grant on its own servers and never hands a token to a route, a worker or an agent. A project has at most one per provider. See `docs/adr/0013-managed-mcp-connections.md`.
_Avoid_: project secret, OAuth secret, secret kind (a managed connection isn't a project secret: it has no name, no value anyone can read and isn't delivered to runs), integration (that's Scarn's own sync), connector (that's a catalog MCP server an environment turns on)

**Grant**:
The tokens, identity and granted scopes a provider issued to a managed connection, stored encrypted. The connection's active grant is the one it uses; it is replaced only when someone confirms a candidate grant, and deleted on disconnect.
_Avoid_: token, credential (credential means a user's integration secret), authorization

**Candidate grant**:
A grant that came back from the provider but hasn't been confirmed yet. Every one needs a person with `secrets:write` to confirm it after seeing the provider account, workspace and scopes, even on the first connect. During a reconnect the active grant keeps serving until it's confirmed. It expires 10 minutes after the callback.
_Avoid_: pending grant, new grant, draft

**Authorization attempt**:
One trip through the provider's OAuth consent, from the moment a person clicks connect or reconnect to the callback. It is bound to that person's browser session, the project, the connection and its generation, is single use and expires after 10 minutes. A successful one produces a candidate grant.
_Avoid_: OAuth session, flow, login, state (that's only its `state` parameter)

**Generation**:
A counter on a managed connection that goes up whenever the grant it serves changes: when a confirmed candidate replaces an active grant, and on disconnect. Anything bound to an older generation is stale.
_Avoid_: version (that's the row's compare-and-set counter), revision, epoch

**Credential version**:
A counter on a grant that goes up each time a refresh stores new tokens. It is part of the encryption's associated data, so ciphertext from before a refresh can't be written back or decrypted as the current tokens. Refreshing bumps the credential version and never changes the connection's generation: the connection still serves the same grant.
_Avoid_: generation (that changes only when the served grant is replaced or deleted), token version, key version

**Refresh claim**:
A mark on a grant, written to Postgres before Scarn sends the refresh token to the provider, saying one refresh is in flight. Only the holder of the claim may store the refreshed tokens; anyone else asking for a token while it's fresh is told to retry. A claim older than 30 seconds is presumed lost and moves the connection to `reconnect_required`, because the old refresh token may already have been used and is never sent again.
_Avoid_: lock, lease, mutex, refresh in progress

**Client metadata document**:
The JSON document Scarn's API serves to describe itself as an OAuth client. Its own URL is Scarn's `client_id`, so there's no registration with the provider and no client secret. There is one per environment.
_Avoid_: client registration, DCR (that's the fallback it replaces), CIMD (in prose)

**Connection auth**:
The `auth: { connection }` on a step's `ref` or `remote` MCP server entry, such as `auth: { connection: "notion" }`. It says the server is authenticated by the project's managed connection for that provider, in place of any headers or OAuth the definition has. It's the only way an execution may use a grant: nothing is attached because a URL happens to match, and environment connectors can't have it. The server itself stays an ordinary MCP server defined where it already is.
_Avoid_: managed server (the server is ordinary; only its auth is managed), connector (that's a catalog MCP server an environment turns on), binding, OAuth override

**Managed launch**:
A run's registration of the managed connections its step references, made by the worker with its claim token before the agent starts. It pins each connection's generation and grant; a relayed call or a seal is valid only while the connection is still serving that generation and grant. Re-registering under the same claim rotates its relay capabilities.
_Avoid_: session, lease (that's the run's claim), launch token

**Relay capability**:
The per-launch, per-connection bearer that lets the agent's MCP client reach Scarn's relay. Scarn stores only its digest. It can do nothing but relay that launch's calls to that connection, and stops working once the run stops `running`, its lease lapses, the launch closes or the connection's authority moves. The agent can read and copy it; that's accepted.
_Avoid_: token (it's not a provider token, and not the claim token), session

**Managed operation**:
One relayed call, recorded as a leased row from admission until the call ends. Its deadline is the call's limit plus 5 seconds of grace. A run can't seal while one is open, and one still present past its deadline is unknown and fails the run.
_Avoid_: request, call log, in-flight call

**Authority fence**:
The check at a run's seal (completion or yield), inside the transaction that locks the run, that every connection its launch pinned is still serving the same generation and grant, with no refresh claim on the grant and no open or unknown managed operation. If authority was lost first, the run fails with `ManagedConnectionAuthorityLost` and none of its work-item changes are applied; a seal that committed first is final.
_Avoid_: authority check, preflight, lifecycle check

### MCP tool steps

**MCP tool step**:
A step of kind `mcp_tool` that calls one tool on one MCP server, with no LLM. The worker runs it like a `code` step, calling the tool directly rather than through OpenCode. It's pure data (server, tool, args template, schemas) with no source file, so it can be defined anywhere, including a package. See `docs/adr/0014-mcp-tool-steps.md`.
_Avoid_: tool call step, MCP step, direct call, agentless agent step

**Tool catalog**:
A server's tool names plus their input and output schemas, generated by `scarn mcp pull` as `<server>Tools`. It has no server: how to connect stays in the user's own `defineMcp`, and one catalog can be bound to several servers.
_Avoid_: tool manifest, server bindings, generated MCP (it holds no connection config)

**Tool reference**:
One catalog entry bound to a server handle with `.withTools(catalog)`, such as `notion.tools.search`. Its `.step()` makes an MCP tool step.
_Avoid_: tool handle, bound tool, tool binding

**Tool lock**:
The raw `tools/list` snapshot a pull saves as `<server>.lock.json`, with a content hash. The tool catalog is generated from it, and `scarn mcp pull --check` compares it with a live listing.
_Avoid_: lockfile (that's the package manager's), tool cache (that's the API's in-memory listing)

**Tool call spec**:
The stored form of an MCP tool step's call: `{ server, tool, argsTemplate, toolSchemas }`. It's copied from the step definition onto its Task.
_Avoid_: tool config, call definition

**Args template**:
The JSON an MCP tool step compiles its `args` to, with `{{input.…}}` and `{{env.…}}` tokens. A value that is exactly one token becomes the raw typed value at run time; tokens inside a longer string are interpolated as text. Only input and the step's non-secret env can be templated.
_Avoid_: prompt (that's an agent step's), args mapping, tool input

**MCP content result**:
The built-in result of an MCP tool step whose tool has no output schema: `{ content, structuredContent }`, the tool's raw content blocks plus its structured content, or null.
_Avoid_: raw result, text result, tool output (that's a tool's declared output schema)

### Branches

**Base branch**:
The branch a run starts from. First match wins: the same Task's continued branch, the step's `baseBranch` when set, the previous step's work branch, the worker's `SCARN_BASE_WORK_BRANCH`, the project's `baseWorkBranch`, then the remote's default branch. Environments and workers don't choose it.
_Avoid_: source branch, environment branch

**Work branch**:
The branch a readWrite run commits to: a new `scarn/<key>-<id>` branch, or the base branch itself with `WorkBranch.base()`.
_Avoid_: feature branch, output branch

### Work items

**Label**:
A short name put on a work item to sort it, such as `bug` or `wayfinder:research`. Any work item can carry several. A synced work item's labels mirror its GitHub or Jira labels and belong to that tracker: they can't be changed in Scarn. Only a work item created in Scarn has labels that people and agents can add or remove.
_Avoid_: tag, category

**Ready**:
A work item that is open and has no open blockers. A work item becomes ready when it is created with no blockers, when its last open blocker closes, or when it is reopened with none.
_Avoid_: unblocked (that's only one way to become ready), available

**Needs a person**:
An open work item whose next move is a person's: its latest Task is waiting for a person, failed or was cancelled, or it is ready and has never had a Task.
_Avoid_: stuck, idle, unrouted

**Work item link**:
A link in a work item's description to another work item's page in the same project. It shows that work item's current status and title instead of the link's own text. It's how one work item refers to another, whether the other was created in Scarn or synced.
_Avoid_: reference, mention, short id, `#N` (for a work item created in Scarn)

### Automations

**Automation**:
A named set of rules with a scope. A work-item automation is attached to one work item and reacts to what happens to it and its child work items. A project automation reacts to what happens to any top-level work item in its project, and can also start steps on a schedule; child work items are left to their parent's automations. It is on from the moment it is pushed until someone disables it. Either kind reacts by starting steps or pipelines, or by attaching other automations. Unlike a pipeline, it has no graph and no run: it keeps reacting for as long as it is attached, until its work item closes.
_Avoid_: playbook, policy, workflow, child assignment, default pipeline assignment (that's now a project automation)

**Event**:
Something that happened, which an automation's rules react to, named as a subject and an action: a child work item became ready or closed, a work item was created, became ready or had a label added, the automation itself was attached, or a project automation's schedule came due (`schedule`).
_Avoid_: trigger, hook

**Rule**:
One part of an automation: an event and what to start for it, optionally chosen by routes that check the work item's labels and other properties. Every rule whose event happens fires.
_Avoid_: trigger (that's only the event half), handler

**Rule key**:
The required name of a rule, unique within its automation, such as `poll-acme`. Every rule has one, whatever its event. A schedule is found by its automation and rule key.
_Avoid_: rule id, rule name, index

**Schedule**:
A `schedule` rule in a project automation: a cron, a timezone (default `UTC`) and a concurrency limit, which starts one step on that cron. It can only route to a `step` or `skip`, never a pipeline or attach, because both need a work item. Publishing mirrors it into a schedule row keyed by automation and rule key; removing the rule removes the row, and publishing the key again makes a new schedule. See `docs/adr/0015-scheduled-task-is-a-task-without-work-item.md`.
_Avoid_: cron job, scheduled automation (the automation isn't scheduled, one rule is), trigger, timer

**Scheduled Task**:
A Task a schedule started. It has no work item and no conversation: it belongs to its schedule (`started_by_schedule_id`) and records the cron time it is for. Having no work item, it gets no activity lines, no blockers, no summary comment and only project-scoped grants. A schedule's history is its scheduled Tasks. See `docs/adr/0015-scheduled-task-is-a-task-without-work-item.md`.
_Avoid_: scheduled run (a Task has runs; this is the Task), cron run, job, schedule execution

**scheduledFor**:
The cron time a scheduled Task is for (`event.schedule.scheduledFor`, `tasks.scheduled_for`). When missed times collapse it's the latest due time; for Run now it's the moment someone pressed it. It is not when the tick happened.
_Avoid_: fired at, run at, tick time

**previousScheduledFor**:
The `scheduledFor` of the schedule's most recent succeeded Task, or null before the first success. It only moves on success, so a failed or skipped run widens the next run's window rather than losing items.
_Avoid_: last run, cursor, since

**Tick**:
One pass, once a minute, that claims due schedules, collapses any missed times into one run and starts a scheduled Task for each, or records a skip. A broken schedule is retried once per cron time, not every tick.
_Avoid_: poll, sweep, cron (that's the rule's expression)

**Run now**:
A person starting a schedule's step immediately, through the same path and concurrency check as the tick, with `scheduledFor` set to now. It works while the automation is disabled and doesn't move the next run.
_Avoid_: trigger, manual tick, test run

**Skip**:
A tick that came due but started nothing because the schedule's concurrency group was full. It is recorded in the schedule summary, not as an error. A Run now that would be dropped is refused instead.
_Avoid_: drop (that's the concurrency group's answer; a skip is how the tick records it), miss (a missed time is one the tick never saw, and collapses)

**Schedule summary**:
What is shown for a schedule in the automations list and `scarn automations`: cron, timezone, next run, last fired, last Task status, failure streak, last skip and last error. It's kept on the schedule row; there's no per-tick record.
_Avoid_: schedule history (that's its scheduled Tasks), status

**Project create grant**:
The step grant `create` with `project` scope, limited by labels: it lets a Task create top-level work items in its project, on platform `custom` keyed by a `platformKey` from the source system. A key the project already has returns that item, unchanged and with no `workItem.created`, rather than creating it twice. Like every non-native item, it can't be edited or relabelled in Scarn: it mirrors its source. A scheduled Task keeps only its step's `project` grants, so a `schedule` rule can't start a step with grants on `self` or `children`. It is how a scheduled Task makes work items for `workItem.created` automations to take on.
_Avoid_: grant alone (that's a managed connection's), child create (that's `create` scoped to `children`)

### Pipelines

**Overrule**:
A person changing which routes of a node were taken after a rule already routed it, with a reason. The step's result stays as it was. See `docs/adr/0012-overrule-routes.md`.
_Avoid_: override (in code, use `overrule` everywhere), force, skip

**Overridable route**:
A route the author marked `overridable: true` (directly or through `next`), meaning it's a judgement call a person may overrule.

### Wayfinding

**Map**:
A work item whose description charts the way from a fuzzy goal to its destination: what's decided, what's still fog and what's out of scope. Each of its child work items asks one question, and its labels say how that question gets answered.
_Avoid_: plan (that's what a map ends with), roadmap, ticket (say child work item)

**Frontier**:
A map's ready child work items: the questions that can be answered now. A Wayfinder word: the product's code speaks of ready child work items.
_Avoid_: ready queue, backlog, claimed (nothing claims a work item; a Task working on it is just a Task)

**Planner**:
The agent that charts a map: it folds its closed child work items' answers into the map and creates new ones. It never starts or waits on them; the map's automation does. Each round is a fresh Task that reads the map live and then charts, waits (changes nothing new) or finishes by writing the plan and closing the map.
_Avoid_: orchestrator, scheduler

### Asking about work

**Aside**:
A read-only standalone Task that a person starts to ask about a step run, carrying that run as a context reference. It never changes the run it is about.
_Avoid_: side question, side chat, sub work item, step message

**Conversation**:
The back-and-forth between a Task's agent and people. It holds turns and messages only, never what it is about.
_Avoid_: thread (in the UI, "thread" means a step's runs and messages)

**Chat**:
A project-level conversation in which a person asks an agent about the project's repo, without a work item or a pipeline. It is a Task with no work item, tied to its conversation from the start; each turn is a run of that Task. Having no work item, it gets none of a work item's behavior: no grants (not even `read` on `self`), no blockers, no concurrency group, no summary comment and no work item to notify about; its starter is the only person it waits on. See `docs/adr/0002-chat-is-a-task-without-work-item.md`.
Shown to users as a Task; the UI never says chat.
_Avoid_: repo conversation (that's the feature's name), thread, aside (that's about a step run), ask
