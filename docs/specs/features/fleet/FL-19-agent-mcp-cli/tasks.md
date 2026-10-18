# FL-19 — Agent, MCP & CLI surface · Task breakdown

> Ordered, executable tasks derived from [`plan.md`](./plan.md). Each carries explicit file paths
> and a test. Every task ships with its tests (Constitution VI).

**Feature ID**: `fl-19-agent-mcp-cli`
**Spec**: [`./spec.md`](./spec.md) · **Plan**: [`./plan.md`](./plan.md)
**Status**: `Draft`
**Last updated**: 2026-10-18

---

## How to use

- Paths are repo-relative. `packages/agent`, `apps/api` use **Jest**; `packages/contracts`,
  `apps/mcp`, `apps/cli`, `apps/web` unit use **Vitest**; e2e is **Playwright**.
- FL-19 has no schema change and no flag of its own; each tool inherits its family's flag.
- Family tools land as their families land; P1 can ship with FL-01/02/03 reads only.
- Add tasks at the bottom; never renumber. Commit style `feat(fleet-tools): …`.

## P1.A — Catalogue and annotations

- [ ] **T-01**. Add `packages/contracts/src/fleet/fleet-tools.types.ts` — `FleetToolAnnotation`, `FleetToolCatalogueEntry`, `FLEET_TOOL_CATALOGUE` (plan §9.1), `FleetToolError`, `FleetConfirmArgs`, `FleetStatusView`; export from `packages/contracts/src/fleet/index.ts`.
  **Test**: `packages/contracts/src/fleet/__tests__/fleet-tools.catalogue.spec.ts` — name pattern; class + category on every non-read row; unique names.
- [ ] **T-02**. Add optional `annotations?: FleetToolAnnotation` to `TaskToolDescriptor` (`packages/agent/src/tasks-domain/agent-task-tools.ts:39-55`) and `AgentToolDescriptor` (`packages/agent/src/agents/agent-tool.service.ts:128-137`).
  **Test**: existing descriptor specs compile unchanged (`agent-tool-domain.spec.ts`).

## P1.B — The gate

- [ ] **T-03**. Add `packages/agent/src/fleet/fleet-tool-gate.ts` — pure `decideFleetToolCall(input)` with the published `FLEET_TOOL_GATE_ORDER` and a `FleetToolGate` service wiring `FleetKillSwitchService`, `WorkspacePauseService`, the AW-15 `ToolGrantEnforcer`, the AW-24 `SafetyGateService`, FL-01 role derivation and `FleetNode.controlPolicy` + `consents`.
  **Test**: `packages/agent/src/fleet/__tests__/fleet-tool-gate.spec.ts` — full truth table; first refusing gate named; audience refusal creates no Decision.
- [ ] **T-04**. Add `packages/agent/src/fleet/fleet-tool-factory.ts` — builds `AgentToolDescriptor`s from `FLEET_TOOL_CATALOGUE` + typed invokers; stamps `requestedBy: agent:<id>`; passes every result through `redactSecrets`; handles `wait: false` → `{ operationId }`.
  **Test**: `__tests__/fleet-tool-factory.spec.ts` — every catalogue row yields a tool with annotations; results redacted; operation fallback after 25 s.
- [ ] **T-05**. Rework `packages/agent/src/fleet/agent-fleet-tools.ts` to keep `list_fleet_nodes` verbatim and append the factory's tools; update the fleet source in `agent-tool.service.ts:524-527` to pass the gate.
  **Test**: `agent-fleet-tools.spec.ts` — legacy tool unchanged; new tools present; `fleet.module.spec.ts:206` still green.

## P1.C — API

- [ ] **T-06**. Add `GET /api/fleet/status` (`apps/api/src/fleet/fleet-status.controller.ts`) composing `FleetService.listForUser`, FL-03 health, FL-01 needs-a-look registry and kill-switch state.
  **Test**: `fleet-status.controller.spec.ts` — one call, all four parts; cross-user isolation.
