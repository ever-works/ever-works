---
id: agent-terminals
title: Live Agent Terminals
sidebar_label: Agent Terminals
description: Attach a real, typable terminal to a live agent run — take the keyboard, watch read-only, and replay the transcript after the run ends.
---

# Live Agent Terminals

A **terminal session** is a real shell, streamed live from the machine that is executing an [Agent](./agents.md) run, into a terminal pane in your browser. You can watch the bytes as they are produced, type into the session, resize it, and — after the run is over — replay what it printed.

It is the answer to "what is this Agent actually doing right now, and can I take over?" [Steering](./sessions-and-steering.md) sends the Agent a message it reads between tool calls; a terminal puts you _on the box_, at a prompt, in the same working directory the run is using.

The session identity is the run: **the AgentRun id IS the relay channel id**. There is no separate "terminal id" to keep track of — you pick a run, and you are attached to exactly that run's session (live) or to its pinned exit state (finished).

:::info Status — what ships today
Shipped and documented on this page: the frozen wire protocol, the relay (WebSocket gateway + registry), the worker-side session host, the `pty-local` provider, the Terminal tab and pane, the attach links across the Sessions and Task views, and persisted, redacted, retention-capped transcripts.

Three things deliberately do **not** exist yet, and this page never assumes them:

- **Only the run owner can attach.** Who _else_ may join (Work members, a per-Agent guardrail flag) is a later milestone. Until it lands the routes fail closed: a non-owner gets the same `404` as a run that does not exist.
- **The dashboard always attaches you as the driver.** The read-only `viewer` role is real and enforced server-side, and the pane renders a read-only badge for it, but the Terminal tab has no "watch only" toggle — mint a viewer attach through the API (`?role=viewer`) to use it today.
- **Normal task runs do not stream through a session.** A one-shot [Task](./tasks.md) run still captures its output the way it always did; a terminal is something you start explicitly on a live run. Routing a CLI pipeline's execution through a session is a follow-up milestone.

A session is also hard-capped at **one hour** of wall-clock time by the job that hosts it — park and resume for genuinely long-lived sessions is not shipped.
:::

:::note Where to find it
**Sidebar → Teams → Agents** tab → open any Agent → the **Terminal** tab (`/agents/:id/terminal`).

Deep links carry the run: `/agents/:id/terminal?run=<runId>`. Three places link straight into it, each gated on the server's own joinability verdict:

- the **Sessions** list (`/agents/sessions`) — an **Attach** link on every attachable row,
- the **session detail** page (`/agents/sessions/:runId`) — **Open terminal** in the header,
- the **Task detail** run controls — the terminal icon beside **Steer**, **Interrupt** and **Resume**.

With no runs at all the tab says so: _"No runs yet — terminals attach to agent runs."_
:::

## How to open a terminal on a run

1. Start (or find) a run that is still open. A terminal can only be attached to a run whose status is `queued` or `running` — a finished run has no worker, no workspace, and nothing to drive.
2. Go to **Agents → your Agent → Terminal**. The **Run** picker lists that Agent's 20 most recent runs as `timestamp · trigger kind · status`; pick the one you want, or arrive with `?run=<runId>` already selected.
3. Press **Start session**. The dashboard calls `POST /api/agents/:id/runs/:runId/terminal/start`, which dispatches the `terminal-session` job and answers `202`. The status bar shows **Connecting…**, then a green **Live** dot once the pane is attached.
4. Type. Keystrokes travel as `stdin` frames; resizing the pane (or the browser window) sends a `resize` frame, debounced by 120 ms.
5. When the process exits, the pane shows **Session ended (`reason`)** and a **Reconnect** button. Reconnect re-runs the whole attach flow — including the transcript replay — so a closed tab is never a lost session.

If **Start session** fails, the API's own message is shown verbatim, because those messages are the useful ones:

| What you see                                                                        | Why                                                                              |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| _already has a live terminal session — attach to it instead_                        | A session is already resident for this run. Attach to it; do not start a second. |
| _has finished — a terminal session can only be started for a queued or running run_ | The run reached a terminal status while you were looking at it.                  |
| _Terminal sessions are unavailable on this install_                                 | No background job runtime is wired — see [Workers](./workers.md).                |

