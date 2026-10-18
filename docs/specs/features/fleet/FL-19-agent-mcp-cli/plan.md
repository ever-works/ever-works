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
Confirmation is a controller concern (`confirmationToken` for the web, `confirm`/`confirmName`/
`acknowledgeBlastRadius` body fields for tools and CLI), so every surface hits one code path.

## 2. Current state in the codebase

| Piece                                                     | Where (verified at HEAD)                                                                                                                  | Reused as                                                                            |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| The one fleet tool                                        | `packages/agent/src/fleet/agent-fleet-tools.ts:32-80` (`buildFleetTools`, `list_fleet_nodes`)                                            | Factory grows into the catalogue                                                     |
| Tool descriptors (no annotations)                         | `packages/agent/src/tasks-domain/agent-task-tools.ts:39-55` (`TaskToolDescriptor`), `packages/agent/src/agents/agent-tool.service.ts:128-137` (`AgentToolDescriptor`) | Optional `annotations` added                                                         |
| Domain tool assembly, fleet source                        | `agent-tool.service.ts:467-482` (`buildDomainTools`, `add`), `:524-527` (`add('fleet', …)`)                                               | Gate injected into the fleet factory                                                 |
| Tool-grant enforcer (appended `@Optional()`)              | `agent-tool.service.ts:76-83, 210-216, 668-674`; contract `packages/contracts/src/policy/tool-grant.types.ts:20-67`                        | Gate step 4                                                                          |
| Trust ladder, categories, safety gate                     | `packages/agent/src/safety/trust-ladder.ts`, `action-category.ts`, `safety-gate.service.ts`, `safety-gate.port.ts`, `rail-refusal.service.ts` | Gate step 5 (categories `machine.run`, `machine.admin`, `agent.fanout`, `write.destructive`, AW-24 §4.1) |
| Node control policy                                       | `packages/agent/src/entities/fleet-node.entity.ts:502` (`controlPolicy`), family map + role derivation from FL-01                           | Gate step 7                                                                          |
| Kill switch                                               | `packages/agent/src/fleet/fleet-kill-switch.service.ts` (exported by `fleet.module.ts:111-123`)                                           | Gate step 1                                                                          |
| Fleet audit writer                                        | `packages/agent/src/fleet/fleet-audit.service.ts:64-72`                                                                                   | `requestedBy` in `details`                                                           |
| MCP whitelist and registration                            | `apps/mcp/src/openapi-tools/whitelist.ts:1-21` (`WhitelistEntry` with `annotations`, `omitArgs`), `:475-530` (fleet entries); `tool-registration.service.ts:51-102` | New entries; nothing else changes                                                    |
| CLI entry, command shape, error handler                   | `apps/cli/src/main.ts:17-29`; `apps/cli/src/commands/kb/list.ts:46-127` (commander + `requireAuth` + `getHttpClient`); `apps/cli/src/utils/error.ts:3-32` | New `fleet` group; a JSON-aware error path added beside the existing one             |
| Viewer attach tokens and WS                               | CONTRACTS §3.4; FL-04 `POST /api/fleet/sessions/:id/attach-token`, `wss://<api>/ws/fleet/session/:id`                                     | `fleet session attach`                                                               |
| Operations                                                | FL-02 `GET /api/fleet/operations/:id`                                                                                                     | `fleet_operations_get`, CLI `fleet operation get`                                    |
| Needs-a-look registry                                     | FL-01 `packages/agent/src/fleet/needs-a-look.registry.ts`                                                                                  | `fleet_status`                                                                       |

Missing today: any annotation on a tool descriptor; any check joining grants, ladder and a Node's
audience; any fleet CLI verb; any `--json`/exit-code contract in the CLI; `fleet_status`.

## 3. Tech choices

