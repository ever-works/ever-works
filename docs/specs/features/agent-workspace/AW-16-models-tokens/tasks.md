# Task Breakdown: Model accounts, priority chains and fallbacks

> Ordered, granular tasks derived from [`plan.md`](./plan.md). Each task is small enough to
> land in a single PR and ships with its tests (Constitution Principle VI).

**Epic ID**: `AW-16-models-tokens`
**Spec**: [`./spec.md`](./spec.md) · **Plan**: [`./plan.md`](./plan.md)
**Status**: `Draft`
**Last updated**: 2026-09-06

---

## How to use

- Tasks are sequential by default. Tasks marked `(parallel)` may run alongside the task above.
- Every task names the exact files to create or modify. An implementer should never have to
  guess a path; if a path is missing here, that is a bug in this file, not a licence to invent.
- Every task states what **done** means. A task is not done until its stated tests pass.
- Phases P1 / P2 / P3 are each independently shippable and each must leave `develop` green.
- Add new tasks at the bottom rather than renumbering.
- Repo root for every path below: `C:/Coding/Worktrees/wt-agent-workspace-specs`
  (`ever-works/ever-works`).

---

# Phase P1 — Accounts, the ladder, and what actually ran

Goal: more than one credential per provider, a three-level model ladder, and a Run that says
what answered it. **No failover yet.** A workspace that configures nothing behaves exactly as
it does today.

## P1.a — Contracts and data model

- [ ] **T1. Shared contracts for model routing.**
    - Create `packages/contracts/src/api/model-routing/model-routing.types.ts` with
      `ReasoningEffort`, `ModelPolicyScopeType`, `ModelChainEntry`, `ModelAccountHealth`,
      `ModelAccountView`, `ModelPolicyView`, `ResolvedModelPolicy`, `AgentRunModelRouting`
      (shapes in plan §3.2 / §3.4 / §3.7).
    - Create `packages/contracts/src/api/model-routing/index.ts`; export it from
      `packages/contracts/src/api/index.ts`.
    - `ModelAccountView` **must not** declare a credential field of any kind.
    - **Done**: `pnpm --filter @ever-works/contracts build` emits declarations; a type-level
      spec at `packages/contracts/src/api/model-routing/model-routing.types.spec.ts` asserts
      `ModelAccountView` has no `credentials` key via `expectTypeOf`.

- [ ] **T2. `ModelAccount` entity.**
    - Create `packages/agent/src/entities/model-account.entity.ts` per plan §3.1, using
      `EncryptedJsonColumn` from `packages/agent/src/entities/_secret-json-column.ts` for
      `credentials` and `PortableDateColumn` from `packages/agent/src/entities/_types` for
      every date.
    - No `@ManyToOne` relations (the EW-654 no-cycle rule every tenant-scoped entity follows).
    - Export from `packages/agent/src/entities/index.ts`.
    - **Done**: `cd packages/agent && npx jest --testPathPattern='entities'` green; the entity
      compiles under `tsc -p tsconfig.types.json`.

- [ ] **T3** (parallel with T2). **`ModelPolicy` entity.**
    - Create `packages/agent/src/entities/model-policy.entity.ts` per plan §3.2. Every routing
      field nullable so per-field inheritance works.
    - Export from `packages/agent/src/entities/index.ts`.
    - **Done**: as T2.

- [ ] **T4. Migration — model accounts and policies.**
    - Create `apps/api/src/migrations/1789200000000-CreateModelAccountsAndPolicies.ts`.
    - `CREATE TABLE model_accounts` + `CREATE TABLE model_policies` with the unique indexes in
      plan §3.1 / §3.2 and the FK `model_accounts.userId → users(id) ON DELETE CASCADE`.
    - Portable DDL (`Table` / `TableColumn` / `TableIndex` objects, not raw SQL) and every step
      guarded on the current shape, copying
      `apps/api/src/migrations/1789000000000-AddFleetCredentialRotation.ts`. Full `down()`.
    - Additive only: no `DROP COLUMN`, no rename, no backfill.
    - **Done**: `apps/api/src/migrations/__tests__/CreateModelAccountsAndPolicies.spec.ts`
      proves apply-on-empty, apply-twice-is-a-no-op, and revert. Ships in the **same PR** as
      T2 and T3 (Constitution V).

