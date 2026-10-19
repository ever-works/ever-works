# FL-19 — Agent, MCP & CLI surface · Implementation plan

> How [`spec.md`](./spec.md) gets built. Implementation detail belongs here, not in the spec
> (Constitution IX). Every path below was opened at this branch's base (`origin/develop`
> `e4334baf7`) before it was cited.

**Epic ID:** `FL-19-agent-mcp-cli`
**Spec:** [`./spec.md`](./spec.md) · **Tasks:** [`./tasks.md`](./tasks.md)
**Status:** `Draft`
**Created:** 2026-10-18
**Last updated:** 2026-10-18

---

## 1. Architecture summary

```mermaid
flowchart LR
    subgraph Callers
        AG[Agent run: fleet_* tool]
        MCP[MCP server: whitelist tool]
        CLI[ever-works fleet …]
    end
    AG -->|invoke| GATE[FleetToolGate<br/>grants → ladder → audience → consent]
    GATE -->|Ask/Draft| DEC[Decision (AW-03)]
    GATE -->|Auto| API[/api/fleet/* controllers (FL-04…18)]
    DEC -->|approved| API
    MCP -->|HTTP as API-key user| API
    CLI -->|HTTP as signed-in user| API
    API --> FS[Family services]
    FS -->|link request| LINK[Node link relay (FL-02)]
    LINK --> NODE[Node modules]
    NODE -->|result / operation progress| LINK --> FS
    FS -->|audit requestedBy user:|agent:| AU[(fleet_audit)]
    FS -->|operation| OPS[GET /api/fleet/operations/:id]
    CLI -->|attach token + wss://…/ws/fleet/session/:id| LINK
```

Agents and MCP share the controllers; only Agents pass through the gate (MCP acts as a person).
Confirmation is a controller concern with one mechanism for every caller — the web, tools, MCP and
the CLI send the same request fields `confirm` / `confirmName` / `acknowledgeBlastRadius`, and a call
without them gets 409 `confirmation_required` with `details: { class, summary, preview?, sentence? }`
(CONTRACTS §2.2). There are no confirmation tokens, so every surface hits one code path.

## 2. Current state in the codebase

| Piece                                        | Where (verified at HEAD)                                                                                                                                              | Reused as                                                                                                |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| The one fleet tool                           | `packages/agent/src/fleet/agent-fleet-tools.ts:32-80` (`buildFleetTools`, `list_fleet_nodes`)                                                                         | Factory grows into the catalogue                                                                         |
| Tool descriptors (no annotations)            | `packages/agent/src/tasks-domain/agent-task-tools.ts:39-55` (`TaskToolDescriptor`), `packages/agent/src/agents/agent-tool.service.ts:128-137` (`AgentToolDescriptor`) | Optional `annotations` added                                                                             |
| Domain tool assembly, fleet source           | `agent-tool.service.ts:467-482` (`buildDomainTools`, `add`), `:524-527` (`add('fleet', …)`)                                                                           | Gate injected into the fleet factory                                                                     |
| Tool-grant enforcer (appended `@Optional()`) | `agent-tool.service.ts:76-83, 210-216, 668-674`; contract `packages/contracts/src/policy/tool-grant.types.ts:20-67`                                                   | Gate step 4                                                                                              |
| Trust ladder, categories, safety gate        | `packages/agent/src/safety/trust-ladder.ts`, `action-category.ts`, `safety-gate.service.ts`, `safety-gate.port.ts`, `rail-refusal.service.ts`                         | Gate step 5 (categories `machine.run`, `machine.admin`, `agent.fanout`, `write.destructive`, AW-24 §4.1) |
| Node control policy                          | `packages/agent/src/entities/fleet-node.entity.ts:502` (`controlPolicy`), family map + role derivation from FL-01                                                     | Gate step 7                                                                                              |
| Kill switch                                  | `packages/agent/src/fleet/fleet-kill-switch.service.ts` (exported by `fleet.module.ts:111-123`)                                                                       | Gate step 1                                                                                              |
| Fleet audit writer                           | `packages/agent/src/fleet/fleet-audit.service.ts:64-72`                                                                                                               | `requestedBy` in `details`                                                                               |
| MCP whitelist and registration               | `apps/mcp/src/openapi-tools/whitelist.ts:1-21` (`WhitelistEntry` with `annotations`, `omitArgs`), `:475-530` (fleet entries); `tool-registration.service.ts:51-102`   | New entries; nothing else changes                                                                        |
| CLI entry, command shape, error handler      | `apps/cli/src/main.ts:17-29`; `apps/cli/src/commands/kb/list.ts:46-127` (commander + `requireAuth` + `getHttpClient`); `apps/cli/src/utils/error.ts:3-32`             | New `fleet` group; a JSON-aware error path added beside the existing one                                 |
| Viewer attach tokens and WS                  | CONTRACTS §3.4; FL-04 `POST /api/fleet/sessions/:id/attach-token`, `wss://<api>/ws/fleet/session/:id`                                                                 | `fleet session attach`                                                                                   |
| Operations                                   | FL-02 `GET /api/fleet/operations/:id`                                                                                                                                 | `fleet_operations_get`, CLI `fleet operation get`                                                        |
| Needs-a-look registry                        | FL-01 `packages/agent/src/fleet/needs-a-look.registry.ts`                                                                                                             | `fleet_status`                                                                                           |

