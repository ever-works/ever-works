---
id: fleet
title: Fleet (your own machines)
sidebar_label: Fleet
---

# Fleet

**Fleet** is the registry of machines that belong to you — the [Desktop App](./desktop-app.md) on your laptop, a headless node on a box you own, or the nodes of a Kubernetes cluster you configured. It is how the platform knows what compute you have, without you opening a port.

## Two kinds of node

| Kind           | How it appears                                                           | `persisted` |
| -------------- | ------------------------------------------------------------------------ | ----------- |
| `desktop-node` | The Desktop App, enrolled with a one-time token.                         | `true`      |
| `node`         | A headless node app, enrolled the same way.                              | `true`      |
| Cluster nodes  | Nodes of _your own_ configured cluster, merged in live and never stored. | `false`     |

Cluster nodes are read live from the cluster you configured; the platform's own managed cluster is excluded by a sentinel so you never see infrastructure that is not yours.

Enrolled nodes go **offline** after five minutes without a heartbeat.

## Enrolling a node

Enrollment is outbound-only: the node calls the platform, never the other way round. Nothing needs to be reachable from the internet.

0. **Install the node app** — `npm install -g ever-works-node` (Node.js ≥ 22). It is a single-file bundle published from `apps/node`; the unattended-run scripts (systemd unit, Windows service/scheduled-task installer) ship inside the package under `packaging/`.

1. **Mint a token** — **Settings → Fleet → Add node**, or

    ```
    POST /api/fleet/nodes/enrollment-token   { "name": "Mac mini", "kind": "node" }
    → { node, token, expiresInSec }
    ```

    The token is shown **exactly once** and only its SHA-256 is stored. It is single-use and expires in 15 minutes.

2. **Hand it to the node** — the node app calls the public route with the token as its credential:

    ```
    POST /api/fleet/enroll   { "token": "…", "platform": "linux/x64",
                               "version": "1.0.0", "capabilities": ["terminal","workspace"] }
    → { nodeId, secret, node }
    ```

    The heartbeat `secret` is likewise returned exactly once and stored only as a hash.

3. **The node reports in** — periodically:

    ```
    POST /api/fleet/heartbeat   { "nodeId": "…", "secret": "…", "capabilities": [...] }
    → { ok: true, node }
    ```

    Last-seen is **server-stamped**; a node never supplies its own clock.

Every invalid credential path — unknown token, expired token, already-consumed token, unknown node, wrong secret — answers one undifferentiated `401`. The response never says which check failed.

## Managing nodes

```
GET    /api/fleet/nodes              list mine (enrolled + live own-cluster), each with its current load
GET    /api/fleet/nodes/:id          one node + its recent job history (and the failed subset)
PATCH  /api/fleet/nodes/:id          { name?, disabled?, paused?, capabilities?, capabilitiesPinned? }
POST   /api/fleet/nodes/:id/drain    { drain } — drain / return to service, requeuing in-flight claims
POST   /api/fleet/nodes/:id/rotate   re-key the node; the replacement token is returned exactly once
DELETE /api/fleet/nodes/:id          remove the registration
```

The **node drawer** on the Fleet page (the details action on a row) renders the same job history: each job's kind, status, attempt count, queued reason, queued / started / completed times and duration, filterable by **All / Failed / Running**.

**Disabling drains.** A disabled node's heartbeats stop being accepted, so it goes quiet immediately rather than at the next sweep. Re-enabling puts it back to `offline` until its next accepted heartbeat proves it alive. Disabling a node that is still `enrolling` revokes its unused token.

Everything here is owner-scoped: another account's node id is indistinguishable from one that does not exist.

## Panic controls

Every control above is per node. Stopping six autonomous machines at 2am must not mean six drain calls or an ArgoCD sync, so three controls exist that act on the whole fleet — and they are three **different decisions**, kept on three different routes on purpose.

```
POST   /api/fleet/drain-all           owner: disable EVERY node I own, requeue their in-flight claims
POST   /api/fleet/cancel-in-flight    owner: { includeQueued? } cancel my running fleet jobs + their agent runs
GET    /api/fleet/kill-switch         any session: is the platform-wide stop flag set?
POST   /api/fleet/kill-switch/stop    platform admin: { reason? } set the stop flag
POST   /api/fleet/kill-switch/clear   platform admin: clear it and resume the runs it parked
GET    /api/fleet/kill-switch/audit   platform admin: ?limit — recent audit rows (actor + time)
```

**Drain all** is the per-node drain applied to every enrolled node you own (nodes still enrolling or already disabled are skipped). Nothing is cancelled: the work goes back to the queue and waits for a node that may take it. The Fleet page carries it under **Panic controls**.