- [ ] **T5. Migration — routing record on runs.**
    - Create `apps/api/src/migrations/1789210000000-AddAgentRunModelRouting.ts` adding a
      nullable `modelRouting` json column to `agent_runs`. No default, no backfill.
    - Add the matching `@Column({ type: 'simple-json', nullable: true }) modelRouting?:
      AgentRunModelRouting | null;` to `packages/agent/src/entities/agent-run.entity.ts`,
      beside the existing `costCents` / `totalTokens` block.
    - **Done**: `apps/api/src/migrations/__tests__/AddAgentRunModelRouting.spec.ts` green; an
      existing run row still reads back with `modelRouting === null`.

- [ ] **T6. Activity-log action types.**
    - Append the nine members in plan §3.5 to `ActivityActionType` in
      `packages/agent/src/entities/activity-log.types.ts`. Append only — reorder nothing.
    - **Done**: no migration is required (the column is `varchar(50)`); a unit assertion in
      `packages/agent/src/entities/__tests__/activity-log.types.spec.ts` (create if absent)
      proves every member is ≤ 50 characters.

## P1.b — Domain services

- [ ] **T7. `ModelAccountService`.**
    - Create `packages/agent/src/model-routing/model-account.service.ts` with
      `list`, `create`, `update`, `replaceCredentials`, `reorder`, `pause`, `resume`,
      `remove`, `markUsed`.
    - Enforce inside one transaction: 8 per provider, 32 per workspace, unique label,
      contiguous 1..N positions with renumbering on delete, and optimistic `expectedVersion`
      on reorder.
    - Every mutation writes one activity-log entry naming the field, never the value.
    - Create `packages/agent/src/model-routing/model-routing.module.ts` and register it where
      the other agent-package feature modules are registered.
    - **Done**: `packages/agent/src/services/__tests__/model-account.service.spec.ts` covers
      both limits, renumbering, duplicate labels, the reorder conflict, and pause/resume
      preserving position (spec FR-1..12).

- [ ] **T8. `ModelPolicyService` + `ModelPolicyResolver`.**
    - Create `packages/agent/src/model-routing/model-policy.service.ts` (CRUD per scope) and
      `packages/agent/src/model-routing/model-policy.resolver.ts` (`resolve({ userId,
      organizationId, agentId?, scheduleOwnerId?, scheduleVariant? })` → `ResolvedModelPolicy`
      with a `source` per field).
    - Resolution is **per field**, narrowest wins: schedule → agent → workspace → plugin
      default. A Schedule setting only the model still inherits effort and timeout.
    - Legacy read: when no `model_policies` row exists for an Agent that has
      `aiProviderId`/`modelId` set (`packages/agent/src/entities/agent.entity.ts:273-277`),
      read those two columns as a policy of one.
    - **Done**: `packages/agent/src/facades/__tests__/model-policy-resolver.spec.ts` covers
      every ladder combination, the legacy path, and per-field independence (FR-25..36).

- [ ] **T9. `ModelAttemptPlanner` — single-attempt form.**
    - Create `packages/agent/src/facades/model-attempt-planner.ts`. In P1 it returns exactly
      one attempt: the resolved primary on that provider's highest-position usable account, or
      — when there is no account and no policy — the plugin's own resolved settings, i.e.
      today's behaviour byte for byte.
    - Merge account credentials over `getResolvedSettings()` output using the plugin's own
      setting keys; never translate key names.
    - **Done**: `packages/agent/src/facades/__tests__/model-attempt-planner.spec.ts` proves the
      empty-configuration case is identical to the pre-epic path.

- [ ] **T10. `ModelAccountHealthService`.**
    - Create `packages/agent/src/model-routing/model-account-health.service.ts`:
      `probe(accountId)`, `probeDueAccounts()`, `applyLiveFailure(accountId, class)`.
    - Thresholds: `expiring` at 14 days, banner at 3 days; a probe failure sets `unknown`, a
      provider **rejection** sets `invalid`; never changes `position`.
    - Prefer the plugin's `checkCredential` when present (T11), else `listModels`, else leave
      `unknown` (spec FR-62, FR-69).
    - **Done**: `packages/agent/src/services/__tests__/model-account-health.service.spec.ts`
      covers both thresholds and the failure-vs-rejection distinction (FR-60..69).

- [ ] **T11. Optional plugin-contract additions.**
    - Add optional `reasoningSupport?` and `checkCredential?` to `IAiProviderPlugin` in
      `packages/plugin/src/contracts/capabilities/ai-provider.interface.ts`.
    - Add optional `reasoningEffort?`, `attemptTimeoutMs?`, `scheduleId?` to
      `AiRoutingOptions` in `packages/plugin/src/facades/ai-facade.interface.ts`.
    - Add optional `scheduleId?` and `policyOverride?` to `FacadeOptions` in
      `packages/plugin/src/facades/facade-options.interface.ts`.
    - All optional; **do not touch** `packages/plugin/src/ai/reasoning.utils.ts` — it stays as
      the fallback when a plugin declares no `reasoningSupport`.
    - Bump `@ever-works/plugin` as a **minor** version (Constitution X).
    - **Done**: `cd packages/plugin && pnpm test` green; `pnpm build` across the monorepo
      compiles with no call site changed.

