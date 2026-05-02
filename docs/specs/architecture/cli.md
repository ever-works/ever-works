# Architecture: CLI Apps (Public + Internal)

**Status**: `Active`
**Last updated**: 2026-05-02
**Audience**: AI agents and engineers extending CLI commands, debugging
auth flows, or choosing between the two CLI surfaces.

---

## 1. Purpose

The platform ships **two distinct CLI applications** with different
audiences, runtimes, and architectures:

- **`apps/cli`** (`ever-works`) — the **public** CLI, distributed via
  npm, used by end users to manage their works from a terminal.
  Built with Commander.js + esbuild into a single bundled binary.
- **`apps/internal-cli`** (`ever-works-admin`) — the **internal** CLI,
  used by platform operators and maintenance scripts. Built with
  NestJS + nest-commander; reuses the agent package's services
  directly without going through HTTP.

Both share helpers from `packages/cli-shared`. This spec covers the
**why two CLIs**, the **command surface differences**, the **build
strategies**, and the **auth integration** patterns.

## 2. Why Two CLIs

The split is deliberate and not redundant:

| Concern      | Public CLI                                           | Internal CLI                             |
| ------------ | ---------------------------------------------------- | ---------------------------------------- |
| Audience     | End users, integrators, CI                           | Platform operators, maintenance scripts  |
| Distribution | `npm i -g @ever-works/cli` → `ever-works` on `$PATH` | Run from inside the repo with `pnpm`     |
| Auth         | Device flow → JWT or pre-issued API key              | Direct DB / service access; no auth      |
| Talks to     | The HTTP API                                         | The DB / agent package services directly |
| Bundling     | esbuild → single self-contained `index.js`           | nest-commander, runtime-loaded modules   |
| Bundle size  | ~5 MB                                                | Doesn't matter (run in repo)             |
| Startup time | ~200 ms (cold)                                       | ~3–5 s (NestJS bootstrap)                |
| Permissions  | Bound to the user's plan + per-work roles            | Full DB access; superuser-equivalent     |
| Dependencies | Pinned + audited                                     | Anything in the workspace                |

The public CLI is **customer-facing** software — it has to be small,
portable, fast to start, and security-bounded. The internal CLI is
**operator software** — it can do anything, talk to anything, and
takes its time.

## 3. Public CLI (`apps/cli`)

### 3.1 Layout

```
apps/cli/
├── build.js                      # esbuild config: entry → dist/index.js
├── package.json                  # Published as @ever-works/cli
├── README.md
└── src/
    ├── main.ts                   # Commander.js root
    ├── commands/                 # One file per top-level command
    ├── services/                 # API client + auth state helpers
    └── utils/                    # Output formatting, prompts, errors
```

### 3.2 Command structure

Top-level commands roughly mirror the API's resource taxonomy:

| Command group   | Examples                                                  |
| --------------- | --------------------------------------------------------- |
| `auth`          | `login`, `logout`, `whoami`                               |
| `work`          | `create`, `list`, `get`, `delete`, `regenerate`, `cancel` |
| `work item`     | `add`, `update`, `remove`, `list`                         |
| `work schedule` | `set`, `pause`, `cancel`, `run`                           |
| `work domain`   | `add`, `verify`, `rm`                                     |
| `plugin`        | `list`, `enable`, `disable`, `set` (settings update)      |
| `comparison`    | `list`, `generate`, `delete`                              |

Every command accepts:

- `--api-url <url>` (or `EVER_WORKS_API_URL` env var; default
  `https://api.ever.works`).
- `--api-key <key>` (or `EVER_WORKS_API_KEY` env var; takes precedence
  over the stored JWT).
- `--json` to switch output to JSON (for piping into `jq`).
- `--verbose` for debug log output.

### 3.3 Auth model

The public CLI authenticates via one of two paths:

1. **Device flow** (`ever-works auth login`) — opens a browser, polls
   `/api/auth/device/poll` until the user approves, stores the
   resulting JWT + refresh token in `~/.ever-works/credentials.json`
   (file-mode 600). See
   [`auth`](./auth.md) for the full flow.
