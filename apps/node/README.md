# Ever Works Node (`apps/node`)

Headless execution node: a CLI and long-running service that registers **this machine** with an
Ever Works platform, keeps it visible in the Fleet settings page with a regular heartbeat, and —
with `--work` — **leases and executes platform work** on it.

This app also **owns the shared node core** (`src/core/`) — enrollment, heartbeat, capability
detection and config persistence are written once here and imported by `apps/desktop-node`, so the
headless and desktop shells can never drift apart (PRD §3.3).

## Commands

```bash
ever-works-node enroll --api-url <url> --token <one-time-token> [--name <label>] [-i <seconds>]
ever-works-node start [-i <seconds>] [--work] [--concurrency <count>]
ever-works-node status
ever-works-node capabilities
```

- **`enroll`** consumes a one-time token from the platform's Fleet page (`POST /api/fleet/enroll`)
  and writes `{apiUrl, nodeId, secret, capabilities, …}` to the OS config directory.
- **`start`** runs the heartbeat loop (`POST /api/fleet/heartbeat`, default every 60s) with
  exponential backoff on failure, refreshing capability tags on every beat, until SIGINT/SIGTERM.
  With **`--work`** it also runs the worker host: lease → execute → report against
  `POST /api/fleet/jobs/*`. This is opt-in on purpose — enrolling a machine and letting it run the
  owner's commands are two different consents.
- **`status`** prints the local enrollment with the credential reported but never shown.
- **`capabilities`** prints the tags this machine would report, without enrolling.

Exit codes: `0` ok, `1` failure, `3` not enrolled (so provisioning scripts can branch on it).

## Config file

| Platform | Location                                                             |
| -------- | -------------------------------------------------------------------- |
| Windows  | `%APPDATA%\ever-works-node\node-config.json`                         |
| macOS    | `~/Library/Application Support/ever-works-node/node-config.json`     |
| Linux    | `$XDG_CONFIG_HOME/ever-works-node/node-config.json` (or `~/.config`) |

`EVER_WORKS_NODE_CONFIG` overrides the path entirely. The file is created with mode **0600** and
re-chmod'ed after write on POSIX; on Windows the chmod is skipped rather than faked (no POSIX mode
bits — the file inherits the user profile's ACL).

## Capability tags

Detected at enroll and re-detected on **every heartbeat**, so installing Docker or Git on a running
node shows up in Fleet without a restart:

`os:<platform>` · `arch:<arch>` · `node:<major>` · `terminal` · `workspace` · plus `docker`, `git`
and `display` when present. Tags are normalized with the same rules the server applies
(trim → 32 chars → dedupe → max 16), so what the node reports is exactly what Fleet stores.

## Layout

- `src/core/` — the shared core, pure logic over injected IO:
    - `fleet-client.ts` enroll/heartbeat HTTP over an injected `fetch`
    - `heartbeat.ts` the loop + backoff state machine over an injected scheduler
    - `capabilities.ts` detection over an injected command runner
    - `config-store.ts` persistence over an injected filesystem
    - `logger.ts` redacting logger — credentials are `protect()`ed once and scrubbed everywhere
    - `job-client.ts` lease/heartbeat/complete HTTP over the same injected `fetch`
    - `worker-loop.ts` the lease → execute → report loop (backoff, keep-alive, draining shutdown)
    - `executors/acceptance-checks.ts` the v1 job kind, with its own scrubbed subprocess env
    - `runtime.ts` composition root (`enrollNode`, `createNodeRuntime`, shutdown handlers)
    - `types.ts` wire types + the server's limits, mirrored (the job protocol instead comes from
      `@ever-works/contracts`, which is where drift would actually hurt: it carries executable work)
- `src/node-io.ts` — the one place that binds those interfaces to Node built-ins
- `src/cli/program.ts` — argument parsing and command bodies (commander), fully injectable
- `src/cli.ts` — the `bin` entry point; IO binding only

## Security notes

- The heartbeat secret is **never logged**: the enrollment token and the minted secret are
  registered with the redacting logger the moment they exist, and every sink is scrubbed.
- Server bodies are never echoed into client errors — the API answers every invalid credential path
  with one undifferentiated 401, and this client keeps that posture.
- Transport is **outbound-only**; the node never listens on a port. That includes job leasing —
  the node polls for work, nothing ever connects in.
- Check subprocesses get an env built **from scratch**, never the inherited one. A check command is
  user-authored input running on somebody's real machine, so the allowlist covers toolchain
  discovery and locale only, secret-shaped names are dropped, and the node's OWN credential
  namespace (`FLEET_*`) can never be granted even by an explicit `envPassthrough`.
- A lease is a **deadline, not a lock**: if this process dies mid-job, the platform reclaims the
  claim and re-offers the work. Shutdown drains in-flight jobs so their verdicts are reported
  rather than abandoned.
- A real `User-Agent` is always sent — the production API edge answers default/absent agents with 403.

## Commands (development)

```bash
pnpm --filter ever-works-node build   # tsc type-check + CommonJS emit to dist/
pnpm --filter ever-works-node test    # vitest unit tests (no network, no disk, no real timers)
```

## Notes

- **Excluded from the default root build**: like `apps/docs` and `apps/desktop`, this app is
  filtered out of root `pnpm build` / `pnpm build:apps`; build it explicitly with
  `pnpm build:node` (root `pnpm build:all` includes it).
- **Publishing is a follow-up.** The package is `private` today; the npm/container/systemd
  packaging of PRD §3.3 lands with the packaging milestone.

## What a node can and cannot run

The worker host resolves an executor by `job.kind`. Today exactly one kind is registered:

| Kind                | Status                                                                                                                                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `acceptance-checks` | **Working end to end.** Runs a Task's dispatch-frozen acceptance checks in a workspace directory on this machine and reports each exit code, with verdict rules identical to the platform's `TaskGateRunnerService`. |

A leased job of any other kind is completed as a **failure naming the kind** — never silently
dropped, which would leave it to expire and retry forever on the same incapable node.

## Follow-ups

- Further job kinds behind the same executor seam: full agent execution, `pty-local`
  (`terminal-stream`) sessions and `local-workspace` provisioning. Each is one `register(kind, …)`
  call — no protocol change, no new endpoint, no new credential.
- Workspace **provisioning** on the node: today `acceptance-checks` requires the workspace to
  already exist on this machine (it refuses a path it cannot resolve), so the end-to-end cloud
  path still wants a checkout step.
- `pause` / `unenroll` CLI verbs (PRD §3.3) follow the corresponding Fleet API surface.