Missing today: any annotation on a tool descriptor; any check joining grants, ladder and a Node's
audience; any fleet CLI verb; any `--json`/exit-code contract in the CLI; `fleet_status`.

## 3. Tech choices

| Concern           | Choice                                                                                                                                                                                                                                          | Why                                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Catalogue         | One declarative table `FLEET_TOOL_CATALOGUE` in contracts (`name`, `family`, `verb`, `readOnly`, `destructive`, `confirmationClass`, `category`, `permissionFamily`, `route`) consumed by the Agent factory, the MCP whitelist test and the CLI | One source for three surfaces; tests assert parity                                     |
| Gate              | `FleetToolGate` in `packages/agent/src/fleet/fleet-tool-gate.ts`, pure decision function + thin service; order = AW-24 FR-19                                                                                                                    | Testable truth table; reuses the existing safety gate port rather than a second ladder |
| Confirmation      | Body fields `confirm`, `confirmName`, `acknowledgeBlastRadius` for every caller; 409 `confirmation_required` with `details: { class, summary, preview?, sentence? }`; the confirming call is evaluated against current state (spec U8)          | CONTRACTS §2.2: one mechanism, no tokens, no signed summaries                          |
| Operations        | FL-02 operations; tools add `wait` (default true, 25 s cap) then fall back to `{ operationId }`                                                                                                                                                 | Long node work never blocks a model turn                                               |
| CLI JSON envelope | `{ ok: true, data } \| { ok: false, error: { code, hint, details } }`, exit map `0/1/2/124`                                                                                                                                                     | CONTRACTS §11.3                                                                        |
| CLI attach        | `ws` client, raw-mode TTY, `Ctrl-]` detach, `--drive` requests role `driver`                                                                                                                                                                    | Same viewer protocol as the web (R-21: one renderer, here the user's own terminal)     |
| MCP               | Whitelist entries only; existing eight names kept; new entries use `fleet_<family>_<verb>`                                                                                                                                                      | Additive; CONTRACTS §11.3                                                              |
| Held actions      | Ask/Draft rungs write an `agent_action_proposals` row, `actionType: 'fleet_machine_action'` (FL-09's value; `actionType` is a varchar with no DB check), the tool call as payload; approval re-runs it with the class field set                 | CONTRACTS R-33; no new table                                                           |
| i18n              | `fleet.tools.*` for the Capabilities block and decision cards                                                                                                                                                                                   | CONTRACTS §11.4                                                                        |

## 4. Data model

No schema change (FL-19 has no CONTRACTS §13 slot). Contract additions only:

- `packages/contracts/src/fleet/fleet-tools.types.ts` (new): `FleetToolAnnotation { readOnly?: true; destructive?: boolean; confirmationClass?: 'plain'|'confirm'|'confirm-destructive'|'blast-radius'; category?: AgentActionCategory; permissionFamily: FleetActionFamily }`,
  `FleetToolCatalogueEntry`, `FLEET_TOOL_CATALOGUE` (every tool of every family, §9 below),
  `FleetToolError = { error: { code: FleetErrorCode; hint: string; details?: Record<string, unknown> } }`,
  `FleetConfirmArgs { confirm?: boolean; confirmName?: string; acknowledgeBlastRadius?: boolean; wait?: boolean }`,
  `FleetStatusView { computers[], needsALook[], killSwitch, generatedAt }`.
- `packages/agent/src/tasks-domain/agent-task-tools.ts:39-55` and `agent-tool.service.ts:128-137`:
  optional `annotations?: FleetToolAnnotation` on both descriptors (additive).
- Audit `details.requestedBy` is already free-form (`fleet-audit.entity.ts:59-61`); the gate
  stamps `requestedBy: 'agent:<id>'` and `decisionId` when present.

## 5. API surface

No new fleet routes except one read:

| Method | Path                             | Shape                                                                        | Auth        | Rate   | Errors      |
| ------ | -------------------------------- | ---------------------------------------------------------------------------- | ----------- | ------ | ----------- |
| GET    | `/api/fleet/status`              | `FleetStatusView`                                                            | `view`      | 60/min | —           |
| GET    | `/api/fleet/tools/gate?agentId=` | per-family `{ read, act, refusedBy?, fixRoute? }` for the Capabilities block | Agent owner | 60/min | `not_found` |

Every family controller (FL-04…18) accepts `FleetConfirmArgs` in the body and returns 409
`confirmation_required` with `details: { class, summary, preview?, sentence? }` when the class is not
satisfied (CONTRACTS §2.2) — a shared `FleetConfirmationInterceptor` in
`apps/api/src/fleet/fleet-confirmation.interceptor.ts` does this uniformly, reading the class from the
catalogue entry for the route. Nothing is stored between the two calls. Operation states are C §3.3's
`running · done · failed · cancelled · interrupted`.

## 6. Node side

None. FL-19 never talks to a machine; every call goes through a family controller. The node
refuses nothing new.

## 7. Plugin surface

None.

## 8. Web surface

- Agent › Capabilities tab: `apps/web/src/components/agents/AgentFleetToolsSection.tsx` beside
  `AgentFleetSection.tsx`, fed by `GET /api/fleet/tools/gate`; pure helper
  `apps/web/src/components/agents/agent-fleet-tools.shared.ts`.
- My Decisions: `apps/web/src/components/approvals/FleetActionDecisionCard.tsx` (one component,
  mounted in the approvals queue and in the Agent conversation), rendering the family's own
  confirmation text.
- i18n: `fleet.tools.{capabilities,decision,reasons}`.
- Playwright: `apps/web/e2e/flow-fleet-agent-tools-capabilities.spec.ts`, `apps/web/e2e/flow-fleet-agent-tools-decision.spec.ts`.

## 9. Agent / MCP / CLI surface

### 9.1 Catalogue (Agent tool name · annotation · class · category · permission family · route)

Each row is **defined by its owning epic's plan §9**; this table assembles them into
`FLEET_TOOL_CATALOGUE`. Where this table and an owner disagree, the owner is right and this table is
corrected (the audit of 2026-10-18 aligned every row below with its owner). Annotation shorthand:
`destructive? · confirmation class · AW-24 category`. Family = the tool family of FR-1; Permission =
the CONTRACTS §2.1 family the gate checks.

| Family     | Read-only tools (owner)                                                                                                                                                                            | State-changing tools (destructive? · class · category) (owner)                                                                                                                                                                                                                                                                                                                                                           | Permission (§2.1)                                  |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| status     | `fleet_status` (FL-19)                                                                                                                                                                             | —                                                                                                                                                                                                                                                                                                                                                                                                                        | view                                               |
| nodes      | `fleet_nodes_list`, `fleet_nodes_get` (FL-19); `fleet_nodes_health` (`range?`, `fresh: true` runs `health.now` — R-31), `fleet_nodes_needs_a_look` (FL-03); `fleet_nodes_git_identity_get` (FL-15) | `fleet_nodes_wake` (no · plain · machine.admin) (FL-03); `fleet_nodes_git_identity_set` (no · confirm · machine.admin) (FL-15)                                                                                                                                                                                                                                                                                           | view; wake → machines; git identity set → commands |
| sessions   | `fleet_sessions_list`, `fleet_sessions_read` (FL-04); `fleet_sessions_question` (FL-05); `fleet_sessions_actions_list` (FL-06)                                                                     | `fleet_sessions_start` (no · plain · machine.run; accepts `taskId` — FL-15) (FL-04), `fleet_sessions_send` (no · plain · machine.run) (FL-04), `fleet_sessions_answer` (no · confirm · machine.run; questions only, R-32) (FL-05), `fleet_sessions_rename` (no · plain · write.internal) (FL-04), `fleet_sessions_end` (yes · confirm · machine.run) (FL-04), `fleet_sessions_action` (no · plain · machine.run) (FL-06) | sessions                                           |
| desktop    | `fleet_desktop_screenshot`, `fleet_desktop_displays`, `fleet_desktop_recordings_list` (FL-07)                                                                                                      | `fleet_desktop_input` (yes · plain · machine.admin; the control grant is the gate) (FL-07), `fleet_desktop_set_display` (no · plain · machine.admin) (FL-07), `fleet_desktop_display_add` / `_remove` (yes · confirm · machine.admin; P3) (FL-07), `fleet_desktop_paste` (yes · plain · machine.admin; denied unless granted, AW-15) (FL-11)                                                                             | desktop                                            |
| logs       | `fleet_logs_sources`, `fleet_logs_read` (FL-08)                                                                                                                                                    | —                                                                                                                                                                                                                                                                                                                                                                                                                        | logs                                               |
| services   | `fleet_services_list` (FL-09)                                                                                                                                                                      | `fleet_services_action` (yes · confirm or blast-radius · machine.admin) (FL-09)                                                                                                                                                                                                                                                                                                                                          | services                                           |
| processes  | `fleet_processes_list` (FL-09)                                                                                                                                                                     | `fleet_processes_signal` (yes · confirm · machine.admin) (FL-09)                                                                                                                                                                                                                                                                                                                                                         | processes                                          |
| docker     | `fleet_docker_containers_list`, `fleet_docker_images_list`, `fleet_docker_compose_list`, `fleet_docker_compose_describe` (FL-09)                                                                   | `fleet_docker_container_action` (yes · confirm, `remove` confirm-destructive · machine.admin), `fleet_docker_run` (no · confirm · machine.admin; explicit grant), `fleet_docker_image_action` (`pull` no, `remove`/`prune` yes · per FL-09 §4 · machine.admin), `fleet_docker_compose_action` (yes for `down` · confirm · machine.admin), `fleet_docker_exec` (no · plain · machine.run; P3) (all FL-09)                 | docker                                             |
| ports      | `fleet_ports_list` (FL-10)                                                                                                                                                                         | `fleet_ports_open` (no · plain · machine.run), `fleet_ports_preview_open` (no · plain · machine.run; P2), `fleet_ports_preview_close` (no · plain · machine.run; P2) (FL-10)                                                                                                                                                                                                                                             | view (list); ports (open, preview)                 |
| files      | `fleet_files_list`, `fleet_files_stat`, `fleet_files_read` (download) (FL-11)                                                                                                                      | `fleet_files_write` (upload; yes · confirm · machine.admin), `fleet_files_copy` (yes · confirm · machine.admin), `fleet_files_delete` (yes · confirm-destructive · write.destructive; always held, R-33) (FL-11)                                                                                                                                                                                                         | files                                              |
| commands   | `fleet_commands_list`, `fleet_commands_get` (FL-12)                                                                                                                                                | `fleet_commands_run` (yes · confirm · machine.run), `fleet_commands_cancel` (no · plain · machine.run) (FL-12)                                                                                                                                                                                                                                                                                                           | commands                                           |
| schedules  | `fleet_schedules_list`, `fleet_schedules_get`, `fleet_schedules_runs` (FL-13)                                                                                                                      | `fleet_schedules_create`, `fleet_schedules_update` (yes · confirm · agent.fanout), `fleet_schedules_delete` (yes · confirm · write.destructive), `fleet_schedules_run` (yes · confirm · machine.run), `fleet_schedules_pause` / `_resume` (no · plain · agent.fanout) (FL-13)                                                                                                                                            | schedules                                          |
| checkouts  | `fleet_checkouts_list`, `fleet_checkouts_get` (FL-14); `fleet_checkouts_changes` (FL-06)                                                                                                           | `fleet_checkouts_create` (no · plain · machine.run), `fleet_checkouts_sync` (no · plain for fetch, confirm for pull/push · machine.run), `fleet_checkouts_archive` (no · confirm · machine.run), `fleet_checkouts_delete` (yes · confirm / confirm-destructive · write.destructive) (FL-14); `fleet_checkouts_open_pull_request` (no · plain · publish.external) (FL-06)                                                 | checkouts                                          |
| tasks      | `fleet_tasks_handoff_options` (FL-15)                                                                                                                                                              | — (the hand-off itself is `fleet_sessions_start` with `taskId`; no second start tool)                                                                                                                                                                                                                                                                                                                                    | sessions                                           |
| virtual    | `fleet_virtual_list`, `fleet_virtual_options` (FL-16)                                                                                                                                              | `fleet_virtual_create` (yes · confirm · machine.admin), `fleet_virtual_power` (yes · plain start / confirm stop · machine.admin), `fleet_virtual_destroy` (yes · confirm-destructive · write.destructive) (FL-16)                                                                                                                                                                                                        | view (reads); machines                             |
| cloud      | `fleet_cloud_list`, `fleet_cloud_options`, `fleet_cloud_usage` (FL-17)                                                                                                                             | `fleet_cloud_create` (yes · confirm with the price · spend.metered + machine.admin), `fleet_cloud_power` (yes · confirm · machine.admin), `fleet_cloud_destroy` (yes · confirm-destructive · write.destructive), `fleet_cloud_idle_policy` (no · plain · machine.admin) (FL-17)                                                                                                                                          | view (reads); machines                             |
| runners    | `fleet_runners_list`, `fleet_runners_jobs` (FL-18)                                                                                                                                                 | `fleet_runners_install` (yes · confirm · machine.admin), `fleet_runners_action` (yes · plain start / confirm stop and restart · machine.admin), `fleet_runners_remove` (yes · confirm-destructive · write.destructive), `fleet_runners_cancel_run` (yes · confirm · machine.admin; "Cancel workflow run", R-37) (FL-18)                                                                                                  | view (reads); machines                             |
| usage      | `fleet_usage_get` (FL-20)                                                                                                                                                                          | —                                                                                                                                                                                                                                                                                                                                                                                                                        | view                                               |
| operations | `fleet_operations_get` (FL-02), `fleet_operations_list` (FL-19)                                                                                                                                    | `fleet_operations_cancel` (no · plain · machine.run) (FL-02)                                                                                                                                                                                                                                                                                                                                                             | view                                               |

Every entry's `route` is the owning epic's controller path; the factory builds the tool from the
entry and a typed invoker, so adding a family is one table row plus a route. The legacy
`list_fleet_nodes` and the eight existing MCP entries stay as they are beside these (C §11.3). The
family segments `virtual`, `cloud`, `usage` and `status` are API path segments rather than plural
nouns (C §11.3 says "plural families"); that wording is raised with the CONTRACTS maintainer in the
audit report and nothing here waits on it.

### 9.2 MCP additions (`apps/mcp/src/openapi-tools/whitelist.ts`)

One entry per catalogue row that has a route, `toolName` = the catalogue name, `annotations:
{ readOnlyHint: true }` for reads and `{ destructiveHint: <destructive> }` otherwise, `description`
hand-written where the OpenAPI summary would leave the model guessing (as the affinity entries do,
`:481-485`). Never added: `/api/fleet/enroll`, `/heartbeat`, `/jobs/*`, `/rotate-credential`,
`/link-token`, `/nodes/enrollment-token`, `/api/internal/fleet/*`. A test enumerates the catalogue
and the whitelist and fails on a missing or extra fleet entry, and on any forbidden path.

### 9.3 CLI (`apps/cli/src/commands/fleet/`)

`index.ts` (group, `--json`, exit map, `--yes`, `--confirm-name`, `--wait/--no-wait`), `fleet-output.ts`,
`fleet-exit.ts`, `fleet-confirm.ts`, `fleet-client.ts` (typed wrapper over `getHttpClient`), and one
file per family. Command groups are the plural families of CONTRACTS §11.3 (`ever-works fleet
sessions|commands|schedules|checkouts|runners|nodes|operations …`); each also answers to its singular
(`session`, `command`, `schedule`, `checkout`, `runner`, `node`, `operation`) as a commander alias, so
the singular forms FL-04, FL-05, FL-12 and FL-13 quote keep working. Files, named as the owning epics
name them: `status.ts`, `nodes.ts` (FL-03 health/wake, FL-15 git identity), `session.ts` (FL-04, FL-05,
FL-06, FL-15 verbs; `attach` via `session-attach.ts`, `ws`), `desktop.ts` (FL-07, FL-11 paste),
`logs.ts`, `services.ts`, `processes.ts`, `docker.ts`, `ports.ts`, `files.ts` (FL-11), `command.ts`
(FL-12), `schedule.ts` (FL-13), `checkout.ts` (FL-14), `virtual.ts` (FL-16), `cloud.ts` (FL-17),
`runners.ts` (FL-18), `usage.ts` (FL-20), `operation.ts`.
Registered in `apps/cli/src/main.ts` beside `registerKbCommands`. `apps/cli/src/utils/error.ts`
gains `handleFleetCliError(error, { json })` that maps an API `{ error }` body to the envelope and
exit code without changing the existing `handleCliError`.

## 10. Background jobs

None.

## 11. Security & permissions

- Gate order (AW-24 FR-19): 1 kill switch → 2 Workspace pause → 3 Agent/Mission/Run pause →
  4 tool grants → 5 ladder (category per row) → 6 caps → 7 computer family audience + consent
  (category-specific rule). Published as a constant array, not control flow.
- Refusals at 4–5 go through `RailRefusalService` (AW-24); refusals at 7 return
  `permission_denied` / `consent_missing` and create no Decision.
- Confirmation is re-evaluated on every call against the current state (C §2.2: no tokens, no
  signed summaries); a blast-radius sentence that appears between the calls re-issues
  `confirmation_required`.
- Tools never return credentials, raw paths outside roots, or unredacted output — the family
  services already guarantee that; FL-19 adds a test that every tool result passes `redactSecrets`.
- MCP acts as the API-key user: the Node audience is checked for that user; Organization-scoped
  checks need `EVER_WORKS_SCOPE_SLUG` (existing note, `whitelist.ts:28-29`).
- CLI keeps tokens in the existing credential store (`apps/cli/src/commands/auth/credentials.service.ts`).

## 12. Observability

Metrics `fleet_tool_calls_total{tool,outcome}`, `fleet_tool_gate_refusals_total{gate}`,
`fleet_tool_decisions_total`; audit `requestedBy`; AW-24 refusal records.

## 13. Phased rollout

| Phase | Flag                                            | Contents                                                                                                                                                                           |
| ----- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1    | each family's flag                              | Catalogue, annotations, gate (reads), `fleet_status`, read tools, confirmation interceptor, operations wait, CLI group with reads + `status`, MCP read entries, Capabilities block |
| P2    | same                                            | State-changing tools, Decisions, `fleet_sessions_question\|answer`, CLI acts + `session attach`, MCP act entries, audit stamps                                                     |
| P3    | `FLEET_VIRTUAL\|CLOUD\|ACTIONS_RUNNERS_ENABLED` | machines and runners tools; agent-facing doc; shell completion                                                                                                                     |

## 14. Test plan

| Package              | Runner     | Specs                                                                                                                                                                                                                                                                                |
| -------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/contracts` | Vitest     | `src/fleet/__tests__/fleet-tools.catalogue.spec.ts` — every name matches the pattern; every non-read row has class + category; no duplicates                                                                                                                                         |
| `packages/agent`     | Jest       | `src/fleet/__tests__/fleet-tool-gate.spec.ts` — full truth table (grant allow/deny × rung × audience × consent × kill switch), first-refusal naming; `agent-fleet-tools.spec.ts` — every tool built from the catalogue, annotations present, `requestedBy` stamped, results redacted |
| `apps/api`           | Jest       | `src/fleet/fleet-confirmation.interceptor.spec.ts` — three classes, stale summary; `fleet-status.controller.spec.ts`; `fleet-tools-gate.controller.spec.ts`                                                                                                                          |
| `apps/mcp`           | Vitest     | `src/openapi-tools/__tests__/whitelist.fleet.spec.ts` — parity with the catalogue; forbidden paths absent; existing eight unchanged                                                                                                                                                  |
| `apps/cli`           | Vitest     | `src/commands/fleet/__tests__/{index,status,session-attach,confirm}.spec.ts` — envelope, exit codes, `--yes`, non-TTY, detach                                                                                                                                                        |
| `apps/web`           | Vitest     | `components/agents/agent-fleet-tools.shared.unit.spec.ts`; `FleetActionDecisionCard.unit.spec.tsx`                                                                                                                                                                                   |
| `apps/web`           | Playwright | `e2e/flow-fleet-agent-tools-capabilities.spec.ts`; `e2e/flow-fleet-agent-tools-decision.spec.ts`                                                                                                                                                                                     |

## 15. Risks

| Risk                                                            | Likelihood | Impact | Mitigation                                                                                    |
| --------------------------------------------------------------- | ---------- | ------ | --------------------------------------------------------------------------------------------- |
| Catalogue drifts from the family controllers                    | High       | Medium | Parity tests on three surfaces; a family PR must add its row                                  |
| A caller sends a token-style confirmation instead of the fields | Low        | Low    | C §2.2 has no tokens; the interceptor ignores unknown fields and answers 409 with the preview |
| Agents loop on `confirmation_required`                          | Medium     | Low    | Hint says exactly what to send; summary stable for 5 min                                      |
| MCP naming inconsistency                                        | High       | Low    | C §11.3 keeps the eight legacy names; the parity test allows exactly those                    |

## 16. Constitution reconciliation

I n/a · II n/a · III n/a · IV operations are FL-02's · V no schema · VI tests per package · VII no credential crosses a tool · VIII n/a · IX spec code-free · X additive (optional annotations, kept names).

## 17. References

Spec `./spec.md` · Tasks `./tasks.md` · CONTRACTS §2, §3.3, §7, §8, §11.3, R-32, R-33 · AW-15 §4.3 · AW-24 §4.1–4.3 · FL-01 plan (roles, needs-a-look) · FL-02 plan (operations) · FL-04 plan (attach tokens) · every family epic's plan §9 (the catalogue rows)