## P1.c — Facade wiring and the routing record

- [ ] **T12. Wire the planner into the facade.**
    - Modify `packages/agent/src/facades/ai.facade.ts`: in `askJson`,
      `createChatCompletion` and `createStreamingChatCompletion`, call
      `ModelAttemptPlanner.plan(facadeOptions)` after `getResolvedSettings()` and before
      `enforceBudget`. Keep `enforceBudget` exactly where it is and keep `withEscalation` as
      the P1 retry.
    - Do **not** change `resolveModel`, `embed`, `transcribe`, `testConnection` or
      `getAvailableModels`.
    - **Done**: `packages/agent/src/facades/__tests__/ai.facade.spec.ts` extended to prove the
      no-policy path is unchanged and that a budget block still throws before any attempt.

- [ ] **T13. Record what actually ran.**
    - In the same three methods, build an `AgentRunModelRouting` and persist it onto
      `agent_runs.modelRouting` when `facadeOptions.runId` is set. Record nothing when no
      model call was made (spec FR-84).
    - **Done**:
      `packages/agent/src/facades/__tests__/model-attempt-planner.redaction.spec.ts` asserts
      the serialised record contains none of the account's credential values as a substring
      (FR-83); `ai.facade.spec.ts` asserts provider/model/accountLabel/effort are present.

- [ ] **T14. Health probe task.**
    - Create `packages/tasks/src/tasks/trigger/model-account-health.task.ts` as a
      `schedules.task({ id: 'model-account-health', cron: '19 */6 * * *' })`, reaching
      `ModelAccountHealthService` through `withWorkerContext` exactly as
      `packages/tasks/src/tasks/trigger/agent-run-sweeper.task.ts` does.
    - Claim each row with an atomic `UPDATE … WHERE lastCheckedAt < :cutoff` so overlapping
      ticks cannot double-probe.
    - Export from `packages/tasks/src/tasks/trigger/index.ts`.
    - **Done**: a unit test for the claim predicate; a manual `pnpm dev:trigger` fire logs one
      probe per account and zero on the immediate re-fire.

## P1.d — API

- [ ] **T15. Model accounts controller + DTOs.**
    - Create `apps/api/src/model-routing/model-routing.module.ts`,
      `apps/api/src/model-routing/model-accounts.controller.ts`, and
      `apps/api/src/model-routing/dto/{create-model-account.dto.ts,update-model-account.dto.ts,replace-credentials.dto.ts,reorder-model-accounts.dto.ts}`.
    - Routes exactly as plan §4.1, including `GET /api/model-accounts/providers` built from
      the plugin registry **by capability** — no literal provider list anywhere.
    - Add an explicit `toModelAccountView` mapper in
      `apps/api/src/model-routing/model-account.mapper.ts`. Never spread the entity.
    - Register the module in `apps/api/src/api.module.ts`.
    - Swagger decorators (`@ApiOperation`, `@ApiResponse`) on every route.
    - **Done**: `apps/api/src/model-routing/__tests__/model-accounts.controller.spec.ts` proves
      the auth matrix, both 409 shapes, the 422 on a rejected credential, and — as its own
      test — that no response body from any route contains the credential the test wrote
      (FR-87).

- [ ] **T16. Model policies controller + DTOs.**
    - Create `apps/api/src/model-routing/model-policies.controller.ts` and
      `apps/api/src/model-routing/dto/upsert-model-policy.dto.ts`.
    - Custom validators in `apps/api/src/model-routing/dto/validators/`:
      `not-primary-in-fallbacks.validator.ts`, `unique-chain-entries.validator.ts`.
    - Bounds per plan §4.2 (`@ArrayMaxSize(3)`, `@Min(60) @Max(7200)`, `@Min(15) @Max(600)`,
      `@IsIn(['minimal','low','medium','high'])`).
    - Implement `GET /api/model-policies/resolved` returning per-field `source`.
    - **Done**: `apps/api/src/model-routing/__tests__/model-policies.controller.spec.ts`
      rejects a 4-entry chain, a chain containing the primary, a duplicate entry, a 30-second
      timeout, a 3-hour timeout and an unknown effort value.

## P1.e — Web