**Cancel in-flight** is the explicit second step. It cancels every leased / running fleet job you own and the agent run behind each (run row first, then the job, the same order the per-run cancel uses). A node learns of it through its next refused heartbeat, so this is "cancel requested", not an instant kill — a job that is about to finish may still report. `includeQueued: true` extends it to queued jobs nothing has started. It is never implied by draining, and never by the stop flag.

**The global stop flag** is a DB-backed switch (`fleet_kill_switch`, one row) checked at three points before any new unit of work can start: the run dispatch gate (every new agent run is parked with `queuedReason: kill-switch`), the fleet run router (a run that reaches routing is refused, never sent to the cloud instead) and every lease request (a node polling for work gets an empty batch). Running work keeps running and keeps reporting; heartbeats and completions are not gated, so a stopped fleet can still settle. **Reads fail closed**: a flag that cannot be read — missing row, unreachable database — counts as set, and the Fleet page banner says so distinctly (`unverified`) so nobody goes looking for who threw the switch. Clearing the flag resumes the parked runs (bounded, best effort; runs without a Work wait for their schedule's next tick), and runs parked by the flag are exempt from the stuck-run sweeper for as long as it is set. Every set and clear, every drain-all and every cancel-in-flight writes one `fleet_audit` row with the actor and the time.

Setting and clearing the flag is a platform-admin operation (`User.isPlatformAdmin`); there is no button for it on the owner's Fleet page, only the banner. `FLEET_NODE_RUNTIME_ENABLED` is **not** a panic control: it is a routing selector, and work it turns away from the fleet runs in the cloud instead.

## Capabilities

A node advertises capability tags (up to 16) such as `terminal`, `workspace` or `docker`. These describe what the node can host.

> **Status.** Enrollment, heartbeats, the registry, the Fleet settings page **and scheduling Tasks onto your nodes** are shipped. Select the `node` job runtime (Settings → Job Runtime) and a node started with `ever-works-node start --work` leases and executes your Tasks' agent runs; a node advertising `claude-code` / `codex` can run the agent itself (see below).

## Connect a machine

Connecting a machine is the same three steps whichever node app you run: mint a one-time token on **Settings → Fleet → Add node**, hand it to the node app on the machine, and watch the row turn **Online** after its first heartbeat. The Add-node dialog shows the token once, together with a ready-to-run `ever-works-node enroll …` command, a QR code of that command and a downloadable handoff file, so nothing has to be retyped on the target machine.

Both node apps live in this repository and are **built from source** today. There is no published npm package and no signed installer yet: `ever-works-node` is still marked `private`, and the desktop packaging is unsigned by design.

### Desktop node (`apps/desktop-node`)

A thin Electron shell that registers _this_ machine as a node and keeps it heartbeating from a small status window and a tray icon. First launch runs a setup wizard: choose the API host (a local all-in-one desktop install, a self-hosted URL, or the cloud), paste the enrollment token, enroll. Closing the window minimises to the tray, and an already-enrolled machine starts heartbeating on launch without the window ever being opened. The heartbeat secret never leaves the Electron main process — the renderer only learns that a credential exists.

Build and run it from a checkout:

```bash
pnpm build:node                                # the shared node core it depends on
pnpm build:desktop-node                        # type-check + main-process build + renderer build
pnpm approve-builds                            # one-time: allow the `electron` install script (pnpm skips it by default)
pnpm --filter ever-works-desktop-node start    # electron .
```

`pnpm --filter ever-works-desktop-node dist` produces unsigned electron-builder packages for Windows, macOS and Linux. Details, layout and security posture: `apps/desktop-node/README.md`.

### Headless node (`apps/node`)

A CLI and long-running service for servers, CI boxes and scripted fleets — no UI. It also owns the shared node core the desktop app reuses, so the two shells cannot drift apart.

```bash
pnpm build:node
node apps/node/dist/cli.js enroll --api-url https://api.example.com --token <one-time-token>
node apps/node/dist/cli.js start --work
```

`start` alone only heartbeats; **`--work`** is the separate consent that lets the machine lease and execute platform jobs. `pause` / `resume` drain and undrain it, `unenroll` retires it, `status` and `capabilities` inspect it. Until the package is published, the binary is `apps/node/dist/cli.js` — the unattended-install scripts (systemd unit, Windows service, container image, in `apps/node/packaging/README.md`) expect a command named `ever-works-node` on `PATH`. The full command reference, the config-file and keychain layout, and the capability tags a node reports are in `apps/node/README.md`.

A node also looks after its own disk. It refuses to lease (and to provision) while the volume holding its workspace root has less than a **disk floor** free — 2 GiB by default, `--min-free-disk <mb>` to change it — and shows up as `throttled` with the reason, so a full machine stops taking work before a job fails halfway through a fetch. With `--work` it also runs a **workspace reaper** that removes Task worktrees it can prove are safe to remove (owned, not in use, clean, fully pushed, and with a branch that is gone from the remote or merged) once they are older than `--workspace-max-age` (14 days by default); anything it cannot prove stays. `ever-works-node doctor` prints the free space against the floor and what the reaper would do, `ever-works-node gc [--dry-run]` runs it by hand. Details and the exact rules: `apps/node/README.md`, "Disk floor and workspace GC".

### Pin an agent to a node

Open the agent → **Capabilities** → **Execution** and pick a **Preferred node**. The binding (`PUT` / `DELETE /api/fleet/agents/:agentId/node-affinity`) is scoped to the active Organization on top of your account, so it is available for Organization agents; a personal workspace cannot pin an agent, and the section says so.

With a node chosen, every `agent-task` job dispatched for that agent is stamped with that node when it is enqueued and is leased **only** by that machine — choose the node that holds the checkout, the credentials or the hardware the work needs. A pinned job does not fail when its machine is offline or drained: it **waits**, and the picker shows a hint whenever the chosen node is in either state. **Any node** (the default) lets whichever of your machines is free take the work. Jobs already queued keep the node they were enqueued for; changing or clearing the binding affects future jobs only. Removing a node from the Fleet does **not** clear the bindings that point at it: an agent pinned to a removed machine keeps waiting, so the picker keeps naming that binding — and lets you clear it or pick another node — even when it was your last enrolled machine.

### What the execution preferences mean

**Settings → Fleet → Execution routing** decides where a run goes when you have runners enrolled. It is set per account, and a Work or a Goal can override it — the narrowest setting wins.

| Mode                         | A runner is free   | No runner can take the work                                                      |
| ---------------------------- | ------------------ | -------------------------------------------------------------------------------- |
| `local-wait`                 | Runs on your fleet | Waits in the fleet queue (`waiting-for-runner`); never moves to the cloud        |
| `local-fallback` _(default)_ | Runs on your fleet | Runs on the platform runtime instead, and you get a fallback notification        |
| `cloud`                      | Platform runtime   | Platform runtime — an explicit opt-out for work you do not want on your machines |

`local-wait` is for work that is only correct on that machine; `local-fallback` is the default because its failure mode is "slower, elsewhere" rather than "nothing ran". The preference chooses fleet-vs-cloud only for an account whose resolved job runtime is the fleet, and it never overrides the `FLEET_NODE_RUNTIME_ENABLED` routing selector (which sends work to the cloud, not nowhere — the control that stops work is the global stop flag under **Panic controls** above). The agent's **Capabilities → Execution** section shows the account-wide rule in force, read-only, with a link back to Settings → Fleet to change it.

## Running agents on your machines

With the `node` runtime selected, every Task run dispatched to an Agent becomes a fleet job. Two execution modes exist, chosen per tenant under **Settings → Job Runtime → Fleet Node Job Runtime**:

| Mode                | What the node does                                                                                                                                                                                                                                                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `command` (default) | Runs the operator's _Agent task command_ template (`{taskId}`, `{runId}`, `{agentId}` placeholders) and reports the exit code. Unchanged from the first Fleet release.                                                                                                                                                                                                   |
| `model-cli`         | The platform assembles the Agent's instructions (identity, role, skills, the Task brief, the acceptance checks) and the node runs a **local Claude Code or Codex** on them inside an isolated Git worktree of the Task's Work repository, grades the acceptance checks, then commits and pushes the task branch. The model runs on your machine with your own CLI login. |

`model-cli` settings: the CLI (`claude-code` / `codex`), model, effort, permission mode, per-run timeout and dollar cap, and whether unattended runs may skip the CLI's permission prompts. A model-cli job is only offered to nodes that advertise the matching `claude-code` / `codex` capability tag — the tag is backed by an executable the node resolved at startup (`EVER_WORKS_NODE_CLAUDE_PATH` / `EVER_WORKS_NODE_CODEX_PATH`, or PATH), so a job never lands on a machine that cannot run it.

When the node reports, the platform reconciles the result the same way a cloud run is reconciled: the run is marked started when the node leases the job and completed or failed when it reports (with the CLI's final message as the run summary and the acceptance-check verdicts on the run), the pushed task branch becomes a pull request (or is handed to a human when the Agent may not open one) and the Task moves to _In review_, the Agent posts the fleet report to the Task chat, a failure files an Inbox notice, and parked runs on the Work are drained. **Cancelling a run** cancels the fleet job too: a job no node has claimed is dropped; a job a node is executing is flagged, the node's next job heartbeat is refused, and the node aborts the CLI and reports.

Routing preferences (**Settings → Fleet → Execution routing**) decide what happens when no runner is free: wait for one (`local-wait`), fall back to the cloud with a notice (`local-fallback`), or always use the cloud. An Agent can be pinned to one specific node (`PUT /api/fleet/agents/:agentId/node-affinity`); a pinned Agent never runs elsewhere.

### Tasks that span several repositories

A Task keeps one primary Work and branch. When the run agent has **repository attachments** (Agent →
Capabilities → Repositories, backed by the repository registry), or the Task itself lists extra
repositories (**Also work in** on the new-task form and the task page — registry connections, a Task
entry wins over an agent attachment for the same repository or directory), a fleet run checks those
repositories out next to the primary worktree, at `.mounts/<name>` inside it, each on the same Task branch name. The
model is told exactly where each repository is; it edits them in place. When the run finishes the node
commits and pushes every repository that changed, the platform opens **one pull request per
repository** (each one linked to the primary's), records the extra ones on the Task ("Also in" on the
branch panel), and sends one Inbox notice listing every pull request to review.

Limits: at most 8 mounted repositories per Task; a mount is never the primary repository; the mounts
directory is excluded from the primary repository's Git, so nothing about the layout is ever committed.
A repository the platform cannot describe (a URL that is not `owner/repository`, a default branch it
cannot read) fails the plan naming the attachment rather than silently running without it.

### When the agent needs you

The agent on your machine has no platform tools — it cannot message you mid-run. What it can do is
**pause the run with a question**: when it hits a decision only you can make (an ambiguous
requirement, a risky or irreversible step, a choice between materially different directions) it
writes `.ever-works/QUESTION.md` in the repository root — the first line (or a `# ` heading) is the
question, the rest is optional context and options — and stops. The node reports the question and
removes the file. It is never committed: the `.ever-works/` directory is excluded from Git — at the
repository root and in any subdirectory — the same way `.mounts/` is, in every repository of the
workspace, and a stale file from an earlier attempt is discarded before the model starts. Only a
plain file is read: a link, a directory or a pipe at that path is removed without being opened.

What happens next:

- The run shows as **awaiting input** on the Task page and in the Runs history (its summary reads
  "Paused with a question for the owner: …"). It is not a failure, whatever the acceptance checks
  said — the platform records the check and model verdicts on the run and waits for you.
- Whatever the agent did so far is **committed and pushed on the Task branch** (when the Agent's git
  policy allows pushing), but **no pull request is opened and the Task does not move to _In
  review_**: the work is partial by definition. Pushed mounted repositories are recorded on the Task
  as pushed, without a pull request either.
- The question lands in your **Inbox** tagged **From your fleet**, with the node it ran on, the
  Task, the branch (and the mounted repository, if the agent asked from one), and a link to an
  existing pull request. The Inbox body also says what the run managed before asking (pushed,
  committed but not pushed, no changes, a failed push) and which required checks did not pass.
- **Replying starts a new run for the same Task** — same Agent, same pinned node when the Agent is
  pinned, same branch. The new run's instructions carry your question and answer under
  **`# OWNER ANSWER`**, tell the model its earlier commits are on the branch (and whether they were
  pushed), and ask it to continue from the answer rather than redo committed work or ask again. The
  reply toast says "a new run is answering it".
- The **Task page** shows the open question with an _Answer it in the Inbox_ link and hides the
  free-text _Resume_ while a question is open: a resume from there would start a run that never sees
  your answer.
- **Archiving** (or deleting) the open question drops the parked run — it stops waiting and the Task
  page returns to normal. Moving the question back to Active parks it again.

Limits: one question per run (the answer run can ask a new one, which files a new Inbox message);
answers are free text — a fleet question offers no option buttons; earlier questions and answers are
not replayed into later runs, only the reply that resumed the run travels with it; asking needs an
edit-capable permission mode — under `plan` the model cannot write the file and is not offered the
protocol; a Task that is _Done_ or _Cancelled_ cannot be resumed — the reply is refused with the
reason, the question stays open until you archive it; an Agent whose git policy forbids pushing may
lose uncommitted work when the answer run lands on a different node, because that node starts from
the base ref — the `# OWNER ANSWER` section tells the model when that is the case; a question file
written somewhere other than the repository root (or a mounted repository's root) is kept out of Git
but is not reported as a question.

## Related

- [Desktop App](./desktop-app.md) · [Workers](./workers.md) · [Kubernetes Deployment](./k8s-deployment.md)
