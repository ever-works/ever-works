# Feature C — Agent Capabilities tab (implementation notes)

Branch: `session/feat-capabilities-tab`. Base: `develop` @ `43de25a41`.

A per-Agent **Capabilities** page at `/agents/[id]/capabilities` that unifies what
an Agent can do: fine-grained tool access (the tool-grant matrix's first web UI),
skill bindings, an init script, and a read-only summary of the 8 permission flags.

---

## What shipped

### 1. Tool catalog (`packages/agent`)

`buildAgentToolCatalog()` — `packages/agent/src/agents/agent-tool-catalog.ts`.

Returns `[{ name, description, gatedByPermission, source }]` where `source` is
`'builtin' | 'facade' | 'domain'`.

It is **derived, not declared**. The catalog instantiates `AgentToolService` with
inert stub dependencies and calls the real `resolveAllowedTools`; descriptor
assembly is synchronous and only touches its backing services inside the
`invoke` closures, which the catalog never calls. The two extra metadata columns
are computed the same way:

- `gatedByPermission` — resolve once fully-permissioned, then once per flag with
  only that flag off; a tool that disappears is gated by that flag.
- `source` — resolve once without the facade tokens and once without the domain
  tool sources; a tool that vanishes is `facade` / `domain` respectively.

Memoized (it depends only on code); `buildAgentToolCatalog()` hands back fresh
copies so callers cannot poison the cache. `resetAgentToolCatalogCache()` is the
test seam.

### 2. `agents.initScript` (advisory v1)

- Column: `agents.initScript text NULL` (`packages/agent/src/entities/agent.entity.ts`).
- Migration: `apps/api/src/migrations/1785010000000-AddAgentInitScript.ts` —
  additive, guarded, both `up` and `down`, nothing backfilled.
- Write path: `AgentsService.update` → 16 KB **byte** cap + `assertNoSecrets`
  hard reject (same posture as the five canonical Agent files). Blank/`null`
  normalises to `NULL`, so an emptied editor clears the column instead of
  storing `""`.
- DTO: `UpdateAgentDto.initScript` (`@IsOptional @IsString @MaxLength`), the cap
  shared with the service via `AGENT_INIT_SCRIPT_MAX_BYTES` from
  `@ever-works/contracts`. The DTO caps characters (all class-validator offers);
  the service's byte check is the authoritative one.
- Surfaced on `AgentDto` (`toAgentDto`) and in the capabilities payload.

**Advisory in v1: nothing executes it yet.** See "Follow-ups" for why.

### 3. API — composed read

`GET /api/agents/:id/capabilities` →
`apps/api/src/agent-capabilities/agent-capabilities.controller.ts`,
module `AgentCapabilitiesApiModule` (registered in `api.module.ts`).

One request answers the whole tab:

```
{ agentId, initScript, permissions, tools[], grants, agentGrantRow }
```

where each `tools[]` row is a catalog entry plus `permissionEnabled`, the
`decision` from `decideToolGrant` over the resolved chain, and
`effective = permissionEnabled && decision.allowed` (precomputed server-side so
no surface re-derives the rule).

A **separate module** rather than new providers on `AgentsModule`, so the pinned
`agents.module.spec.ts` shape stays untouched. Ownership: `AgentsService.getOne`
404s a foreign Agent before anything else runs; grants are read through
`ToolGrantService.list(userId)`, owner-scoped by construction.

**Mutations reuse existing endpoints** — no new write surface:
`PUT /api/tool-grants` + `DELETE /api/tool-grants/:id` for the agent-scope grant
row, `PATCH /api/agents/:id` for `initScript`, the skill-binding endpoints for
skills.

Contract types: `packages/contracts/src/policy/agent-capabilities.types.ts`.

### 4. Web

- Route constant `ROUTES.DASHBOARD_AGENT_CAPABILITIES`; tab added to
  `AgentDetailTabs`.
- Server page `app/[locale]/(dashboard)/agents/[id]/capabilities/page.tsx` —
  composed read + skills lists in one `Promise.all`; the skill pickers degrade to
  empty rather than 500ing the page.
- Client `components/agents/AgentCapabilitiesClient.tsx`, **sectioned** so the
  sibling features (MCP servers, repositories, environments) can add their own
  sections without restructuring: Tools → Permissions → Skills → Init Script.
- Server actions `app/actions/agent-capabilities.ts`; write client
  `lib/api/tool-grants.ts`; read via `agentsAPI.getCapabilities`.
- i18n keys under `dashboard.agentsPage.capabilities.*` plus the
  `dashboard.agentsPage.tabs.capabilities` label, added to **all 21** locale
  files (English string copied, not machine-translated).

#### Tool-switch policy lives in a pure module

`components/agents/agent-capabilities.shared.ts` — `toolToggleState` and
`composeGrantForToggle`. Extracted because this is the only part of the tab that
encodes policy rather than layout, and the obvious implementation is wrong:

- **Disable rule.** The naive "enabled iff `decision.source === 'agent'`" breaks
  as soon as an operator uses `allow`: a `tool-not-granted` refusal is attributed
  by finding the most specific layer whose ALLOW list matches, and by
  construction none does, so `source` degrades to `'default'`. An agent-scope
  allow list that merely omits a tool would render an unusable switch for a
  restriction this very page owns. The state is therefore decided from the
  per-layer `grants.chain`, never from the collapsed `source`.
- **ON must widen the allow list, not just clear a deny.** When the stored row
  carries an `allow` list, turning a tool on re-sends that list _with the tool
  added_; otherwise the PUT would clear a deny the tool was never on and the
  switch would flip straight back on the next render.
- Four rendered states: `permission-off` (fix in Settings), `upstream-denied`
  (tenant/org/Work — this page may only narrow), `pattern-denied` (a wildcard
  agent deny; the honest affordance is "Reset to inherited", not a switch), and
  `editable`.

PUT replaces the whole row, so every toggle re-sends the full desired
`allow`/`deny` pair. "Reset to inherited" DELETEs the agent-scope row.

---

## Data model

| Where               | What                                                                      |
| ------------------- | ------------------------------------------------------------------------- |
| `agents.initScript` | `text NULL`, new                                                          |
| `tool_grants`       | unchanged — the agent-scope row is written through the existing endpoints |
| skill bindings      | unchanged                                                                 |

No new entity, so no `_entities-inventory.ts` change.

---

## Endpoints / routes

- `GET /api/agents/:id/capabilities` (new, read-only)
- `PATCH /api/agents/:id` — gains `initScript`
- `/agents/[id]/capabilities` (new web route)

---

## Tests

| Command                                                                        | Covers                                                                                                                                                           |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cd packages/agent && npx jest --testPathPattern='agent-tool-catalog'`         | catalog ≡ `resolveAllowedTools` names; per-branch representatives; computed gates + sources; memoization returns copies                                          |
| `cd packages/agent && npx jest --testPathPattern='agents.service.init-script'` | persist verbatim, blank→NULL, omitted field untouched, byte cap (at and over), secret hard-reject                                                                |
| `cd packages/agent && npx jest --testPathPattern='tool-grant.agent-toggle'`    | toggle round trip against an in-memory row store: OFF→ON, reset-to-inherited, parent deny survives an agent allow, agent allow list narrows + reports `rejected` |
| `cd apps/api && npx jest --testPathPattern='agent-capabilities'`               | composition: 404 short-circuit, per-layer deny attribution, `effective` rule, agent-row selection                                                                |
| `cd apps/api && npx jest --testPathPattern='agent.dto.init-script'`            | DTO cap, type, null pass-through, `forbidNonWhitelisted` still on                                                                                                |
| `cd apps/web && npx vitest run src/components/agents`                          | switch policy (16 cases) + component wiring (12 cases)                                                                                                           |

Type-check / build: `apps/api`, `apps/web`, `@ever-works/agent`,
`@ever-works/contracts` all clean.

> `apps/api`'s `pnpm type-check` reports ~20 `TS2307` "cannot find module
> `@ever-works/*`" errors on a cold tree. Pre-existing and unrelated: it is the
> build-before-type-check ordering gotcha. Run
> `npx turbo build --filter=ever-works-api^...` first and it is clean.

---

## Deliberately NOT built (parallel-branch rule)

`collaborators`, `environments`, `mcp-connections` and `repo-registry` are being
implemented on sibling branches. This branch references none of their entities or
APIs, and renders no "links out" cards for MCP Servers / Repositories /
Environments — those sections land as follow-ups on top of the sectioned client.

---

## Follow-ups

1. **Execute the init script.** `claude-managed-agent` was checked for a
   bootstrap seam and has none — it is a prompt/content pipeline, not a session
   runtime, so there is nothing to hook. Whichever branch lands a session /
   workspace bootstrap step (the environments feature is the likely one) should
   read `agent.initScript` there. Until then the column is stored and displayed
   only; the UI helper text says as much.
2. **e2e for the tab.** `flow-agents-ui-journey.spec.ts` now asserts the
   Capabilities link exists in the tab strip. A deeper journey (toggle a tool,
   assert the grant row, reset) needs a live stack and was left out rather than
   shipped unverified.
3. **Other grant scopes.** `lib/api/tool-grants.ts` is scope-generic because the
   endpoint is; tenant / organization / Work grant surfaces can reuse it.
4. **Bulk tool actions.** Per-tool switches only today; "deny all domain tools"
   style bulk edits would write a wildcard pattern, which the UI currently
   surfaces read-only (`pattern-denied`).
