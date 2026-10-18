# FL-12 — Commands on computers · Implementation plan

> How [`spec.md`](./spec.md) gets built. Implementation detail belongs here, not in the spec
> (Constitution IX). Every path below was opened at this branch's base (`origin/develop`
> `e4334baf7`) before it was cited.

**Epic ID:** `FL-12-commands`
**Spec:** [`./spec.md`](./spec.md) · **Tasks:** [`./tasks.md`](./tasks.md)
**Status:** `Draft`
**Created:** 2026-10-18
**Last updated:** 2026-10-18

---

## 1. Architecture summary

```mermaid
flowchart LR
    W[Web: Fleet › Commands tab] -->|POST /api/fleet/commands| A[API: FleetCommandsController]
    T[Agent tool / MCP / CLI] -->|same route| A
    A --> S[FleetCommandService<br/>permission · consent · confirm · limits · kill switch]
    S -->|insert fleet_commands + N fleet_command_runs| DB[(Postgres)]
    S -->|per node: channel.open family=command| R[Node link relay (FL-02)]
    R -->|command.run| N[Node: commands module]
    N -->|spawn login shell, no stdin| OS[OS process]
    OS -->|stdout/stderr| N
    N -->|DATA / EXIT frames| R
    R -->|head+tail, exit, status| S
    R -->|live DATA| V[Viewer WS /ws/fleet/command/:id]
    V --> W
    S -->|node.command.run per node| AU[(fleet_audit)]
```

Data back: the relay fans `DATA` to attached viewers and feeds a per-run head/tail accumulator in
the service; `EXIT` closes the run row. "Open full output" opens an FL-02 operation that asks the
node for `command.output { runId }`, streamed as `DATA` and served to the browser as a download.

## 2. Current state in the codebase