- [ ] **T17. Settings → Models route and shell.**
    - Create `apps/web/src/app/[locale]/(dashboard)/settings/models/page.tsx` (RSC) fetching
      accounts, workspace policy and providers with `Promise.allSettled` so one failure
      degrades to its own panel.
    - Create `apps/web/src/components/settings/ModelSettings.tsx`,
      `ModelAccountsPanel.tsx`, `ModelAccountRow.tsx`, `AddModelAccountDialog.tsx`,
      `ModelDefaultsPanel.tsx`, `ModelPickerField.tsx` (all under
      `apps/web/src/components/settings/`).
    - Add the tab to
      `apps/web/src/app/[locale]/(dashboard)/settings/settings-layout-client.tsx`, after
      `connections` and before `job-runtime`.
    - Credential fields in the add dialog are rendered **from the plugin's declared settings
      schema**, reusing the `x-secret` handling already used by
      `apps/web/src/components/plugins/form/PluginModelSelect.tsx`'s sibling widgets.
    - Wireframes and every literal string: [`spec.md`](./spec.md) §6.1–§6.3, §6.9.
    - **Done**: `apps/web/e2e/settings-model-accounts.spec.ts` covers add, reorder in three
      interactions, pause/resume, remove-with-consequence, both over-limit states, the
      read-only state and the load-error panel.

- [ ] **T18. Agent model panel.**
    - Create `apps/web/src/components/agents/AgentModelPanel.tsx` and mount it in
      `apps/web/src/app/[locale]/(dashboard)/agents/[id]/settings/page.tsx`, replacing that
      page's provider/model pair.
    - The new panel does **not** call `listByCategory('ai-gateway')` — that category does not
      exist in `packages/plugin/src/contracts/plugin-manifest.types.ts` and the call always
      resolved to `[]`. Remove only that call from the page; change no shared API.
    - Copy: [`spec.md`](./spec.md) §6.5.
    - **Done**: the Agent settings page renders with no network call to a non-existent
      category; `apps/web/e2e/model-override-ladder.spec.ts` (T20) covers the panel.

- [ ] **T19. Schedule model drawer.**
    - Create `apps/web/src/components/schedules/ScheduleModelDrawer.tsx`, exported standalone
      and taking `{ ownerId, variant, agentName }` so the surface that opens it (AW-10) can
      mount it without this epic owning that page.
    - Copy: [`spec.md`](./spec.md) §6.6.
    - **Done**: a unit spec `ScheduleModelDrawer.unit.spec.tsx` renders both radio states and
      asserts the inherited value is named.

- [ ] **T20. API clients.**
    - Create `apps/web/src/lib/api/model-accounts.ts`, `model-policies.ts` following the
      existing `apps/web/src/lib/api/*.ts` shape and routing through
      `apps/web/src/lib/api/bff-proxy.ts` with the active-scope header.
    - **Done**: `apps/web/src/lib/api/model-accounts.unit.spec.ts` asserts the scope header is
      forwarded on every call (the BFF selector-forwarding rule).

- [ ] **T21. Health banner.**
    - Create `apps/web/src/components/dashboard/ModelAccountHealthBanner.tsx`, modelled on
      `apps/web/src/components/dashboard/JobRuntimeDegradedBanner.tsx`: hydration-gated,
      `null` renders nothing, `localStorage` dismissal keyed by the **set** of unhealthy
      account ids so it returns when that set changes.
    - Mount in `apps/web/src/app/[locale]/(dashboard)/layout-client.tsx` immediately after
      `<JobRuntimeDegradedBanner />`.
    - Copy: [`spec.md`](./spec.md) §6.7.
    - **Done**: `apps/web/e2e/model-account-health-banner.spec.ts` covers the four variants and
      dismissal persistence.

## P1.f — i18n, docs, and the P1 gate

- [ ] **T22. i18n keys (P1 subset).**
    - Add to `apps/web/messages/en.json`: the whole `dashboard.settings.models` namespace,
      `dashboard.agentModel`, `dashboard.scheduleModel`, the expiry half of
      `dashboard.modelBanners`, `dashboard.runReceipt.routing`,
      `dashboard.settings.tabs.models` and `metadata.pages.settingsModels`
      (full list: [`plan.md`](./plan.md) §8).
    - **Leaf key names are camelCase and contain no literal `.`** — a literal dot fails
      next-intl at runtime and reds several e2e shards at once.
    - Mirror the same key set into all 20 sibling locale files in `apps/web/messages/`.
    - **Done**: `pnpm --filter web test` green including the i18n key-coverage spec; no console
      error in `apps/web/e2e/settings-model-accounts.spec.ts`.

