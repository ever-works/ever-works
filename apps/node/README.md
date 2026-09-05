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
ever-works-node enroll --api-url <url> --token <one-time-token> [--name <label>] [-i <seconds>] [--min-free-disk <mib>] [--workspace-max-age <days>]
ever-works-node start [-i <seconds>] [--work] [--concurrency <count>] [--claude-path <file>] [--codex-path <file>] [--workspace-root <dir>] [--min-free-disk <mib> | --no-disk-floor] [--workspace-max-age <days>] [--workspace-max-count <n>]
ever-works-node pause [--local-only]
ever-works-node resume [--local-only]
ever-works-node unenroll [--local-only]
ever-works-node status
ever-works-node capabilities
ever-works-node doctor [--workspace-root <dir>] [--max-age <days>] [--max-count <n>] [--offline] [--json]
ever-works-node gc [--workspace-root <dir>] [--max-age <days>] [--max-count <n>] [--dry-run] [--offline]
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
- **`doctor`** is read-only: free space on the workspace volume against the disk floor, the workspace
  root, how many Task worktrees and repository pools it holds, and — per worktree — what `gc` would do
  and why. `--json` emits one object for scripts. Works whether or not the machine is enrolled.
  Both `doctor` and `gc` inspect the root the node's last `start --workspace-root` recorded in the
  config, and the header says where the root came from — `--workspace-root`, the config, or the
  process default. That matters when the service runs as its own account: the default resolves under
  the account running the CLI, so a bare `doctor` there would answer about an empty directory that is
  not the node's tree at all. Pass `--workspace-root` when the header says the root is only a default.
- **`gc`** runs the workspace reaper (see "Disk floor and workspace GC" below). `--dry-run` prints the
  plan and removes nothing; `--max-age` / `--max-count` override the stored policy for that run only.
  Exit `1` when a planned removal failed — nothing is ever force-deleted.

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

### Multi-repo Task workspaces

A job's workspace spec may carry `mounts`: additional repositories checked out on the same Task branch.
Each mount is its own binding under the workspace root (same pool, reuse and ownership proof as the
primary) and is linked into the primary worktree at `.mounts/<dir>` — a directory junction on Windows,
a symlink elsewhere — with `/.mounts/` written to the repository's shared `info/exclude`, so the
primary's Git never sees it. After the model step the node commits and pushes every writable mount
(one verdict each, reported as `mountGit`) and then the primary. A mount that cannot be provisioned
fails the job naming it; a mount whose push fails is reported on its own entry while the others still
complete.

### Disk floor and workspace GC

Two node-side guards keep a machine from filling its disk with Task worktrees (self-build program note
§6, findings OPS-12 and R8).

**Disk floor.** A node refuses to lease work while the volume that holds its workspace root has fewer
free bytes than the floor — **2 GiB by default**, set with `--min-free-disk <mib>` in **mebibytes** (persisted by
`enroll`, process-only on `start`, like `--max-cpu`), switched off with `--no-disk-floor`. The floor is
measured on the **workspace root's volume** (the nearest existing ancestor of it), never on the system
drive, and it is checked twice: at the lease, and again by the provisioner right before it writes
anything — once before the primary worktree and once before every mount, because disk can drop between
the two. A refused lease shows the node as `throttled` with the reason in the status window and one
warning in the log (one more line when it clears); a provision refused for disk (`disk-low`) is not a
verdict about the work — the node hands the job back **unsettled**, its claim lapses and the platform
re-offers it to a node with room, and the very next poll throttles this one.

Both checks treat an **unreadable** volume the same way: they refuse. The floor fails closed, because
the provision-time check is the last one before a clone, a fetch and a model's whole budget land on a
volume nobody can size — and the lease check has to be at least as strict, or the node takes every job
it is offered and then defers it here, spending one of the job's attempts per lapsed lease until the
platform fails it with a message that never mentions disk. The node therefore goes `throttled` with a
reason instead, in the log, in the drawer and in `doctor`; `--no-disk-floor` is the explicit way to
switch the control off on a host whose `statfs` cannot answer. The heartbeat's `diskFreeBytes` is taken
with the same measurement as the gates (the nearest existing ancestor of the root), so a node that has
never provisioned still reports a figure to compare the floor against.