| Piece                                                     | Where (verified at HEAD)                                                                                                  | Reused as                                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Fleet controller root, `FLEET_ENABLED` gate               | `apps/api/src/fleet/fleet.controller.ts:150-151` (`@Controller('api/fleet')`, `FleetEnabledGuard`)                        | New controller mounted beside it in `apps/api/src/fleet/fleet.module.ts`           |
| Fleet domain module and exports                           | `packages/agent/src/fleet/fleet.module.ts:90-123`                                                                          | `FleetCommandService` registered and exported here                                 |
| Audit: one writer, key-based redaction                    | `packages/agent/src/fleet/fleet-audit.service.ts:55` (`REDACTED_KEY_RE`), `:64-72`                                        | Two new action values, no new writer                                               |
| Audit action union                                        | `packages/contracts/src/fleet/fleet-panic.types.ts:60-114`, array `:116-148`                                              | Add `node.command.run`, `node.command.cancel`                                      |
| Audit row shape                                           | `packages/agent/src/entities/fleet-audit.entity.ts:33-65`                                                                 | `details` carries `family`, `target`, `requestedBy`, `confirmationClass`, `outcome` (CONTRACTS §2.3) |
| Node shell resolution (PowerShell on win32, `$SHELL` else) | `apps/node/src/core/screen/terminal-channel.ts:27-34` (`resolveNodeShell`)                                                | Lifted into a shared helper; the login-shell flag added                            |
| Scrubbed child environment                                | `apps/node/src/core/executors/acceptance-checks.ts` (`buildNodeCheckEnv`, imported by `terminal-channel.ts:3`)             | The command's environment; `FLEET_*` / `EVER_WORKS_*` never granted                |
| Canonical-path `cwd` containment                          | `apps/node/src/core/executors/command-roots.ts:29-48`                                                                      | Pattern for validating the optional folder (must be the owner's home or under an allowed root, R-18) |
| Node config dir                                           | `apps/node/src/core/config-store.ts:39-45`                                                                                 | Output retention dir `commands/<runId>.log` under the same config dir               |
| Secret scanner shared with the node                       | `packages/contracts/src/secret/` (used by `apps/node/src/core/executors/model-transcript.ts:8`)                            | Output and command-line redaction                                                  |
| Node link, channel framing, relay bus, operations         | FL-02 (`channel.open`, `DATA`/`EXIT`, `GET /api/fleet/operations/:id`)                                                     | The transport. FL-12 adds no socket of its own                                     |
| Role derivation `owner · org-admin · org-member · stranger` | FL-01 (CONTRACTS §2.1)                                                                                                     | Family check `commands`                                                            |
| Agent tool assembly                                       | `packages/agent/src/agents/agent-tool.service.ts:524-527` (`add('fleet', …)`), descriptor `:128-137`                        | The `fleet_commands_*` tools join `buildFleetTools`                                |
| CLI command groups                                        | `apps/cli/src/main.ts:22-26`; command shape `apps/cli/src/commands/kb/list.ts`                                             | New `fleet` group (FL-19 owns the group; FL-12 ships its first verb)               |
| Hub tab registry                                          | FL-01 `apps/web/src/components/fleet/registry.ts`                                                                          | `commands` hub panel registration                                                  |

What does not exist: any command job kind (`packages/contracts/src/fleet/fleet-jobs.types.ts:117`),
any `fleet_commands` table, any fleet CLI group, any command tool in `apps/mcp/src/openapi-tools/whitelist.ts:475-530`.

## 3. Tech choices

| Concern                    | Choice                                                                                           | Why                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Transport                  | FL-02 node link, `command` channel, `DATA`/`EXIT` kinds                                          | CONTRACTS §3.3; outbound-only (D2); no new job kind because R-11 forbids queueing                        |
| Process spawn on the node  | Node `child_process.spawn` with `stdio: ['ignore', 'pipe', 'pipe']`, login shell `-l -c` / `powershell -NoLogo -NonInteractive -Command` | No stdin by construction; PTY is not needed (no interactivity) so `node-pty` is not pulled in            |
| Process tree termination   | POSIX: `detached` process group + `SIGTERM` → `SIGKILL` after 10 s; Windows: `taskkill /T /F`    | A timeout must end children too                                                                          |
| Output bounding            | Streaming byte counter; 10 MiB cap on the machine; 64 KiB head ring + 64 KiB tail ring in the API | CONTRACTS §10                                                                                            |
| Persistence                | TypeORM entities `FleetCommand`, `FleetCommandRun`; raw uuid columns, no `@ManyToOne` (house rule, see `fleet-audit.entity.ts:26-27`) | Existing pattern                                                                                         |
| Live view                  | Viewer WS `wss://<api>/ws/fleet/command/:commandId`, attach token 60 s single-use (§3.4)         | Same posture as the computer and terminal gateways                                                       |
| Confirmation               | `confirmationToken` minted by `POST /api/fleet/commands/confirm` (TTL 5 min, bound to the payload hash) | Non-interactive callers (CLI, tools) can satisfy `confirm` class without a browser                        |
| i18n                       | `fleet.commands.*`, `fleet.errors.*` in `apps/web/messages/en.json`                              | CONTRACTS §11.4                                                                                          |

## 4. Data model

### 4.1 Entities (`packages/agent/src/entities/`)

`fleet-command.entity.ts` → `fleet_commands` — columns exactly as CONTRACTS §4.4: `id`, `userId`,
`organizationId?`, `nodeIds uuid[]` (stored `simple-json` for sqlite parity, as `fleet_audit.details` is), `command text`,
`cwd text?`, `timeoutSec int default 600`, `cadence simple-json?` (null in FL-12), `name text?`,
`enabled boolean default true`, `requestedBy varchar(8)` (`user · agent`), `requestedByAgentId uuid?`,
`state varchar(16)` (`queued · running · done · failed · cancelled`), `lastRunAt?`, `nextRunAt?`,
`createdAt`, `updatedAt`. Indexes `(userId, createdAt)`, `(userId, cadence)` (FL-13 reads it).

`fleet-command-run.entity.ts` → `fleet_command_runs` — `id`, `commandId`, `nodeId`, `startedAt`,
`endedAt?`, `exitCode int?`, `status varchar(16)` (`running · done · failed · timeout ·
skipped-overlap · skipped-offline`), `failedReason varchar(24)?` (see spec §8b), `outputHead text?`,
`outputTail text?`, `outputBytes bigint`, `truncated boolean`, `outputRef text?` (the node's run id
for full-output fetch). Unique `(commandId, nodeId, startedAt)`; index `(nodeId, startedAt)`.

### 4.2 Migrations (`apps/api/src/migrations/`)

| Slot                                     | Contents                                                                                      |
| ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| `1796120000000-CreateFleetCommands.ts`   | `fleet_commands`, its indexes, FK `userId → users` ON DELETE CASCADE                          |
| `1796120100000-CreateFleetCommandRuns.ts`| `fleet_command_runs`, indexes, FK `commandId → fleet_commands` ON DELETE CASCADE; **no FK on `nodeId`** (history outlives the node, as `fleet_audit.nodeId`) |

Forward-only; `down` drops exactly what `up` added. Re-stamp before merge if `develop` moved.

### 4.3 Contracts (`packages/contracts/src/fleet/`)

- `fleet-commands.types.ts` (new): `FleetCommandView`, `FleetCommandRunView`, `FLEET_COMMAND_RUN_STATUSES`,
  `FLEET_COMMAND_DEFAULT_TIMEOUT_SEC = 600`, `FLEET_COMMAND_MAX_TIMEOUT_SEC = 3600`,
  `FLEET_COMMAND_MAX_OUTPUT_BYTES = 10 * 1024 * 1024`, `FLEET_COMMAND_STORED_EDGE_BYTES = 64 * 1024`,
  `FLEET_COMMAND_RECENT = 8`, `FLEET_COMMAND_MAX_NODES = 50`, `FLEET_COMMAND_MAX_LENGTH = 8192`,
  link messages `command.run { commandId, runId, command, cwd, timeoutSec }`, `command.cancel { runId }`,
  `command.output { runId }`.
- `fleet-panic.types.ts`: add `node.command.run`, `node.command.cancel` to the union and array.
- Export from `packages/contracts/src/fleet/index.ts`.

## 5. API surface

All under `api/fleet`, `FleetEnabledGuard` + new `FleetFlagGuard('FLEET_COMMANDS_ENABLED')`, authenticated, scope-aware.

| Method | Path                                   | DTO (class-validator)                                          | Auth / family             | Rate   | Errors                                                                                  |
| ------ | -------------------------------------- | -------------------------------------------------------------- | ------------------------- | ------ | --------------------------------------------------------------------------------------- |
| POST   | `/commands/confirm`                    | `ConfirmCommandDto { command, nodeIds, cwd?, timeoutSec? }` → `{ confirmationToken, expiresAt, summary[] }` | caller in `commands` audience per node | 30/min | `invalid`, `permission_denied`, `consent_missing`, `unreachable` (reported per node in `summary`, not fatal) |
| POST   | `/commands`                            | `RunCommandDto { …same, confirmationToken }` → `202 FleetCommandView` | same                       | 10/min | `confirmation_required` (409), `kill_switch` (423), `limit_exceeded` (429), `permission_denied`, `consent_missing` |
| GET    | `/commands?limit=8`                    | → `FleetCommandView[]` (one-off only: `cadence IS NULL`)       | owner / audience           | 60/min | —                                                                                       |
| GET    | `/commands/:id`                        | → `FleetCommandView` with runs                                 | owner / audience           | 60/min | `not_found`                                                                             |
| GET    | `/commands/:id/runs`                   | → `FleetCommandRunView[]`                                      | owner / audience           | 60/min | `not_found`                                                                             |
| POST   | `/commands/:id/cancel`                 | → `202`                                                        | owner / audience           | 20/min | `not_found`, `unreachable`                                                              |
| POST   | `/commands/:id/attach-token`           | `?role=viewer` → `{ token, expiresInSec: 60 }`                 | owner / audience           | 30/min | `not_found`                                                                             |
| POST   | `/commands/:id/runs/:runId/output`     | → `202 { operationId }` (FL-02 operation; result is a download URL) | owner / audience      | 10/min | `unreachable` (hint names last-seen), `not_found`                                        |

Every error body is `{ error: { code, hint, details } }` (CONTRACTS §8). A cross-user id 404s
identically to an unknown one.

## 6. Node side

**Module:** `apps/node/src/core/commands/` — `command-runner.ts` (spawn, bound, kill),
`command-output-store.ts` (last 30 runs under `<configDir>/commands/`), `command-channel.ts`
(link channel handler). Registered in `apps/node/src/core/runtime.ts` beside the `computer-session`
registration (`:1062`) **only when `--manage` is on**; advertises nothing new (the `managed` tag
from FL-02 is the gate).

| OS      | Shell                                                   | Termination                         | Notes                                                       |
| ------- | ------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------- |
| Linux   | `$SHELL -l -c <cmd>` (fallback `/bin/sh -l -c`)         | process group `SIGTERM`→`SIGKILL`   | Login shell loads the owner's profile (PATH, nvm, …)         |
| macOS   | same                                                    | same                                | `zsh -l -c`                                                 |
| Windows | `powershell.exe -NoLogo -NonInteractive -Command <cmd>` | `taskkill /PID <pid> /T /F`         | Runs as the service account = the enrolling user (packaging) |

Channel protocol (one channel per run):

1. Platform `channel.open { channel, family: 'command', params: { commandId, nodeId } }` → node
   `channel.ready` or `channel.refused { code: 'consent_missing' | 'unsupported_on_node' }`.
2. Platform `JSON command.run { requestId, runId, command, cwd, timeoutSec }` → node validates
   `cwd` (home, or canonical path under an allowed root — R-18, pattern of `command-roots.ts`),
   spawns, replies `{ requestId, result: { pid, startedAt, shell } }`.
3. Node streams `DATA` (stdout and stderr interleaved as emitted, each chunk ≤ 64 KiB) until the
   10 MiB cap, then one `JSON command.truncated { runId, bytes }`.
4. Node sends `EXIT [code]` then `channel.close`; on timeout `JSON command.timeout { runId }`
   precedes `EXIT` with code `124`.
5. Platform `JSON command.cancel { requestId, runId }` at any time → node kills the tree, replies,
   `EXIT 130`.
6. `command.output { requestId, runId }` (separate channel, operation-backed) streams the stored
   file as `DATA` + `END`.

Consent: `manage`. Kill switch: the node receives `link.killSwitch { on: true }` from FL-02 and
terminates every running command (`EXIT 137`, reason `kill-switch`). Environment: `buildNodeCheckEnv`
allow-list; `FLEET_*`, `EVER_WORKS_*` never granted.

## 7. Plugin surface

None. Commands are OS facts executed by a node module (README D8).

## 8. Web surface

- Route: `/fleet/commands` — `apps/web/src/app/[locale]/(dashboard)/fleet/commands/page.tsx`;
  constant `DASHBOARD_FLEET_COMMANDS` in `apps/web/src/lib/constants.ts` (beside `DASHBOARD_SETTINGS_FLEET`, `:339`).
- Registry: `apps/web/src/components/fleet/registry.ts` gains the `commands` hub panel entry (FL-01's registry), code-split.
- Components under `apps/web/src/components/fleet/commands/`: `CommandsPanel.tsx` (composer,
  machine picker, cards, summary, recent), `CommandComposer.tsx`, `CommandNodePicker.tsx`
  (reasons from FL-01's shared node-state strings), `CommandConfirmDialog.tsx`, `CommandRunCard.tsx`
  (renders `DATA` with the existing terminal renderer factory `apps/web/src/components/terminal/create-terminal-renderer.ts`, R-21), `CommandSummaryLine.tsx`,
  `RecentCommands.tsx`, `use-command-attach.ts` (mirrors `apps/web/src/components/computer/use-computer-attach.ts`), `commands.shared.ts` (pure: preselection, reasons, summary).
- BFF: `apps/web/src/app/api/fleet/commands/{confirm,route,[id]/attach-token}/route.ts` — attach token minted server-side.
- i18n groups: `fleet.commands.{composer,picker,confirm,card,summary,recent,empty,errors}`.
- Playwright: `apps/web/e2e/flow-fleet-commands.spec.ts`, `apps/web/e2e/flow-fleet-commands-contract.spec.ts`.

## 9. Agent / MCP / CLI surface

| Surface | Name                                              | Annotation                                     | Notes                                                                      |
| ------- | ------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------- |
| Agent   | `fleet_commands_run`                              | `destructive: true`, `confirmationClass: confirm`, AW-24 category `machine.run` | Gated by tool grants + ladder + node `commands` audience (FL-19 gate helper) |
| Agent   | `fleet_commands_get`, `fleet_commands_list`       | `readOnly: true`                               |                                                                            |
| MCP     | `run_fleet_command` → `POST /api/fleet/commands`; `get_fleet_command`, `list_fleet_commands` | `destructiveHint` / `readOnlyHint` | Whitelist entries in `apps/mcp/src/openapi-tools/whitelist.ts` (FL-19 documents the full set) |
| CLI     | `ever-works fleet command run --on a,b [--timeout] [--cwd] [--json] -- <cmd>` | exit `0/1/2/124`       | `apps/cli/src/commands/fleet/command.ts`; streams via the viewer WS         |

## 10. Background jobs

None in FL-12. Stored heads/tails live with the command row; retention follows the existing
fleet job-body retention service (`apps/api/src/fleet/fleet-job-retention.service.ts`) extended
with a `fleet_command_runs` sweep (bodies nulled after 30 days, rows kept).

## 11. Security & permissions

- Threats: command injection is by design (the owner types a shell line) — the risk is **who** may
  type it, so the family audience, consent, confirm token and audit are the controls; the node
  refuses a `cwd` outside the owner's home or allowed roots; no stdin means no credential prompt
  can be answered; the environment is the allow-listed one, never the node process's.
- The node refuses: channel without `manage`; `cwd` escaping roots; a second `command.run` on an
  open channel; `timeoutSec > 3600`; `command` > 8 KiB.
- Redaction: `redactSecrets` on the command line before storage, on head/tail before storage, on
  every `details` blob (writer-side, `fleet-audit.service.ts:55`). Field names avoid the redaction
  key words (`commandRef`, not `commandHash`).
- Audit: one `node.command.run` per node with `{ family: 'commands', target: commandId, runId, nodeId, requestedBy, confirmationClass: 'confirm', outcome, exitCode, durationMs, truncated }`; `node.command.cancel` with `{ reason }`.

## 12. Observability

- Metrics: `fleet_commands_runs_total{status}`, `fleet_commands_duration_seconds`, `fleet_commands_truncated_total`, `fleet_commands_refused_total{code}`.
- Activity log: `fleet_command_run` (ActivityActionType, status from outcome) per Command, linking to the hub.
- Logs: command **names never values** — the command line is not logged; only ids, node, status.

## 13. Phased rollout

| Phase | Flag                       | Contents                                                                                               |
| ----- | -------------------------- | ------------------------------------------------------------------------------------------------------ |
| P1    | `FLEET_COMMANDS_ENABLED`   | Entities, migrations, contracts, service, controller, node module, hub tab, viewer WS, CLI verb, audit |
| P2    | same                       | Agent tool + MCP entries, computer-page `⋯ › Run a command…`, cancel, full output as operation         |
| P3    | same                       | Folder picker from FL-14 checkouts; re-run from history; hand-over of `cadence` to FL-13                |

## 14. Test plan

| Package              | Runner     | Specs                                                                                                                                            |
| -------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/contracts` | Vitest     | `src/fleet/__tests__/fleet-commands.spec.ts` (constants, guards); `fleet-panic.spec.ts` extended for the two actions                              |
| `packages/agent`     | Jest       | `src/fleet/__tests__/fleet-command.service.spec.ts` (limits, audience, consent, kill switch, head/tail accumulator, state machine); `fleet-audit.service.spec.ts` extended |
| `apps/api`           | Jest       | `src/fleet/fleet-commands.controller.spec.ts` (every refusal code + hint; 404-never-403); `src/fleet/fleet-command-ws.service.spec.ts`            |
| `apps/node`          | Vitest     | `src/core/commands/command-runner.spec.ts` (shell per OS, no stdin, timeout kills tree, 10 MiB cap); `command-output-store.spec.ts` (30-run ring); `command-channel.spec.ts` (refusals, cancel, kill switch) |
| `apps/cli`           | Vitest     | `src/commands/fleet/__tests__/command.spec.ts` (exit codes, `--json` shape)                                                                      |
| `apps/web`           | Vitest     | `components/fleet/commands/commands.shared.unit.spec.ts`; `CommandConfirmDialog.unit.spec.tsx`                                                   |
| `apps/web`           | Playwright | `e2e/flow-fleet-commands.spec.ts` (golden path, greyed reasons, recent); `e2e/flow-fleet-commands-contract.spec.ts` (API refusals)              |

## 15. Risks

| Risk                                                        | Likelihood | Impact | Mitigation                                                                        |
| ----------------------------------------------------------- | ---------- | ------ | --------------------------------------------------------------------------------- |
| Owners run destructive one-liners on many machines at once  | Medium     | High   | Confirm dialog names every machine; 50-node cap; audit; kill switch stops in flight |
| Output floods the relay                                     | Medium     | Medium | 64 KiB chunks, 10 MiB cap on the node, viewer back-pressure via FL-02 `ACK`        |
| Login shell differs from what the owner expects (service account) | Medium | Low   | Dialog names the user and shell; Windows service runs as the enrolling user       |
| FL-02 lands late                                            | Medium     | High   | P1 behind the flag; the service and entities are testable with a fake link        |

## 16. Constitution reconciliation

I n/a (no external integration) · II n/a · III no content stored · IV ephemeral by contract, no API-process long work · V two slot migrations · VI tests per package above · VII redaction at every write · VIII no plugin · IX spec holds no code · X additive only.

## 17. References

Spec `./spec.md` · Tasks `./tasks.md` · CONTRACTS §3.3, §4.4, §7, §8, §10, §11, §12, §13 · FL-02 plan (link, operations) · FL-01 plan (registry, roles) · FL-19 plan (tool gate, CLI group)