- [ ] **T23. Program vocabulary table.**
    - Add **Model Account** and **Model Policy** to the vocabulary table in
      `docs/specs/features/agent-workspace/README.md` §1, with the "do not introduce" column
      naming the synonyms to avoid ("token", "key" as an entity, "profile").
    - Program rule 2 requires this in the same PR that lands the new nouns.
    - **Done**: the table lists both nouns and links to this epic.

- [ ] **T24. P1 gate.**
    - Run `pnpm format && pnpm lint && pnpm type-check && pnpm test && pnpm build`.
    - Confirm `apps/web/e2e/flow-plugin-ai-models-catalogue.spec.ts` is **untouched and
      green** — the live-probed plugin/models contract must not move.
    - Confirm a workspace with zero `model_accounts` and zero `model_policies` rows produces
      byte-identical model resolution to the pre-epic build.
    - **Done**: CI green on `develop`.

---

# Phase P2 — Failover

Goal: chains that actually move. An empty fallback list must produce exactly the P1 attempt
list, so P2 is a no-op for anyone who does not configure it.

- [ ] **T25. Failure classifier.**
    - Create `packages/agent/src/facades/model-failure-classifier.ts` — a pure function
      mapping a provider error to `rate_limited | credential | transient | context_too_large |
      fatal`, per [`plan.md`](./plan.md) §2.2.
    - **Done**: `packages/agent/src/facades/__tests__/model-failure-classifier.spec.ts` covers
      every row, including that 400/404/422 is `fatal` and that a `Retry-After` header is
      parsed into a cooldown.

- [ ] **T26. Cooldown state.**
    - Extend `ModelAccountService` with `applyCooldown(accountId, class, retryAfterMs?)` and
      `clearElapsedCooldowns()`, writing `cooldownReason`, `cooldownUntil`,
      `consecutiveFailures` on `model_accounts`.
    - Arithmetic: credential 15 min; rate limit = stated delay else 60 s, capped 30 min;
      transient 60 s, 5 min after 3 within a 5-minute window.
    - **Done**: covered in `model-account-health.service.spec.ts` including the 30-minute cap
      (FR-20..22).

- [ ] **T27. Cooldown sweeper task.**
    - Create `packages/tasks/src/tasks/trigger/model-account-cooldown-sweeper.task.ts`
      (`cron: '*/5 * * * *'`), exported from
      `packages/tasks/src/tasks/trigger/index.ts`.
    - **Done**: a unit test proves the sweep is a pure `WHERE cooldownUntil < now()` update and
      is idempotent.

- [ ] **T28. Full attempt planner.**
    - Extend `packages/agent/src/facades/model-attempt-planner.ts` to build the full product:
      chain entries outer (primary then fallbacks in order), that entry's provider's accounts
      inner (ascending `position`), skipping paused and cooling-down accounts, never repeating
      a `(model, account)` pair, truncating at **6** attempts and flagging that it did.
    - A chain entry whose provider has no usable account is skipped **without consuming an
      attempt**.
    - **Done**: `model-attempt-planner.spec.ts` extended to cover FR-15..24 and FR-42, plus
      the property that an empty fallback list yields exactly the P1 list.

- [ ] **T29. Attempt execution in the facade.**
    - Replace `withEscalation` usage in `askJson`, `createChatCompletion` and
      `createStreamingChatCompletion` with `runAttempts(list)` in
      `packages/agent/src/facades/ai.facade.ts`. Keep `withEscalation` in the file and keep
      emitting it as attempt 2 when a `complexity` is set and no fallback chain exists.
    - `enforceBudget` still runs **once**, before attempt 1, and its exception propagates
      untouched (FR-46).
    - Streaming: resolve the chain before the first byte; do not fail over mid-stream.
    - **Done**: `ai.facade.spec.ts` covers rate-limit → next account, credential → next
      account then next model, `fatal` → immediate failure with no walk, budget block → no
      attempt at all.

- [ ] **T30. Context-window advance.**
    - In the planner, on `context_too_large`, advance to the next chain entry whose known
      context window (from `AiFacadeService.resolveModelContextLength`, backed by
      `packages/agent/src/facades/model-catalog.ts`) is larger; otherwise fail immediately.
    - **Done**: covered in `model-failure-classifier.spec.ts` and
      `model-attempt-planner.spec.ts` (FR-45).

- [ ] **T31. Reasoning effort application.**
    - In `packages/agent/src/facades/ai.facade.ts`, thread the resolved effort into the
      plugin call as the provider's own control when
      `IAiProviderPlugin.reasoningSupport?.(modelId)` (T11) reports a level; map to the
      nearest supported level; when the model exposes none, record
      `effort: 'not-applicable'` and change nothing else.
    - `medium` on a workspace that never set an effort must be **behaviour-neutral** — the
      existing automatic per-model rule in `packages/plugin/src/ai/reasoning.utils.ts` still
      applies unchanged (FR-52).
    - **Done**: `ai.facade.spec.ts` proves the neutrality property and the nearest-level
      mapping.

