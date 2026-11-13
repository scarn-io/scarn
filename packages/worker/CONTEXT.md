# Worker

The client-side worker: the process on a user's machine that claims Task runs
for the projects added to it and runs each one in that project's
devcontainer. Run decisions such as advancing, retrying and cancelling are the
server's; the worker only does the work and reports back.

## Language

### The background worker

**Background worker**:
The long-running process for one instance on one machine. It runs every
project added to it and is controlled only by `scarn worker` commands on the
same machine.
_Avoid_: daemon, service, agent, host (in prose; `worker-host` is only a code folder)

**Instance**:
The name that keeps one background worker apart from another on the same
machine: `scarn` or `scarn-dev`, or the value of `SCARN_WORKER_INSTANCE`. It
decides the state directory, which saved projects are loaded and which
server the worker talks to.
_Avoid_: profile, environment

**Supervisor**:
The part of a background worker that owns its project workers, starts and
stops them, and answers the control API.
_Avoid_: manager, orchestrator

**Project worker**:
One added project inside a background worker, running one loop that claims
and runs that project's Task runs. A project has at most one in an instance.
_Avoid_: project loop (in prose), sub-worker, child worker

**Added project**:
A project whose settings are saved for an instance, so it gets a project
worker whenever that instance's background worker runs. Adding it again
updates its settings; removing it deletes them.
_Avoid_: registered project, subscribed project

**One-shot run**:
A worker started in the terminal for one project that polls once, waits for
the runs it claimed and exits. It saves nothing and has no control API.
_Avoid_: `work --once` (the old command)

### Concurrency

**Slot**:
One unit of run concurrency on a machine. A run holds a slot from just before
it's claimed until its teardown ends.
_Avoid_: lock, queue, claim (`packages/core/CONTEXT.md` reserves those for the concurrency group), token, permit

**Machine limit**:
How many slots a background worker hands out across all of its projects at
once.
_Avoid_: global concurrency, max workers

**Project limit**:
An optional cap on the slots one added project may hold, within the machine
limit. Lowering either limit only affects claims made after it.
_Avoid_: per-project concurrency (in prose)

**Slot lease**:
Slots a one-shot run borrows from its instance's running background worker
so both stay within one machine limit. A lease that stops being renewed
expires and its slots go back.
_Avoid_: reservation, loan

### Control

**Control API**:
The background worker's local HTTP interface, which only `scarn worker`
commands and one-shot runs on the same machine use.
_Avoid_: daemon API, admin API, local server

**Discovery file**:
The private file an instance's background worker writes while it runs, which
tells the CLI where its control API listens and how to authenticate.
_Avoid_: pid file, lock file (that's a different file)

**Worker log**:
The rotating log of one instance's background worker, covering every
project worker and run in it.
_Avoid_: task log (that's one run's output, kept on the server), daemon log

**Run registry**:
The background worker's record of the runs it has in flight, which is how a
single run is found and stopped without stopping the others.
_Avoid_: job list, active jobs

### Stopping

**Drain**:
Stop claiming new work and let the runs already going finish. It's what
stopping the worker, removing a project or lowering a limit does by default.
_Avoid_: graceful shutdown, pause

**Force stop**:
Stop the worker by aborting every run it has in flight. Each aborted run is
reported `failed` with the code `WORKER_STOPPED`.
_Avoid_: kill, hard stop

**Worker cancel**:
Cancelling one run's Task on the server and then stopping that run on this
machine straight away instead of at its next heartbeat.
_Avoid_: local cancel, abort (that's only the local half)