- [ ] **T-07**. Add `GET /api/fleet/tools/gate?agentId=` (`apps/api/src/fleet/fleet-tools-gate.controller.ts`) returning per-family read/act/refusedBy/fixRoute.
  **Test**: controller spec — matrix for one Agent across two nodes.
- [ ] **T-08**. Add `apps/api/src/fleet/fleet-confirmation.interceptor.ts` — reads the catalogue class for the route, validates `confirm` / `confirmName` / `acknowledgeBlastRadius`, and answers 409 `confirmation_required` with `details: { class, summary, preview?, sentence? }` when the field is missing (CONTRACTS §2.2 — the web, tools, MCP and CLI all use these fields; nothing is stored between the calls); apply to every family controller as they land.
  **Test**: `fleet-confirmation.interceptor.spec.ts` — three classes; the preview shape; a confirming call against a changed target answers that target's own error; an unknown token-style field is ignored and still answers 409.

## P1.D — CLI group (reads)

- [ ] **T-09**. Add `apps/cli/src/commands/fleet/index.ts`, `fleet-output.ts`, `fleet-exit.ts`, `fleet-confirm.ts`, `fleet-client.ts`; register in `apps/cli/src/main.ts:22-26`; add `handleFleetCliError` to `apps/cli/src/utils/error.ts` without changing `handleCliError`.
  **Test**: `apps/cli/src/commands/fleet/__tests__/index.spec.ts` — envelope; exit map `0/1/2/124`; `--yes` / `--confirm-name`; non-TTY without `--yes` exits 2.
- [ ] **T-10**. Add read verbs (plural groups with singular aliases, plan §9.3): `status.ts`, `nodes.ts` (list/get/health/needs-a-look/git-identity), `session.ts` (list/read/question), `desktop.ts` (screenshot/displays/recordings), `logs.ts`, `services.ts` (list), `processes.ts` (list), `docker.ts` (containers/images/compose list/describe), `ports.ts` (list), `files.ts` (list/stat/get), `command.ts` (list/get, FL-12 owns `run`), `schedule.ts` (list/get/runs), `checkout.ts` (list/get/changes), `usage.ts`, `operation.ts` (get/list).
  **Test**: one spec per file under `__tests__/` against a mocked HTTP client — human table and `--json` shape equal the contract views.

## P1.E — MCP (reads) and web

- [ ] **T-11**. Add read entries from the catalogue to `apps/mcp/src/openapi-tools/whitelist.ts` after the fleet block (`:475-530`), with hand-written descriptions where needed.
  **Test**: `apps/mcp/src/openapi-tools/__tests__/whitelist.fleet.spec.ts` — parity with catalogue reads; forbidden paths absent; the eight legacy entries byte-identical.
- [ ] **T-12**. Add `apps/web/src/components/agents/AgentFleetToolsSection.tsx` + `agent-fleet-tools.shared.ts` on the Capabilities tab beside `AgentFleetSection.tsx`; i18n `fleet.tools.capabilities.*`.
  **Test**: `agent-fleet-tools.shared.unit.spec.ts`; Playwright `apps/web/e2e/flow-fleet-agent-tools-capabilities.spec.ts`.

## P2 — Acts, Decisions, sessions, attach

- [ ] **T-13**. Enable state-changing rows in the factory (T-04) with Decision creation at Ask/Draft through AW-03's proposal service (`packages/agent/src/entities/agent-action-proposal.entity.ts`, `actionType: 'fleet_machine_action'` — FL-09's value, CONTRACTS R-33; no migration — `actionType` is a varchar without a check constraint; add the value to `AgentActionProposalActionType`). Approval re-runs the call with the class field set; an approval more than 24 h after the row was raised answers `confirmation_required` with a fresh summary (spec U12 default).
  **Test**: `fleet-tool-factory.spec.ts` — `held` reply with `decisionId`; approval executes once; a stale approval runs nothing.