- [ ] **T32. Run timeout as a hard stop.**
    - Enforce the resolved `runTimeoutSeconds` in
      `packages/agent/src/agents/agent-run.service.ts`: a Run past its deadline ends as
      `failed` with `errorMessage` "Run timed out after {n} minutes" and
      `modelRouting.outcome = 'timeout'` carrying the in-flight attempt.
    - `AgentRunStatus` is **not** extended — the union stays
      `queued | running | completed | failed | cancelled` (Constitution X).
    - **Done**: a unit spec in `packages/agent/src/agents/__tests__/` proves the transition and
      that the routing record survives it (FR-55, FR-56).

- [ ] **T33. Per-attempt deadline.**
    - Apply the resolved `attemptTimeoutSeconds` (default 120, range 15–600) as an
      `AbortSignal` on each attempt, clamped so the sum can never exceed the remaining run
      budget. A breached attempt deadline classifies as `transient`, not as a Run failure.
    - **Done**: `model-attempt-planner.spec.ts` proves the clamp; `ai.facade.spec.ts` proves
      the classification (FR-57, FR-58).

- [ ] **T34. Chain builder UI.**
    - Create `apps/web/src/components/settings/ModelChainBuilder.tsx` and mount it in
      `ModelDefaultsPanel.tsx`, `AgentModelPanel.tsx` and `ScheduleModelDrawer.tsx`.
    - Owns FR-39/40/41 in the UI: the picker's option list is built by removing the current
      primary and every entry already in the chain; changing the primary to an entry already
      in the chain removes it and shows the inline note for 6 seconds; the chain-too-long note
      appears on save.
    - Roving tabindex, `Alt+↑`/`Alt+↓` reorder, `Backspace` removes, polite `aria-live`
      announcements ([`spec.md`](./spec.md) §6.10).
    - **Done**: `apps/web/e2e/settings-model-defaults.spec.ts` covers the picker exclusion, the
      auto-removal note, the chain-too-long note, the effort radios, and the timeout bounds
      and warning.

- [ ] **T35. Timeout-too-short warning.**
    - Server-side: extend `GET /api/model-policies/resolved` (or add
      `GET /api/model-policies/timeout-impact`) to return how many Schedules have a recent
      typical duration above a proposed timeout. Warn, never block (FR-59).
    - **Done**: covered in `model-policies.controller.spec.ts` and in
      `settings-model-defaults.spec.ts`.

- [ ] **T36. i18n keys (P2 subset).**
    - Add the `defaults.*`, `effort.*` and `timeout.*` leaves of
      `dashboard.settings.models`, plus the failover strings of
      `dashboard.runReceipt.routing`, to `apps/web/messages/en.json` and the 20 sibling
      locales. camelCase leaves, no literal dots.
    - **Done**: i18n key-coverage spec green.

- [ ] **T37. P2 gate.**
    - `pnpm format && pnpm lint && pnpm type-check && pnpm test && pnpm build`.
    - Confirm a workspace with a primary and no fallbacks produces exactly the P1 attempt
      list.
    - **Done**: CI green on `develop`.

---

# Phase P3 — Credentials on computers

Goal: the accounts reach the machines agents control, and the owner can see when they have
not. A workspace with no enrolled computers must see nothing new at all.

- [ ] **T38. Bundle entity + migration.**
    - Create `packages/agent/src/entities/model-credential-bundle.entity.ts` (plan §3.3) and
      export it from `packages/agent/src/entities/index.ts`.
    - Add `appliedModelBundleVersion` (int NULL) and `modelBundleRequestedAt` (timestamp NULL)
      to `packages/agent/src/entities/fleet-node.entity.ts`.
    - Create `apps/api/src/migrations/1789220000000-CreateModelCredentialBundle.ts` doing both,
      portable DDL, guarded, with a full `down()`.
    - **Done**: `apps/api/src/migrations/__tests__/CreateModelCredentialBundle.spec.ts` proves
      apply / re-apply / revert and that no pre-existing `fleet_nodes` column is touched.