| Concern                 | Choice                                                                                                                                       | Why                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Catalogue               | One declarative table `FLEET_TOOL_CATALOGUE` in contracts (`name`, `family`, `verb`, `readOnly`, `destructive`, `confirmationClass`, `category`, `permissionFamily`, `route`) consumed by the Agent factory, the MCP whitelist test and the CLI | One source for three surfaces; tests assert parity                                       |
| Gate                    | `FleetToolGate` in `packages/agent/src/fleet/fleet-tool-gate.ts`, pure decision function + thin service; order = AW-24 FR-19                 | Testable truth table; reuses the existing safety gate port rather than a second ladder    |
| Confirmation for tools  | Body fields `confirm`, `confirmName`, `acknowledgeBlastRadius`; summary hash echoed in `details.summaryHash`                                  | Mirrors FL-12's `confirmationToken` without needing a browser round trip                 |
| Operations              | FL-02 operations; tools add `wait` (default true, 25 s cap) then fall back to `{ operationId }`                                               | Long node work never blocks a model turn                                                 |
| CLI JSON envelope       | `{ ok: true, data } | { ok: false, error: { code, hint, details } }`, exit map `0/1/2/124`                                                   | CONTRACTS §11.3                                                                         |
| CLI attach              | `ws` client, raw-mode TTY, `Ctrl-]` detach, `--drive` requests role `driver`                                                                  | Same viewer protocol as the web (R-21: one renderer, here the user's own terminal)        |
| MCP                     | Whitelist entries only; existing eight names kept; new entries use `fleet_<family>_<verb>`                                                   | Additive; CONTRACTS §11.3                                                               |
| i18n                    | `fleet.tools.*` for the Capabilities block and decision cards                                                                                 | CONTRACTS §11.4                                                                         |

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

| Method | Path                     | Shape                       | Auth     | Rate   | Errors                       |
| ------ | ------------------------ | --------------------------- | -------- | ------ | ---------------------------- |
| GET    | `/api/fleet/status`      | `FleetStatusView`           | `view`   | 60/min | —                            |
| GET    | `/api/fleet/tools/gate?agentId=` | per-family `{ read, act, refusedBy?, fixRoute? }` for the Capabilities block | Agent owner | 60/min | `not_found` |

Every family controller (FL-04…18) accepts `FleetConfirmArgs` in the body and returns
`confirmation_required` with `details.summary` + `summaryHash` when the class is not satisfied —
a shared `FleetConfirmationInterceptor` in `apps/api/src/fleet/fleet-confirmation.interceptor.ts`
does this uniformly, reading the class from the catalogue entry for the route.

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

| Family     | Read-only tools                                                                 | State-changing tools (destructive? · class · category)                                                                                                                     | Family (§2.1) |
| ---------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| status     | `fleet_status`                                                                  | —                                                                                                                                                                         | view          |
| nodes      | `fleet_nodes_list`, `fleet_nodes_get`, `fleet_nodes_health`, `fleet_nodes_needs_a_look` | `fleet_nodes_wake` (no · plain · machine.admin)                                                                                                                     | view / machines† |
| sessions   | `fleet_sessions_list`, `fleet_sessions_get`, `fleet_sessions_read`, `fleet_sessions_question` | `fleet_sessions_start` (no · plain · machine.run), `fleet_sessions_send` (no · plain · machine.run), `fleet_sessions_answer` (no · confirm · machine.run), `fleet_sessions_rename` (no · plain · write.internal), `fleet_sessions_end` (yes · confirm · machine.run) | sessions      |
| desktop    | `fleet_desktop_screenshot`, `fleet_desktop_displays`                            | `fleet_desktop_input` (yes · confirm · machine.admin), `fleet_desktop_set_display` (no · plain · machine.admin)                                                            | desktop       |
| logs       | `fleet_logs_sources`, `fleet_logs_read`                                         | —                                                                                                                                                                         | view†         |
| services   | `fleet_services_list`                                                           | `fleet_services_action` (yes · confirm or blast-radius · machine.admin)                                                                                                    | services      |
| docker     | `fleet_docker_containers`, `fleet_docker_images`, `fleet_docker_compose_list`, `fleet_docker_logs` | `fleet_docker_container_action` (yes · confirm · machine.admin), `fleet_docker_run` (yes · confirm · machine.admin), `fleet_docker_image_pull` (no · confirm · machine.admin), `fleet_docker_image_remove` (yes · confirm-destructive · write.destructive), `fleet_docker_compose_action` (yes · confirm · machine.admin) | docker        |
| processes  | `fleet_processes_list`                                                          | `fleet_processes_signal` (yes · confirm · machine.admin)                                                                                                                   | processes     |
| ports      | `fleet_ports_list`                                                              | `fleet_ports_open` (no · plain · machine.run), `fleet_ports_preview` (no · confirm · machine.run)                                                                           | view / desktop / commands† |
| files      | `fleet_files_list`, `fleet_files_stat`, `fleet_files_read`                      | `fleet_files_write` (yes · confirm · machine.admin), `fleet_files_copy` (no · confirm · machine.admin), `fleet_files_delete` (yes · confirm-destructive · write.destructive) | files         |
| commands   | `fleet_commands_list`, `fleet_commands_get`                                     | `fleet_commands_run` (yes · confirm · machine.run), `fleet_commands_cancel` (no · plain · machine.run)                                                                      | commands      |
| schedules  | `fleet_schedules_list`, `fleet_schedules_get`, `fleet_schedules_runs`           | `fleet_schedules_create` (yes · confirm · agent.fanout), `fleet_schedules_update` (yes · confirm · agent.fanout), `fleet_schedules_delete` (yes · confirm · write.destructive), `fleet_schedules_run` (yes · confirm · machine.run), `fleet_schedules_pause` / `_resume` (no · plain · agent.fanout) | schedules     |
| checkouts  | `fleet_checkouts_list`, `fleet_checkouts_get`                                   | `fleet_checkouts_create` (no · confirm · machine.run), `fleet_checkouts_sync` (no · plain · machine.run), `fleet_checkouts_delete` (yes · confirm-destructive · write.destructive) | checkouts     |
| machines   | `fleet_machines_virtual_list`, `fleet_machines_cloud_options`, `fleet_machines_cloud_usage` | `fleet_machines_virtual_create` (yes · confirm · machine.admin), `fleet_machines_power` (yes · confirm · machine.admin), `fleet_machines_virtual_destroy` / `fleet_machines_cloud_destroy` (yes · confirm-destructive · write.destructive), `fleet_machines_cloud_create` (yes · confirm with price · spend.metered + machine.admin) | machines      |
| runners    | `fleet_runners_list`, `fleet_runners_jobs`                                      | `fleet_runners_install` (yes · confirm · machine.admin), `fleet_runners_action` (yes · confirm · machine.admin), `fleet_runners_remove` (yes · confirm-destructive · write.destructive) | machines†     |
| usage      | `fleet_usage_get`                                                               | —                                                                                                                                                                         | view          |
| operations | `fleet_operations_get`, `fleet_operations_list`                                 | `fleet_operations_cancel` (no · plain · machine.run)                                                                                                                       | view          |

† mapping flagged in spec §8b. Every entry's `route` is the FL-xx controller path; the factory
builds the tool from the entry and a typed invoker, so adding a family is one table row plus a
route.

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
file per family: `status.ts`, `nodes.ts`, `session.ts` (incl. `attach` via `apps/cli/src/commands/fleet/session-attach.ts`, `ws`),
`logs.ts`, `services.ts`, `docker.ts`, `processes.ts`, `ports.ts`, `files.ts`, `command.ts` (FL-12),
`schedule.ts` (FL-13), `checkout.ts`, `vm.ts`, `cloud.ts`, `runner.ts`, `usage.ts`, `operation.ts`.
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
- Confirmation summaries are hashed server-side; a mismatch re-issues `confirmation_required`.
- Tools never return credentials, raw paths outside roots, or unredacted output — the family
  services already guarantee that; FL-19 adds a test that every tool result passes `redactSecrets`.
- MCP acts as the API-key user: the Node audience is checked for that user; Organization-scoped
  checks need `EVER_WORKS_SCOPE_SLUG` (existing note, `whitelist.ts:28-29`).
- CLI keeps tokens in the existing credential store (`apps/cli/src/commands/auth/credentials.service.ts`).

## 12. Observability

Metrics `fleet_tool_calls_total{tool,outcome}`, `fleet_tool_gate_refusals_total{gate}`,
`fleet_tool_decisions_total`; audit `requestedBy`; AW-24 refusal records.

## 13. Phased rollout

| Phase | Flag                         | Contents                                                                                                                 |
| ----- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| P1    | each family's flag           | Catalogue, annotations, gate (reads), `fleet_status`, read tools, confirmation interceptor, operations wait, CLI group with reads + `status`, MCP read entries, Capabilities block |
| P2    | same                         | State-changing tools, Decisions, `fleet_sessions_question|answer`, CLI acts + `session attach`, MCP act entries, audit stamps |
| P3    | `FLEET_VIRTUAL|CLOUD|ACTIONS_RUNNERS_ENABLED` | machines and runners tools; agent-facing doc; shell completion                                                     |

## 14. Test plan

| Package              | Runner     | Specs                                                                                                                                                                        |
| -------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts` | Vitest     | `src/fleet/__tests__/fleet-tools.catalogue.spec.ts` — every name matches the pattern; every non-read row has class + category; no duplicates                                |
| `packages/agent`     | Jest       | `src/fleet/__tests__/fleet-tool-gate.spec.ts` — full truth table (grant allow/deny × rung × audience × consent × kill switch), first-refusal naming; `agent-fleet-tools.spec.ts` — every tool built from the catalogue, annotations present, `requestedBy` stamped, results redacted |
| `apps/api`           | Jest       | `src/fleet/fleet-confirmation.interceptor.spec.ts` — three classes, stale summary; `fleet-status.controller.spec.ts`; `fleet-tools-gate.controller.spec.ts`                   |
| `apps/mcp`           | Vitest     | `src/openapi-tools/__tests__/whitelist.fleet.spec.ts` — parity with the catalogue; forbidden paths absent; existing eight unchanged                                         |
| `apps/cli`           | Vitest     | `src/commands/fleet/__tests__/{index,status,session-attach,confirm}.spec.ts` — envelope, exit codes, `--yes`, non-TTY, detach                                                |
| `apps/web`           | Vitest     | `components/agents/agent-fleet-tools.shared.unit.spec.ts`; `FleetActionDecisionCard.unit.spec.tsx`                                                                           |
| `apps/web`           | Playwright | `e2e/flow-fleet-agent-tools-capabilities.spec.ts`; `e2e/flow-fleet-agent-tools-decision.spec.ts`                                                                             |

## 15. Risks

| Risk                                                      | Likelihood | Impact | Mitigation                                                                              |
| --------------------------------------------------------- | ---------- | ------ | --------------------------------------------------------------------------------------- |
| Catalogue drifts from the family controllers              | High       | Medium | Parity tests on three surfaces; a family PR must add its row                            |
| Two confirmation mechanisms (token vs body fields)        | Medium     | Low    | One interceptor; the web may also use body fields                                       |
| Agents loop on `confirmation_required`                    | Medium     | Low    | Hint says exactly what to send; summary stable for 5 min                                 |
| MCP naming inconsistency                                  | High       | Low    | Flagged in spec §8b; parity test allows exactly the eight legacy names                   |

## 16. Constitution reconciliation

I n/a · II n/a · III n/a · IV operations are FL-02's · V no schema · VI tests per package · VII no credential crosses a tool · VIII n/a · IX spec code-free · X additive (optional annotations, kept names).

## 17. References

Spec `./spec.md` · Tasks `./tasks.md` · CONTRACTS §2, §3.3, §7, §8, §11.3 · AW-15 §4.3 · AW-24 §4.1–4.3 · FL-01 plan (roles, needs-a-look) · FL-02 plan (operations) · FL-04 plan (attach tokens)