2. **API key** (`EVER_WORKS_API_KEY=ew_live_...`) — simpler, used in
   CI. Bypasses the credentials file entirely.

The CLI's `services/api-client.ts` wraps `fetch`, picks the right auth
mode automatically, refreshes JWTs on 401, and translates `ApiError`
into terminal-friendly messages (e.g. `403 Forbidden` becomes
`Error: You don't have permission to do that. Run 'ever-works whoami'
to check your account.`).

### 3.4 Build

```js
// apps/cli/build.js
await esbuild.build({
	entryPoints: ['src/main.ts'],
	bundle: true,
	platform: 'node',
	target: 'node20',
	outfile: 'dist/index.js',
	minify: true,
	external: ['fsevents'] // Mac-only optional dep
});
```

Single-file bundle so end users get one binary they can curl + chmod

- run, or install via npm. No runtime requirement except Node ≥ 20.

### 3.5 Output formatting

Default output is human-friendly (tables for lists, key-value for
single resources, colour for emphasis). `--json` flips to machine
output that `jq` can pipe; designed for scripts.

| Command output | Default                                  | `--json`                  |
| -------------- | ---------------------------------------- | ------------------------- |
| `work list`    | Table of slug + name + status + last-run | Array of full objects     |
| `work get`     | Key-value pairs grouped by section       | Single full object        |
| `error`        | Coloured red message + exit 1            | `{error: "..."}` + exit 1 |

## 4. Internal CLI (`apps/internal-cli`)

### 4.1 Layout

```
apps/internal-cli/
├── build.js                      # NestJS build (tsc + nest)
├── nest-cli.json
├── package.json
└── src/
    ├── main.ts                   # nest-commander bootstrap
    ├── cli.module.ts             # Root module
    ├── local-event-emitter.module.ts  # In-process events instead of network
    ├── config/                   # Config commands (AI providers, plans, etc.)
    ├── commands/                 # Top-level commands
    └── works/              # Work-management commands
```

### 4.2 What it does that the public CLI can't

| Operation                                        | Why it's internal-only                                    |
| ------------------------------------------------ | --------------------------------------------------------- |
| Backfilling stale data                           | Bypasses per-user permissions; touches every user's works |
| Re-running failed Trigger.dev tasks              | Needs DB access to find them                              |
| Bulk plan migrations                             | Modifies subscriptions across all users                   |
| AI provider config (model lists, pricing tweaks) | Touches global config, not per-user settings              |
| Database migrations / seeds                      | TypeORM-level access                                      |
| Cron debug runs                                  | Calls the dispatcher service directly to test outcomes    |

### 4.3 Bootstrap

Internal CLI commands extend `nest-commander`'s `CommandRunner`:

```ts
@Command({ name: 'reschedule-stuck' })
export class RescheduleStuckCommand extends CommandRunner {
	constructor(private readonly scheduleService: WorkScheduleService) {
		super();
	}

	async run(): Promise<void> {
		const recovered = await this.scheduleService.recoverStuckSchedules();
		console.log(`Recovered ${recovered} stuck schedules`);
	}
}
```

The shared services are imported from `@ever-works/agent` — same code
the API runs, just with no HTTP layer in the way. This is why the
internal CLI gives an honest "platform-eye" view rather than a
"customer-eye" one.

### 4.4 Local event emitter

The API uses `@nestjs/event-emitter` to decouple modules. The internal
CLI ships its own `LocalEventEmitterModule` that satisfies the same DI
token in single-process mode — events fire and consume in-process
without crossing any network boundary. This lets the CLI exercise
event-driven code paths without spinning up the full API.

## 5. Shared Helpers (`packages/cli-shared`)

Both CLIs depend on `@ever-works/cli-shared`:

```
packages/cli-shared/src/
├── index.ts
├── prompts/                  # Inquirer-style prompts (consistent UX)
│   ├── work-prompt.service.ts
│   └── ...
└── utils/                    # Slug validation, output formatters, env helpers
```

The notable shared piece is `work-prompt.service.ts` which holds
the `GenerateStatusType` enum used across the platform — the public
CLI mirrors the API's status names so users see the same vocabulary.

## 6. Auth State on Disk (Public CLI)