- [ ] **T39. `ModelBundleService`.**
    - Create `packages/agent/src/model-routing/model-bundle.service.ts`:
      `bumpVersion(scope)`, `buildBundle(scope)` (canonicalised body + sha256 `contentHash`),
      `status(scope)` (version, out-of-sync count, unreachable nodes at the 10-minute
      threshold), `requestSend(scope)`.
    - Call `bumpVersion` from `ModelAccountService` and `ModelPolicyService` on every write.
    - **Done**: `packages/agent/src/services/__tests__/model-bundle.service.spec.ts` covers
      monotonicity, hash stability under key reordering, and the counting rules (FR-70..76).

- [ ] **T40. Fan-out dispatcher symbol.**
    - Create `packages/agent/src/tasks/model-bundle-fanout-dispatcher.ts` exporting
      `MODEL_BUNDLE_FANOUT_DISPATCHER = Symbol.for('MODEL_BUNDLE_FANOUT_DISPATCHER')` and its
      producer-side interface, copying `packages/agent/src/tasks/webhook-delivery-dispatcher.ts`.
    - Re-export from `packages/agent/src/tasks/index.ts`.
    - **Add the name to `TASKS_BARREL_RUNTIME_SYMBOLS` in
      `packages/agent/src/tasks/_tasks-symbols.ts`** (alphabetical insertion) — omitting this
      fails CI one merge late, as that file's own header records.
    - Bind it in `packages/agent/src/tasks/job-runtime.providers.ts` alongside the other
      dispatchers (Constitution IV — never a direct queue call).
    - **Done**: `packages/agent/src/tasks/tasks.spec.ts` (the barrel-symbol pin)
      passes without modification beyond the one-line list entry.

- [ ] **T41. Fan-out task.**
    - Create `packages/tasks/src/tasks/trigger/model-bundle-fanout.task.ts` stamping
      `modelBundleRequestedAt` on every enrolled node of a workspace; keyed on
      `(scope, version)` so a re-run is a no-op. Export from that directory's `index.ts`.
    - **Done**: unit test proves the no-op on re-run.

- [ ] **T42. Node-authenticated bundle fetch.**
    - Add `POST fleet/model-bundle` to `apps/api/src/fleet/fleet.controller.ts` beside
      `heartbeat` / `rotate-credential`: `@Public()`, node-secret authenticated, `@Throttle`d
      well below the heartbeat allowance, one undifferentiated failure message, body never
      logged, response not cacheable.
    - Add `modelBundleVersion?: number` to `FleetHeartbeatDto` and
      `modelBundleRequested?: boolean` to `FleetHeartbeatResponse` in
      `packages/contracts/src/fleet/fleet-node.types.ts` — both optional; an absent value means
      "leave alone", matching the existing additive-telemetry contract used by `cliVersion`.
    - **Done**: `apps/api/src/fleet/__tests__/fleet-model-bundle.controller.spec.ts` proves the
      bad-secret path is indistinguishable from the heartbeat's, that a valid fetch returns
      material, and that omitting `modelBundleVersion` leaves the column untouched.

- [ ] **T43. Node applies and reports.**
    - Create `apps/node/src/core/model-bundle.ts`: fetch on `modelBundleRequested`, write each
      value through `apps/node/src/core/secret-store.ts` (OS keychain first), skip when
      `contentHash` is unchanged, report the applied version on the next heartbeat via
      `apps/node/src/core/heartbeat.ts`.
    - Expose the applied names to the model CLI executor's `envPassthrough` allow-list in
      `apps/node/src/core/executors/model-cli.ts` — names only; values continue to be read from
      the process environment and scrubbed from reported output.
    - **Done**: `apps/node/src/core/model-bundle-apply.spec.ts` proves keychain-first storage,
      no value in any log line, the unchanged-hash no-op, and the report-on-next-beat.

- [ ] **T44. Bundle status API.**
    - Create `apps/api/src/model-routing/model-bundle.controller.ts` with `GET
      /api/model-bundle/status` (member) and `POST /api/model-bundle/send` (admin, `202`).
    - **Done**: `apps/api/src/model-routing/__tests__/model-bundle.controller.spec.ts` covers
      the counts and the auth split.

- [ ] **T45. Sync banner.**
    - Create `apps/web/src/components/settings/ModelBundleSyncBanner.tsx`; mount it in
      `apps/web/src/app/[locale]/(dashboard)/settings/models/page.tsx` and in
      `apps/web/src/app/[locale]/(dashboard)/layout-client.tsx`.
    - Four states plus "not rendered at all" when there are zero enrolled computers
      ([`spec.md`](./spec.md) §6.7, FR-78). It clears itself; no user action is required to
      dismiss a resolved state.
    - Create `apps/web/src/lib/api/model-bundle.ts`.
    - **Done**: `apps/web/e2e/model-bundle-sync.spec.ts` covers pending, sending, unreachable,
      cleared, and the zero-computers case.

