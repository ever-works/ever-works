# Ever Works Node (`apps/node`)

Headless execution node: a CLI and long-running service that registers **this machine** with an
Ever Works platform, keeps it visible in the Fleet settings page with a regular heartbeat, and —
with `--work` — **leases and executes platform work** on it.

This app also **owns the shared node core** (`src/core/`) — enrollment, heartbeat, capability
detection and config persistence are written once here and imported by `apps/desktop-node`, so the
headless and desktop shells can never drift apart (PRD §3.3).

## Install

The node ships on npm as the public package **`ever-works-node`** — one command per machine, no
monorepo checkout:

```bash
npm install -g ever-works-node     # Node.js >= 22
ever-works-node --version
ever-works-node capabilities       # what this machine would advertise, before enrolling
```

The published package is a single bundled `cli.js` (see `build.js`); the only runtime dependency is
the optional `@napi-rs/keyring` native addon for the OS keychain — where its prebuilt binary is
unavailable the install still works, with the credential in the owner-locked config file instead.

The unattended-run scripts ship inside the package. After a global install the Windows installer is
at:

```powershell
& "$(npm root -g)\ever-works-node\packaging\windows\install-service.ps1" -Work
```

(Windows: [NSSM](https://nssm.cc) is optional — with it the script registers a real Windows service,
without it a boot-time Scheduled Task. Either way it registers `node.exe` running the package's
`cli.js` directly — never npm's `.ps1`/`.cmd` shims, which service managers cannot launch — and
re-running it re-applies the current flags. From a source checkout pass
`-CliPath <checkout>\apps\node\dist\cli.js`. The systemd unit for Linux is under `packaging/systemd/`.)

**From source** instead — in the monorepo, `pnpm build:node` builds the node and its workspace
dependencies into `apps/node/dist/`, and `cd apps/node && npm link` puts `ever-works-node` on `PATH`
pointing at that checkout.

## Commands

```bash
ever-works-node enroll --api-url <url> --token <one-time-token> [--name <label>] [-i <seconds>]
ever-works-node start [-i <seconds>] [--work] [--concurrency <count>] [--claude-path <file>] [--codex-path <file>] [--workspace-root <dir>]
ever-works-node pause [--local-only]
ever-works-node resume [--local-only]
ever-works-node unenroll [--local-only]
ever-works-node status
ever-works-node capabilities
```

- **`enroll`** consumes a one-time token from the platform's Fleet page (`POST /api/fleet/enroll`)
  and writes `{apiUrl, nodeId, capabilities, …}` to the OS config directory, with the credential
  itself going to the OS keychain where one exists.
- **`start`** runs the heartbeat loop (`POST /api/fleet/heartbeat`, default every 60s) with
  exponential backoff on failure, refreshing capability tags on every beat, until SIGINT/SIGTERM.
  With **`--work`** it also runs the worker host: lease → execute → report against
  `POST /api/fleet/jobs/*`. This is opt-in on purpose — enrolling a machine and letting it run the
  owner's commands are two different consents. `--claude-path` / `--codex-path` pin the model CLIs
  for this process and `--workspace-root <dir>` sets the **absolute** directory the per-Task
  worktrees of agent tasks live under (default `EVER_WORKS_NODE_WORKSPACE_ROOT`, then
  `~/.ever-works/fleet-workspaces`); a relative path is a usage error.
- **`pause` / `resume`** drain and undrain this machine. Pausing stops leasing **immediately** and
  lets in-flight jobs finish and report — it is not a kill. It tells the platform
  (`POST /api/fleet/pause`, so the scheduler stops offering work) _and_ records the intent locally,
  so a service restart comes back paused. A paused node keeps heartbeating: a drained machine that
  vanishes from Fleet is indistinguishable from a dead one.
- **`unenroll`** retires the machine — `POST /api/fleet/unenroll` deletes the registration, then the
  local credential is erased. The local erase happens **even if the API call fails**: a
  decommissioned laptop holding a live fleet secret is the worse outcome.
- **`status`** prints the local enrollment with the credential reported but never shown, including
  where it is stored and whether the node is paused.
- **`capabilities`** prints the tags this machine would report, without enrolling.

`--local-only` skips the API call, for a machine being drained or decommissioned offline.

Exit codes: `0` ok, `1` failure, `3` not enrolled (so provisioning scripts can branch on it).

## Config file

| Platform | Location                                                             |
| -------- | -------------------------------------------------------------------- |
| Windows  | `%APPDATA%\ever-works-node\node-config.json`                         |
| macOS    | `~/Library/Application Support/ever-works-node/node-config.json`     |
| Linux    | `$XDG_CONFIG_HOME/ever-works-node/node-config.json` (or `~/.config`) |

`EVER_WORKS_NODE_CONFIG` overrides the path entirely.

**The credential does not live in this file when it does not have to.** With an OS keychain
available (macOS Keychain, Windows Credential Manager, Linux Secret Service — all reached through
the `@napi-rs/keyring` SDK) the secret is stored there and the file records only
`"secretStorage": "keychain"`. Where no keychain exists — headless servers, containers — it falls
back into the file and **says so loudly**, on every load and every save.

Either way the file is locked to its owner: mode **0600** at creation and re-chmod'ed after write on
POSIX, and on Windows an inheritance-stripped owner-only ACL applied with `icacls`. Windows is no
longer skipped.

`EVER_WORKS_NODE_DISABLE_KEYCHAIN=1` forces the file fallback (the container image sets it, because
a container never has a keychain and a surprise warning is worse than a declared choice).

## Capability tags

Detected at enroll and re-detected on **every heartbeat**, so installing Docker or Git on a running
node shows up in Fleet without a restart:

`os:<platform>` · `arch:<arch>` · `node:<major>` · `terminal` · `workspace` · plus `docker`, `git`,
`display`, `browser`, `gpu` and `gpu:<vendor>` when present. Tags are normalized with the same rules
the server applies (trim → 32 chars → dedupe → max 16), so what the node reports is exactly what
Fleet stores.

Two rules govern what may appear:

1. **A tag is a promise the node can keep.** `browser` is emitted only when a browser executable was
   actually resolved — the same path `browser-check` will spawn — and the `browser-check` executor is
   registered by that same fact. A tag with nothing behind it routes real work to a machine that
   cannot do it.
2. **Detection never fails the beat.** Every probe swallows its own errors: a missing tool is a
   missing tag, not a missing heartbeat.

`EVER_WORKS_NODE_BROWSER` pins the browser executable explicitly. A pinned path that does not exist
disables the tag rather than falling through to some other browser — silently launching a different
engine than the one an operator chose is how a check passes for the wrong reason.

## Layout

- `src/core/` — the shared core, pure logic over injected IO:
    - `fleet-client.ts` enroll/heartbeat HTTP over an injected `fetch`
    - `heartbeat.ts` the loop + backoff state machine over an injected scheduler
    - `capabilities.ts` detection over an injected command runner
    - `config-store.ts` persistence over an injected filesystem
    - `logger.ts` redacting logger — credentials are `protect()`ed once and scrubbed everywhere
    - `job-client.ts` lease/heartbeat/complete HTTP over the same injected `fetch`
    - `worker-loop.ts` the lease → execute → report loop (backoff, keep-alive, draining shutdown
      **and draining pause**)
    - `browser-probe.ts` / `gpu-probe.ts` the `browser` and `gpu` capability probes
    - `secret-store.ts` OS keychain over an injected SDK loader, with a loud file fallback
    - `executors/acceptance-checks.ts` the v1 job kind, with its own scrubbed subprocess env
    - `executors/browser-check.ts` the v2 job kind — a real browser in a throwaway profile
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
pnpm --filter ever-works-node build         # tsc type-check + CommonJS emit to dist/
pnpm --filter ever-works-node test          # vitest unit tests (no network, no disk, no real timers)
pnpm --filter ever-works-node build:bundle  # stage the publishable npm package under dist-bundle/
```

`build:bundle` (`build.js`) inlines the `workspace:*` packages with esbuild into one `cli.js`,
writes the public manifest beside it and copies `packaging/`. The workspace package itself stays
`private`; `.github/workflows/publish-node.yml` publishes `dist-bundle/` on a `node-v<version>` tag, with an
npm provenance attestation. Release flow: bump `package.json` and `src/version.ts` together in a PR
(`src/version.spec.ts` pins them to each other), merge, then tag the merge commit `node-v<version>` —
the tag must equal the package version, so every published version maps to one commit. Running the
workflow by hand is a dry run only (build, smoke test, `npm publish --dry-run`).

## Notes

- **Excluded from the default root build**: like `apps/docs` and `apps/desktop`, this app is
  filtered out of root `pnpm build` / `pnpm build:apps`; build it explicitly with
  `pnpm build:node` (root `pnpm build:all` includes it).
- **Running it unattended** — systemd unit, Windows service / scheduled task, container image — is
  documented in [`packaging/README.md`](packaging/README.md).

## What a node can and cannot run

The worker host resolves an executor by `job.kind`:

| Kind                | Status                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `acceptance-checks` | **Working end to end.** Runs a Task's dispatch-frozen acceptance checks in a workspace directory on this machine and reports each exit code, with verdict rules identical to the platform's `TaskGateRunnerService`.                                                                                                                                                                         |
| `agent-task`        | **Working end to end.** The general kind. In the platform's `command` mode it runs the operator's command template; in `model-cli` mode it provisions an isolated worktree of the Task's repository, runs a **local Claude Code / Codex** on the instructions the platform assembled, grades the acceptance checks, then commits and pushes the task branch. See "Agent execution v2" below. |
| `browser-check`     | **Working end to end, on a node that resolved a browser.** Drives the machine's real browser against a URL in a throwaway profile and reports what it rendered (DOM bytes, `<title>`, an optional `expectText`). Registered only when the `browser` tag is advertised.                                                                                                                       |

## Agent execution v2 — model CLIs on this machine

A node advertises `claude-code` and/or `codex` when it resolved the executable at startup:

1. `EVER_WORKS_NODE_CLAUDE_PATH` / `EVER_WORKS_NODE_CODEX_PATH` (or `start --claude-path` /
   `--codex-path`) pin an executable. A pin that does not resolve **disables** that CLI rather than
   falling back to PATH — a run must never succeed on a binary the operator did not choose.
2. Otherwise the first `claude` / `codex` on PATH (on Windows, the `.cmd` / `.exe` form).

A `model-cli` job is only offered to nodes advertising the CLI it needs. On such a job the node:

- provisions the Task worktree (bare cache + `git worktree`, per-Task binding, root-confined);
- writes the platform's instructions to a scratch file and runs the CLI **through the same command
  runner every check uses** — env scrub, timeout, cancellation, whole-tree kill — with the
  instructions on stdin (`claude -p --output-format json …` / `codex exec --json … -`) and the CLI's
  structured output captured to a scratch file. Nothing free-form ever reaches argv;
- runs the acceptance checks in the worktree;
- `git add -A && git commit && git push HEAD:refs/heads/<task-branch>` via the node's own Git
  credential helper (token-free, like the fetch);
- reports one `FleetAgentTaskResult`: model summary / cost / turns / session id, check verdicts,
  gate status, branch + head SHA + changed-file count, and a one-sentence `failureReason` when any
  required part did not pass.

The CLI runs with the machine's own login (`~/.claude`, `~/.codex`) or the credential names the
platform granted (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `CODEX_ACCESS_TOKEN`,
`OPENAI_API_KEY` — one per family, subscription-backed first). Scratch files live under the OS temp
dir (`ever-works-node/agent-tasks/<job id>`) and are removed after every run.

`browser-check` runs headless by default (`--headless=new --dump-dom`), which is what makes its
verdict a real observation rather than "the process did not crash". `headed: true` opens a visible
window on a node that also advertises `display`; because Chrome exposes no DOM outside headless, a
headed job that asks for `expectText` is **refused** rather than quietly downgraded.

A leased job of any other kind is completed as a **failure naming the kind** — never silently
dropped, which would leave it to expire and retry forever on the same incapable node.

## Follow-ups

- Further job kinds behind the same executor seam: full agent execution, `pty-local`
  (`terminal-stream`) sessions and `local-workspace` provisioning. Each is one `register(kind, …)`
  call — no protocol change, no new endpoint, no new credential.
- Workspace **provisioning** on the node: today `acceptance-checks` requires the workspace to
  already exist on this machine (it refuses a path it cannot resolve), so the end-to-end cloud
  path still wants a checkout step.
- **Auto-update.** The npm package carries an npm provenance attestation, but a node does not
  update itself — `npm install -g ever-works-node@latest` plus a service restart
  is the upgrade path.