## The pane, state by state

The pane runs a five-state machine, and every state renders visibly differently. `refused` (a permissions answer) and `cannot-connect` (an infrastructure answer) are deliberately never collapsed into one "error".

| State            | Status bar                                                                         | What it means                                                         |
| ---------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `starting`       | Spinner · _Connecting…_                                                            | Minting the attach token, replaying history, opening the socket.      |
| `attached`       | Green dot · _Live_ (plus a `read-only` badge for a viewer)                         | Replay landed, the live tail is streaming.                            |
| `ended`          | Grey dot · _Session ended (reason)_ + **Reconnect**                                | The pinned `exit` frame arrived. The reason is one of the four below. |
| `cannot-connect` | Amber warning · _terminal streaming is not available for this run_ + **Reconnect** | No provider, socket failure, or the token endpoint answered `503`.    |
| `refused`        | Red shield · _You do not have access to this terminal._                            | Authorization said no (`401`, `403` or `404`).                        |

Until the first byte arrives an overlay reads _Waiting for output…_ — a black rectangle is never left to speak for itself.

Rendering is xterm.js, loaded only when a pane mounts, with 5,000 lines of in-browser scrollback and a dependency-free DOM renderer as the floor if xterm fails to load.

### Why a session ended

| `reason`    | Meaning                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| `completed` | The child process exited on its own.                                                                 |
| `crashed`   | Spawn failure, pump failure, or the heartbeat sweeper's verdict on a session that stopped reporting. |
| `closed`    | An authorized party explicitly ended the session.                                                    |
| `parked`    | The platform stopped an idle process but kept the conversation resumable.                            |

## Driver and viewer

Two browser-facing roles, both enforced by the relay rather than by the UI:

| Role     | Minted by      | Can type / resize | Sees output | Notes                                                                |
| -------- | -------------- | ----------------- | ----------- | -------------------------------------------------------------------- |
| `driver` | default        | yes               | yes         | What the Terminal tab always asks for.                               |
| `viewer` | `?role=viewer` | no                | yes         | Input is refused with an `error` frame answered to the sender alone. |
| `worker` | internal only  | n/a               | n/a         | The publishing side. A browser can never be minted this role.        |

A request may **downgrade** itself and never upgrade: `worker` and every unrecognised value collapse to `driver`, which the caller was already authorized for. Asking for `viewer` is how a second tab — or a second person, once non-owner attach ships — watches a live session without fighting the driver for the keyboard.

## How the streaming actually works

Four layers, each with one job, joined by a single frozen frame protocol shared by the plugin, the worker, the API and the browser:

```mermaid
flowchart LR
    P[pty-local provider<br/>real PTY in the worker] -->|stdout frames| H[Worker session host<br/>batched publish + 60s heartbeat]
    H -->|POST /api/internal/terminal/:runId/frames| R[Relay registry<br/>scrollback · banners · pinned exit · seq gate]
    R -->|WebSocket fan-out| B[Terminal pane<br/>xterm.js]
    B -->|stdin / resize| G[WS gateway<br/>/ws/terminal/:runId]
    G -->|role-checked| R
    R -.->|redacted stdout| T[(terminal transcript chunks)]
    T -.->|replay on attach| B
```

- **The provider** owns _where and how_ the process runs, and never talks to a browser. The first-party [plugin](./plugins.md) `pty-local` ("Local PTY Terminal Host", capability `terminal-stream`, the default provider for that capability) spawns a real PTY inside the executing worker, and degrades to a plain piped child process when the native PTY prebuild is unavailable. The pipe floor still streams bytes but cannot resize, so the handle reports `isPty: false` and the UI stays honest about it.
- **The worker session host** builds the byte path: it mints its own worker attach token, opens the inbound WebSocket, publishes outbound frames in small frequent batches, beats a heartbeat every 60 seconds, and transitions the run's terminal lifecycle `starting` → `attached` → `ended`.
- **The relay** (registry plus gateway, both in the API) owns fan-out and history. Every accepted `stdout` frame lands in a rolling **512 KiB** scrollback (decoded bytes, oldest evicted first) that any attach replays. `error` frames published while nobody is attached are retained as **banners** (up to 64) and replayed to _every_ future attach, so a session that failed before producing a single byte still explains itself to a viewer arriving late. The `exit` frame is **pinned** — never evictable, always replayed last — so a pane can always learn the session is over. Stale or duplicate sequence numbers from a publisher retry are dropped at the door.
- **The pane** replays the durable transcript first, records the highest sequence number it rendered, then opens the socket and drops any live or relay-replayed frame at or below that sequence — which is why rehydrated output never double-prints.