- [ ] **T-14**. Add `fleet_sessions_question` and `fleet_sessions_answer` invokers over FL-04 `GET /sessions/:id` and `POST /sessions/:id/answer` (FL-05's tool rows); questions only, and another session's question only with FL-05's "may answer other sessions" setting (CONTRACTS R-32); audit `node.session.answer` with `requestedBy: agent:<id>`.
  **Test**: `fleet-tool-gate.spec.ts` — refused without the grant; refused without the setting; every permission prompt refused; audited when allowed.
- [ ] **T-15**. Add `apps/web/src/components/approvals/FleetActionDecisionCard.tsx`; mount in `apps/web/src/components/approvals/ApprovalsQueue.tsx` and in the Agent conversation renderer; i18n `fleet.tools.decision.*`.
  **Test**: `FleetActionDecisionCard.unit.spec.tsx`; Playwright `apps/web/e2e/flow-fleet-agent-tools-decision.spec.ts`.
- [ ] **T-16**. CLI act verbs across the family files (`services action`, `processes signal`, `docker …`, `ports open|preview|preview-close`, `files put|cp|rm`, `desktop input|paste`, `schedules create|…` (FL-13 owns), `checkouts create|sync|archive|delete`, `sessions start|send|answer|rename|end|action`, `nodes wake|git-identity --set`, `operations cancel`), all through `fleet-confirm.ts` (`--yes` → `confirm: true`, `--confirm-name` → `confirmName`).
  **Test**: per-file specs — `confirmation_required` → exit 2 without `--yes`; destructive needs `--confirm-name`.
- [ ] **T-17**. Add `apps/cli/src/commands/fleet/session-attach.ts` — attach token, `ws` client, raw TTY, status bar, `Ctrl-]` detach, `--drive`.
  **Test**: `__tests__/session-attach.spec.ts` with a fake WS server — frames rendered; detach leaves the session; `--drive` requests `driver`.
- [ ] **T-18**. MCP act entries from the catalogue with `destructiveHint`; `omitArgs` for any human-only flag a family controller carries.
  **Test**: `whitelist.fleet.spec.ts` extended for parity on acts.
- [ ] **T-19**. Stamp `requestedBy` on every family audit path: add `requestedBy` to `RecordFleetNodeAuditInput.extra` callers in each family service (FL-04…18) via a shared helper `packages/agent/src/fleet/fleet-requested-by.ts`.
  **Test**: `fleet-audit.service.spec.ts` — `requestedBy` survives redaction (its name contains no redaction key word).

## P3 — Machines, runners, docs, completion

- [ ] **T-20**. Add catalogue rows and CLI files for FL-16 (`virtual.ts`), FL-17 (`cloud.ts`, price shown before create), FL-18 (`runners.ts`) as those epics land — the names those epics' plans use; MCP parity.
  **Test**: catalogue and whitelist parity specs.
- [ ] **T-21**. Shell completion `ever-works completion <shell>` for the `fleet` group in `apps/cli/src/commands/fleet/completion.ts`.
  **Test**: snapshot spec.

## Docs and rollout

- [ ] **T-22**. Agent-facing doc `docs/features/fleet-agent-tools.md` — how an Agent, an MCP client and the CLI reach the fleet; the gate; the two-step confirm; `wait:false`; "tools never carry a credential". Add to `apps/docs/sidebarsPlatform.ts` under fleet (`:183`); link from `docs/features/mcp-server.md` and `docs/features/fleet.md`.
  **Test**: `pnpm --filter ever-works-docs build` has no broken-link warning.
- [ ] **T-23**. Update `docs/specs/features/fleet/TRACKER.md`.
  **Test**: the FL-19 TRACKER row is current.
- [ ] **T-24**. `pnpm format && pnpm lint && pnpm test && pnpm build`; docs build clean; banned-terms grep on this folder prints nothing.
  **Test**: every command exits 0 and the grep prints nothing.

## Definition of done

- All boxes ticked; the catalogue, the Agent factory, the MCP whitelist and the CLI agree by test.
- Spec §9 verified with one Agent at each rung against two computers with different audiences.
- No credential or unredacted output crosses any tool (asserted by test).