- [ ] **T46. i18n keys (P3 subset).**
    - Add the `sync*` leaves of `dashboard.modelBanners` to `apps/web/messages/en.json` and the
      20 sibling locales. camelCase leaves, no literal dots.
    - **Done**: i18n key-coverage spec green.

- [ ] **T47. P3 gate.**
    - `pnpm format && pnpm lint && pnpm type-check && pnpm test && pnpm build`.
    - Confirm a workspace with no enrolled computers renders no sync banner anywhere.
    - Confirm a node running the previous daemon version still heartbeats successfully and is
      simply not counted.
    - **Done**: CI green on `develop`.

---

# Cross-cutting — do these once, at the end of the phase that first needs them

- [ ] **T48. Telemetry.**
    - Emit `model_attempt_total`, `model_fallback_depth`, `model_call_duration_ms`,
      `model_account_health`, `model_bundle_lag_seconds` through
      `packages/monitoring/`; add the Sentry tags `model.provider`, `model.account` (label,
      not id) and `model.attempt`.
    - **Done**: a redaction spec asserts no credential value reaches a Sentry tag, breadcrumb,
      message or extra (Constitution VII).

- [ ] **T49. Correct the drifted architecture doc.**
    - Update `docs/specs/architecture/ai-facade.md` so §2 (method names), §5 (catalogue
      source) and §8 (`AiRoutingOptions` fields) describe the interface that actually ships
      after T11 — including that the catalogue is fetched live with a 1-hour in-process TTL
      and that there is no embedded snapshot and no refresh task.
    - **Done**: every claim in that document is checkable against
      `packages/plugin/src/facades/ai-facade.interface.ts` and
      `packages/agent/src/facades/model-catalog.ts`.

- [ ] **T50. User-facing documentation.**
    - Create `docs/features/model-accounts.md` covering: adding a second account, what the
      numbered order means, the three-level model ladder, fallback chains and why the primary
      is never its own fallback, reasoning effort, the run timeout, expiry warnings and the
      sync signal.
    - Cross-link from `docs/features/index.md` and add it to `apps/docs/sidebarsPlatform.ts`
      (the sidebar is manual; a file not listed there renders only as an orphan page).
    - **Done**: `pnpm --filter ever-works-docs build` produces no broken-link warnings.

- [ ] **T51. Hand the routing record to the receipt.**
    - Confirm with [AW-09](../README.md) that `agent_runs.modelRouting` and the
      `dashboard.runReceipt.routing` i18n namespace are what its receipt renders, and that the
      copy in [`spec.md`](./spec.md) §6.8 lands there verbatim.
    - **Done**: AW-09's spec references `AgentRunModelRouting` from
      `packages/contracts/src/api/model-routing/`.

- [ ] **T52. Hand the drawer to the schedules surface.**
    - Confirm with [AW-10](../README.md) that `ScheduleModelDrawer` is mounted from the
      schedule row and that `ModelPolicy.scopeVariant` uses the same source vocabulary as
      `docs/specs/features/schedules/spec.md` §1.3.
    - **Done**: the two vocabularies match member for member.

- [ ] **T53. Resolve the open questions.**
    - Take [`spec.md`](./spec.md) §9's seven `[NEEDS CLARIFICATION: …]` markers to Product and
      record the answers in the spec before it moves past `Draft`.
    - **Done**: `grep -c 'NEEDS CLARIFICATION' docs/specs/features/agent-workspace/AW-16-models-tokens/spec.md`
      returns 0.

- [ ] **T54. Close out.**
    - Update this epic's row in `docs/specs/features/agent-workspace/TRACKER.md`.
    - Set [`spec.md`](./spec.md) status to `Implemented`; set [`plan.md`](./plan.md) and this
      file to `Done`.
    - **Done**: tracker and all three documents agree.

---

## Definition of Done

- Every checkbox above is ticked.
- `pnpm format:check`, `pnpm lint`, `pnpm type-check`, `pnpm test` and `pnpm build` are green.
- `pnpm --filter ever-works-docs build` produces no broken-link warnings.
- Every functional requirement FR-1 … FR-93 in [`spec.md`](./spec.md) §4 has at least one
  passing test, and each acceptance-criteria line in §8 has been run by a reviewer.
- Every constitution gate in [`spec.md`](./spec.md) §10 and every row of
  [`plan.md`](./plan.md) §12 is confirmed satisfied.
- A workspace that upgrades and configures nothing resolves models exactly as it did before.
- No credential value appears in any API response, log line, trace, metric tag, activity-log
  entry, export or run record — proven by a test, not by inspection.