### The wire protocol

Six frame kinds, each valid in exactly one direction — so a replayed `stdout` can never be smuggled back into a session as keystrokes, and a client can never inject fake output:

| Frame    | Direction       | Payload                                                            |
| -------- | --------------- | ------------------------------------------------------------------ |
| `auth`   | client → server | `token` (≤ 4096 chars) — the mandatory first message.              |
| `stdin`  | client → server | `data`, base64 keystrokes.                                         |
| `resize` | client → server | `cols` and `rows` — integers from 1 to 1000.                       |
| `stdout` | server → client | `seq` (monotonic per session) plus `data`, base64 raw PTY bytes.   |
| `exit`   | server → client | `code` plus `reason` (`completed`, `crashed`, `closed`, `parked`). |
| `error`  | server → client | `message` (≤ 8192 chars) — banner text, never terminal bytes.      |

A single frame is capped at **1 MiB** and rejected on size _before_ it is ever parsed. Every decode helper returns `null` rather than throwing, and decoding rebuilds the frame field by field, so unknown or `__proto__`-style keys never survive validation.

### The socket

The gateway is hosted on the API's own HTTP server at `/ws/terminal/:runId`, so cloud and local behave identically: `wss://api.…/ws/terminal/:runId` in Kubernetes, `ws://localhost:3100/…` under `pnpm dev:api`.