**What the platform sees (EW-803).** The heartbeat also reports the floor in force
(`minFreeDiskBytes`; `null` when `--no-disk-floor` is set), what the last sweep retained
(`workspaceCount`, `workspaceBytes`) and when it ran and what it took (`lastReclaimAt`,
`lastReclaimFreedBytes`). These travel **upward only** — the platform never sets them and never routes
on them; the limit stays enforced here. The CPU and memory ceilings are not reported at all: there is no
CPU or memory reading beside them to make a ceiling meaningful. A node without `--work` enforces no
floor and runs no reaper, so it reports none of this and Fleet shows "not reported" rather than zeros.

**Workspace reaper.** With `--work`, the node runs a reaper over its workspace root a minute after start
and then every six hours (skipped, and retried in half an hour, while a job is running); `ever-works-node
gc` runs the same reaper by hand. It removes a Task worktree only when it can **prove** all of this, and
`doctor` prints the first rule each worktree fails:

1. it is the node's own — the provider's binding stamp _and_ an exact `git worktree list` registration;
2. no provisioning intent is pending for it;
3. no live process holds its lease (see below), and this process is not using it;
4. `git status --porcelain --untracked-files=all` is empty and no `index.lock` / `HEAD.lock` exists;
   plus the two things that command structurally cannot see, because the node excludes them itself:
   `.mounts` is a plain directory (not a junction someone put there), and `.ever-works/` — the
   owner-question channel — is empty or absent;
5. no commit on `HEAD` is missing from every remote-tracking ref;
6. the remote was reachable, **and** the branch is gone from it or merged into its default branch — a
   branch still open on the remote keeps the worktree, however old;
7. it was last provisioned longer ago than `--workspace-max-age` (default **14 days**, persisted by
   `enroll` and by `start`, which differs from the process-only ceilings on purpose:
   `install-service.ps1` re-applies `start` flags on every re-install). An optional
   `--workspace-max-count <n>` additionally trims the least recently used worktrees that already pass
   rules 1–6.

Unknown always means keep, so an `--offline` scan can inform but never removes. Rules 5 and 6 need the
remote because the node **pushes to a URL**, which never updates `refs/remotes/origin/<branch>`: the
scan does one `ls-remote` and one batched `fetch` per repository pool through the node's own Git
credential helper (token-free, `GIT_TERMINAL_PROMPT=0`, 30 s bound per call) before judging, and a
branch the remote no longer has gets its stale tracking ref deleted. A merged branch that still exists
on the remote is judged by `merge-base --is-ancestor` against the refreshed default branch; when the
merge predates the pool's shallow boundary that answers "no" and the worktree is kept.

Removal never calls a recursive filesystem delete on a checkout. Every `.mounts/*` link is unlinked
first — a junction there points at **another** Task's worktree — then the provider's own `teardown`
re-proves ownership and runs `git worktree remove --force` (which also deletes ignored files such as
`node_modules`; that is intended, the worktree was proven clean, pushed and closed) and `git worktree
prune`. A bare repository pool is deleted only once Git lists no worktree for it, no intent is pending,
its remote was refreshed by this scan, **and** nothing it can still reach — branches, tags, the stash,
the **reflog** — carries a commit missing from every remote-tracking ref (`rev-list --count --all
--reflog --not --remotes`). `git worktree remove` leaves the branch behind and the provider's `worktree
add -B` force-resets one into its reflog, so an emptied pool can still hold the only copy of unpushed
work, and that keeps it. A
pool is dated by its `worktrees/` and intents directories, never by `FETCH_HEAD`, which the scan itself
rewrites. Anything the reaper does not recognise under the root is reported and left alone.

Two files in each worktree's **private gitdir** (`<pool>/worktrees/<id>/`, never in the working tree,
gone with the worktree) carry the evidence: `ew-workspace-lease.json` (`{purpose: job|gc, pid, taskId}`,
created atomically and exclusively; a lease held by a dead pid is reclaimable; one this build cannot
PARSE — a future `version`, an unknown `purpose`, a torn write — is treated as HELD, never reclaimed;
one held by a live foreign job is a
`path-collision` that preserves the worktree and fails the job naming the holder; one held by the reaper
mid-removal is a transient `workspace-busy` that hands the job back unsettled, and the retry lands on a
fresh checkout) and
`ew-workspace-usage.json` (`lastUsedAt`, refreshed on every provision and release). A worktree from
before this build has neither; it is dated by its Git mtimes, and while a `.worker-session` marker
exists for the config — a worker that may predate leases could be using it — `gc` keeps it until its
first run under this build stamps it.

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