The public CLI stores credentials in a per-user JSON file:

```
~/.ever-works/
├── credentials.json          # JWT, refresh token, expiry
└── config.json               # Default api-url, default org, etc.
```

Both files are written with `mode: 0o600` (owner read+write only). On
Windows, the file lives at `%USERPROFILE%\.ever-works\` with NTFS ACLs
limiting access to the current user.

When the JWT expires, the CLI:

1. Checks if a refresh token exists.
2. POSTs to `/api/auth/refresh`.
3. Persists the new token pair.
4. Retries the original request.

If the refresh token is also expired or rejected, the CLI prompts the
user to run `ever-works auth login` again.

## 7. Error Handling

| Error condition        | Public CLI behaviour                                               | Internal CLI behaviour                 |
| ---------------------- | ------------------------------------------------------------------ | -------------------------------------- |
| Network error          | Retries 2× with 250 ms backoff, then "API unreachable, try later"  | Throws — operator should see the stack |
| 401 Unauthorized       | Refreshes JWT once, retries; if still 401, prompts to log in again | N/A                                    |
| 403 Forbidden          | "You don't have permission for that operation"                     | N/A                                    |
| 404 Not Found          | "Work '<slug>' not found. Did you mean '...'?" (Levenshtein hint)  | "Not found" + stack                    |
| Validation error (400) | Pretty-prints the first 3 field errors                             | Dumps the full error object            |
| Unknown 5xx            | "Server error. Please try again. If it persists, contact support." | Stack trace + Sentry breadcrumb        |

All errors return non-zero exit codes:

| Class           | Exit code |
| --------------- | --------- |
| User error      | 1         |
| Auth required   | 2         |
| Network failure | 3         |
| Server error    | 4         |
| Internal error  | 5         |

CI scripts can branch on exit code to distinguish "user mistake" from
"server outage".

## 8. Testing

| CLI      | Test approach                                                                                       |
| -------- | --------------------------------------------------------------------------------------------------- |
| Public   | Vitest unit tests for command handlers; integration tests run the bundled binary against a mock API |
| Internal | Jest tests for command classes (uses `@nestjs/testing`); calls real services with a test DataSource |

Both publish coverage reports to the same CI dashboard.

## 9. Distribution

| CLI      | How it ships                                                                                                                                 |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Public   | Published to npm as `@ever-works/cli`. CI runs on every release tag; the CLI version matches the platform release version 1:1.               |
| Internal | Not published. Run from the monorepo with `pnpm --filter ever-works-internal-cli start <command>`. Container image baked with the API image. |

## 10. Constitution Reconciliation

| Principle                   | How the CLIs respect it                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| I — Plugin-first            | The public CLI surfaces `plugin list / enable / disable / set` and lets users configure their plugins. |
| II — Capability-driven      | The CLI never hardcodes plugin ids — it lists what the API reports.                                    |
| III — Source-of-truth repos | The CLI talks to the API; user repos remain user-owned.                                                |
| IV — Trigger.dev            | Long-running commands kick off async work and poll for completion.                                     |
| V — Forward-only migrations | Internal CLI runs DB migrations (`migration:run`); never destructive without a flag.                   |
| VI — Tests                  | Both CLIs have unit + integration suites.                                                              |
| VII — Secret hygiene        | API keys read from env, never logged; on-disk credentials at file-mode 600.                            |
| VIII — Plugin counts        | The CLI reports counts dynamically from `/api/plugins`.                                                |
| IX — Behaviour-first        | This spec describes observable CLI behaviour.                                                          |
| X — Backwards-compat        | Public CLI semver-versioned; commands stay stable across patch + minor.                                |

## 11. References

- Source:
    - `apps/cli/`
    - `apps/internal-cli/`
    - `packages/cli-shared/`
- Related specs:
    - [`auth`](./auth.md)
    - [`features/api-keys/spec`](../features/api-keys/spec.md)
- User docs:
    - [`docs/cli/index.md`](../../cli/index.md)
    - [`docs/cli/commands.md`](../../cli/commands.md)
    - [`docs/cli/internal-cli.md`](../../cli/internal-cli.md)