- The upgrade path must match `/ws/terminal/<uuid>`. **A query string on the upgrade is refused outright** — attach tokens ride the first frame, never the URL, so they stay out of proxy and access logs.
- The first message must be a valid `auth` frame for _this_ run. A socket that has not authenticated within 5 seconds is closed with code `4001`.
- A ping every 30 seconds keeps quiet sessions from being reaped by proxy idle timeouts (Cloudflare's is roughly 100 seconds) and drops peers that miss two pongs.

## Where the shell actually runs

Starting a session dispatches the `terminal-session` job onto whatever [job runtime](./workers.md) this install is configured with, and the PTY is spawned **inside that worker process**. Two consequences are worth knowing:

- **The working directory is the run's.** When the run has an isolated worktree ([Task isolation](./task-isolation.md)) the session opens in it; otherwise it opens in the worker's own current directory. The path is resolved job-side, because that is the only machine that can answer the question.
- **The command is operator configuration, not caller input.** `POST …/terminal/start` accepts no argv. The session executes whatever `TERMINAL_SESSION_COMMAND` names (a JSON array or a whitespace-separated string, capped at 32 arguments), defaulting to `/bin/bash -i` — the worker image is Linux, and the default is deliberately not taken from the API host's platform. An unparseable value falls back to the default rather than breaking the feature. This is what keeps the Terminal tab from being a general remote-exec endpoint.

The provider is resolved through the `terminal-stream` capability rather than hard-wired: the API asks the facade which provider applies for the user, Agent and Work scope, and the resolved id rides the dispatch so both processes host the same one. Resolution is advisory — an install with nothing enabled still gets a session, from the worker's bundled `pty-local` floor.

:::caution Self-hosting notes

- **`pty-local` is the only `terminal-stream` provider that ships.** The capability exists so an SSH host, a `kubectl exec` host, or your own provider can be dropped in without touching the relay, but no such plugin is bundled today.
- **Fleet nodes advertise a `terminal` capability tag** ([Fleet](./fleet.md)), meaning the machine is capable of hosting a local session. Terminal sessions are dispatched onto the configured job runtime, not scheduled onto an enrolled node.
- **The relay registry is per-process.** Single-API-replica deployments (the default) need nothing extra. Cross-replica fan-out is a declared seam with an in-process no-op default, so scaling the API horizontally needs a real bus implementation injected before a driver on one replica can reach a session hosted against another.
- **Attach tokens fail closed.** Minting requires `TERMINAL_ATTACH_SECRET`, or the Better Auth secret every install already has (`BETTER_AUTH_SECRET` / `AUTH_SECRET`), at least 16 characters long. With neither set, minting answers `503` and verification refuses everything — an unsecured relay refuses attaches rather than accepting all of them.
- **Internal publish is secret-gated.** The worker's frame-publish, worker-token and heartbeat endpoints authenticate with the platform's internal trigger secret, compared in constant time, and refuse every request when that secret is unconfigured.

:::

### When a worker dies

The session host heartbeats every 60 seconds. The run sweeper reaps any run whose terminal still claims to be live but whose heartbeat went stale for **5 minutes**, marks it `ended` / `crashed`, and best-effort publishes a pinned `exit` frame through the relay — so a crashed pod produces "session ended (crashed)" in the pane rather than a frozen one.

That is also why the **Attach** links are gated on a server-computed verdict rather than on the stored terminal state alone: a link is offered only when the run is still `queued` or `running` _and_ its terminal state is `starting` or `attached`.

## Transcripts

Relay scrollback is in-memory, byte-bounded, and dies with the replica. Transcripts are the durable record: stored server-side, tenant-scoped, **secret-redacted**, and retention-capped.

- **Only `stdout` is stored** — one row per accepted frame, keyed on `(runId, seq)` so the writer is idempotent under the worker's split-and-retry. Deleting a run deletes its transcript.
- **Redaction happens at a single ingest chokepoint**, before anything reaches storage: the platform's canonical secret scanner (prefixed tokens, JWTs, PEM blocks) plus terminal-specific shapes it cannot see — `DEPLOY_TOKEN=…` style assignments, `https://user:password@host` URLs, `Authorization: Basic …` headers, and `--password` / `--token` flag values. Each is replaced with `[redacted secret]`, keeping the identifying prefix so the transcript still reads as a transcript.
- **Retention is a plan-tier lever**, seeded per plan and swept nightly by the `terminal-transcript-gc` cron at 03:17 UTC. The sweep resolves each run's owner plan individually, so a plan change shortens already-stored transcripts on the next pass — and a tier lookup that fails deletes nothing.

| Seeded plan | `terminal-transcript-retention-days` | Effect                                |
| ----------- | ------------------------------------ | ------------------------------------- |
| free        | `0`                                  | Nothing is written at all.            |
| standard    | `30`                                 | Chunks older than 30 days are pruned. |
| premium     | `-1`                                 | Kept forever, never swept.            |

An unrecognised plan code falls back to `0` — an install must never start silently retaining terminal output for a tier nobody configured. Operators can turn persistence off entirely with `TERMINAL_TRANSCRIPT_PERSISTENCE=off`; the relay keeps streaming live either way.

Replay is paginated and doubly capped — 500 chunks and 512 KiB of text per page by default — so a run that printed a gigabyte can never be replayed in one response. The pane pages through at most 20 pages on attach.

## API

Every route below is nested under the agent-run resource and authorized identically: Agent ownership, then a user-scoped run lookup, then an `agentId` match. A cross-user or cross-agent run id answers `404` with **no existence leak** — never `403`.

| Route                                                    | Answers                                                                                                      | Rate limit |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------- |
| `POST /api/agents/:id/runs/:runId/terminal/attach-token` | `201` `{ token, wsPath, role, expiresInSec }`; `?role=viewer` for read-only; `503` when unconfigured         | 30/min     |
| `POST /api/agents/:id/runs/:runId/terminal/start`        | `202` `{ started, runId, state: 'starting' }`; `409` already live or run finished; `503` when no job runtime | 10/min     |
| `GET /api/agents/:id/runs/:runId/terminal`               | `200` — the live relay view merged with the persisted run columns                                            | default    |
| `GET /api/agents/:id/runs/:runId/terminal/transcript`    | `200` `{ runId, chunks, lastSeq, hasMore, total }`; `?fromSeq=` and `?limit=`                                | 60/min     |

Mint a token and open the socket:

```bash
curl -sX POST \
  -H "Authorization: Bearer $EVER_WORKS_API_KEY" \
  "$API/api/agents/$AGENT_ID/runs/$RUN_ID/terminal/attach-token?role=viewer"
# → { "token": "…", "wsPath": "/ws/terminal/<runId>", "role": "viewer", "expiresInSec": 60 }
```

The token is a compact HMAC-SHA256 credential — deliberately not your session token — valid for **60 seconds**, scoped to exactly one run's terminal, and presented as the first WebSocket message:

```json
{ "kind": "auth", "token": "…" }
```

The status route answers both halves of the truth: what the relay can see right now, and what survived a restart.

```json
{
	"exists": true,
	"ended": false,
	"exitReason": null,
	"clientCount": 2,
	"viewerCount": 1,
	"lastSeq": 941,
	"run": {
		"persistent": true,
		"terminalState": "attached",
		"terminalEndedReason": null,
		"terminalProviderId": "pty-local",
		"hasCliSession": true,
		"lastHeartbeatAt": "2026-09-02T10:14:31.000Z",
		"lastFrameSeq": 941
	}
}
```

`terminalState` is `starting`, `attached` or `ended`; `terminalEndedReason` is one of the four exit reasons. `hasCliSession` is presence only — the provider-minted resume id itself never leaves the server, so a leaked status payload can never be replayed into somebody else's session.

Replay a finished run's transcript:

```bash
curl -s -H "Authorization: Bearer $EVER_WORKS_API_KEY" \
  "$API/api/agents/$AGENT_ID/runs/$RUN_ID/terminal/transcript?fromSeq=0"
# → { "runId": "…", "chunks": [ { "seq": 0, "direction": "out", "text": "…", "createdAt": "…" } ],
#     "lastSeq": 499, "hasMore": true, "total": 1204 }
```

Page with `?fromSeq=<lastSeq + 1>` for as long as `hasMore` is true.

## Security properties

| Property                             | How it is enforced                                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Owner-only attach                    | Agent ownership plus a user-scoped run lookup plus an `agentId` match on every route; non-owners get `404`, not `403`.   |
| Short-lived, single-run tokens       | A 60-second HMAC token carrying only `userId`, `runId`, `role` and an expiry; verified in constant time.                 |
| Tokens never in a URL                | Carried in the first frame; a query string on the WebSocket upgrade is refused outright.                                 |
| Read-only really is read-only        | Viewer `stdin` and `resize` are refused by the relay and answered with an `error` frame to the sender alone.             |
| No remote-exec surface               | The session argv is operator configuration; the start endpoint accepts no command.                                       |
| Output can only come from the worker | The registry refuses client-direction frames on the publish leg, and server-direction frames on the inbound leg.         |
| Internal endpoints fail closed       | Frame publish, worker tokens and heartbeats require the internal secret; unconfigured means every publish is refused.    |
| Heartbeat fields are whitelisted     | A worker payload can touch only the terminal columns, only with known values; the last-seen timestamp is server-stamped. |
| Stored output is redacted            | Every chunk passes the terminal redaction chokepoint before the insert.                                                  |

## Related

- [Sessions & Run Steering](./sessions-and-steering.md) — the Sessions list, steering, interrupt and resume around every run a terminal attaches to.
- [Task Isolation (worktree per Task)](./task-isolation.md) — the branch and checkout a session's working directory points at.
- [Fleet (your own machines)](./fleet.md) — the node registry, its `terminal` capability tag, and enrollment.
- [Agents (Your AI Employees)](./agents.md) — the Agent the runs belong to, and its detail tabs.
- [Workers](./workers.md) — the job runtime that hosts the `terminal-session` job.
- [Plugins](./plugins.md) — the `terminal-stream` capability and the `pty-local` provider.
- [Tasks](./tasks.md) — the Task run controls that link into a live session.
- [Credits & Billing](./credits-and-billing.md) — the plan tiers transcript retention hangs off.
