# Tenants & Organizations — Implementation Plan

**Status:** Draft v1 · **Owner:** Engineering · **Date:** 2026-05-27
**Spec:** [spec.md](spec.md) · **Tasks:** [tasks.md](tasks.md) · **Acceptance:** [acceptance.md](acceptance.md)

> This plan is **additive**. Every step adds a column, a table, an endpoint, or a UI surface. Nothing existing is removed, renamed, or refactored. Existing users keep working without any data migration applied to them — they simply have `tenantId = NULL` until they create their first Organization.

The plan is **10 phases**. Each phase is a JIRA Story (Story keys assigned at ticket creation — see [tasks.md](tasks.md) for the linkage). Each phase ships as one PR against `develop` unless noted.

---

## Phase 0 — Username uniqueness contract (foundation)

**Goal:** Make `users.username` uniqueness an enforced DB-level contract before anything else relies on it for slug routing.

**Changes:**

1. New TypeORM migration: `AddUniqueIndexToUsername`.
    - Pre-check: `SELECT username, COUNT(*) FROM users GROUP BY username HAVING COUNT(*) > 1` — fail the migration loudly with a clear message if any duplicates exist (operator decides resolution). No live users yet, so we expect zero.
    - Add a UNIQUE index on `lower(username)` (Postgres expression index for case-insensitive uniqueness).
    - SQLite fallback: plain UNIQUE on the raw column (covers the better-sqlite3 internal-cli test driver — see [`database-migrations.md`](../../architecture/database-migrations.md)).
2. New TypeORM migration: `AddSlugToUsers`.
    - Add nullable `slug` varchar column.
    - Backfill `slug` from `username` (URL-normalize per [spec.md §3.3](spec.md#33-url-safety)) for every existing user.
    - Add UNIQUE index on `lower(slug)`.
    - Flip column to NOT NULL after backfill.
3. New service: `apps/api/src/users/username-allocator.service.ts`.
    - Public method `allocateUsername(base: string): Promise<string>` — runs the existing suffix-on-collision loop in one place. Replace the inline loop in `github-app-onboarding.service.ts:223-229` with a call to this service.
    - Public method `allocateSlug(base: string, ownerTable: 'users' | 'organizations'): Promise<string>` — same loop, checks both `users.slug` and `organizations.slug` for collisions. Used by the eventual Org-create path too.
4. New API endpoint: `GET /api/users/check-username?value=<string>`.
    - Public (`@Public()`).
    - Throttled.
    - Returns `{ available: boolean, suggestion?: string }`.
    - Used by interactive UI signup / settings forms.
5. Update entity: `user.entity.ts` — add `unique: true` to `@Column()` for `username`; add `@Column({ unique: true }) slug: string;` (matches migration).

**Out of scope this phase:** any Tenant / Organization tables; any UI changes; any other entity changes.

**Tests:**

- Unit: `UsernameAllocatorService` handles collisions deterministically.
- Integration: `GET /check-username` returns suggestions and matches subsequent create behavior.
- Migration: dry-run on a snapshot — no duplicates, clean apply.

---

## Phase 1 — Create `tenants` and `organizations` tables

**Goal:** Land the two new tables. Empty on first deploy. No rows are written by this phase.

**Changes:**

1. New entity: `packages/agent/src/entities/tenant.entity.ts`.
    - Columns per [spec.md §1.1](spec.md#11-tenant-internal-only-never-shown-in-ui).
    - Unique index on `ownerUserId`.
    - Unique index on `lower(slug)`.
2. New entity: `packages/agent/src/entities/organization.entity.ts`.
    - Columns per [spec.md §1.2](spec.md#12-organization-user-facing--ui-label-varies).
    - FK `tenantId` → `tenants(id)` ON DELETE CASCADE.
    - FK `linkedWorkId` → `works(id)` ON DELETE SET NULL.
    - Unique index on `lower(slug)` — globally unique across the table.
    - Composite index on `(tenantId, createdAt)` for switcher list queries.
3. New repository: `TenantRepository`, `OrganizationRepository` (under `packages/agent/src/database/`).
4. New TypeORM migration: `CreateTenantsTable`.
5. New TypeORM migration: `CreateOrganizationsTable`.
6. Register both entities in `packages/agent/src/entities/index.ts` and the appropriate ORM module.

**Out of scope this phase:** any FK-back from existing tables to these new tables (that's Phase 2+). No backfill. No API endpoints yet.

**Tests:**

- Schema test: both tables exist, indexes are present, FKs cascade correctly.
- Entity test (alongside existing `work.entity.spec.ts` pattern): constructor + ClassToObject round-trip.

---

## Phase 2 — Add `tenantId` to `users`; add `tenantId` to Tier B entities

**Goal:** Wire the User → Tenant FK and add `tenantId` to all auth-scoped Tier B entities (`tenantId` only — no `organizationId` for these).

**Changes:**

1. New TypeORM migration: `AddTenantIdToUsers`.
    - Add nullable `tenantId uuid` column to `users`.
    - Add FK to `tenants(id)` ON DELETE SET NULL.
    - Add index.
    - **Also adds `users.lastScopeOrganizationId uuid` (nullable, FK to `organizations(id)` ON DELETE SET NULL).** This is the "remember the user's currently-active scope" column referenced by [spec.md §5.6](spec.md#56-default-organization-on-next-login) — NULL means bare Tenant. Added in the same migration to keep all User-scoped FKs in one place.
    - **No backfill.** Existing users stay `tenantId = NULL` and `lastScopeOrganizationId = NULL`.
2. New TypeORM migration: `AddTenantIdToTierBEntities`.
    - Adds nullable `tenantId uuid` column + FK + index to each of:
        - `auth_accounts`
        - `auth_sessions`
        - `auth_verifications`
        - `refresh_tokens`
        - `user_template_preferences`
        - `user_task_counters`
    - **No backfill.** Existing rows stay `tenantId = NULL`.
3. Update entities to add the column (`@ManyToOne(() => Tenant, { nullable: true })`).

**Out of scope this phase:** writing `tenantId` on new inserts (that's Phase 5 — only after Tenant rows exist, which only happens after the lazy upgrade flow lands). Until then, `tenantId` stays NULL on all new auth rows too.

---

## Phase 3 — Add `tenantId` + `organizationId` to Tier A entities

**Goal:** Add both columns to all top-level business entities.

**Changes:**

1. One TypeORM migration per entity (following the [`1779977000000-AddWorkOrganizationId.ts`](../../../../apps/api/src/migrations/1779977000000-AddWorkOrganizationId.ts) template):
    - `missions` — add both `tenantId` + `organizationId`, both nullable, both indexed.
    - `work_proposals` (Ideas) — add both.
    - `tasks` — add both.
    - `agents` — add both.
    - `skills` — add both.
    - `conversations` — add both.
    - `notifications` — add both.
    - `api_keys` — add both.
    - `templates` — add both.
    - `template_customizations` — add both.
    - `user_subscriptions` — add both.
    - `work_schedules` — add both.
    - `work_deployments` — add both.
    - `onboarding_requests` — add both.
    - `webhook_subscriptions` — add both.
    - `github_app_installations` — add both.
    - `github_app_user_links` — add both.
    - `works` — add `tenantId` only (`organizationId` already exists; upgrade to FK in Phase 4).
    - `work_knowledge_documents` — add `tenantId` only (`organizationId` already exists; upgrade to FK in Phase 4).
2. For each: update the corresponding entity file to declare the columns.
3. **No backfill** in any of these migrations. Existing rows stay NULL.

**PR scope guidance:** these can all ship in one PR (additive, low risk), or be split into 2–3 PRs grouped by domain (auth/work/agent/task/etc.) if the diff is too big for review. Editor's choice.

**Tests:**

- Per-entity migration test: apply + re-apply is idempotent (matches the existing `hasColumn` guard pattern).
- Entity test: new columns are nullable, optional in `ClassToObject`.

---

## Phase 4 — Upgrade existing free-form `organizationId` columns to FK

**Goal:** Now that `organizations(id)` exists, fix the existing forward-looking columns.

**Changes:**

1. New TypeORM migration: `UpgradeWorkOrganizationIdToFk`.
    - Pre-check: count rows where `organizationId IS NOT NULL` (expect 0 — we haven't created any Orgs in DB yet).
    - If any non-NULL orphan UUIDs exist (no matching `organizations.id`), NULL them out with a logged warning.
    - Add FK constraint `works.organizationId` → `organizations(id)` ON DELETE SET NULL.
2. New TypeORM migration: `UpgradeWorkKnowledgeDocumentOrganizationIdToFk` — same pattern.
3. Update `work.entity.ts` and `work-knowledge-document.entity.ts` to declare the relation (`@ManyToOne(() => Organization, ...)`).

---

## Phase 5 — Tier C children: denormalize `tenantId` (and `organizationId`)

**Goal:** Add denormalized scope columns to all Tier C children (per user-confirmed decision in [spec.md §2.3](spec.md#23-three-tiers-of-entities-which-columns-each-tier-gets)).

**Changes:**

1. One TypeORM migration (or batch — same rationale as Phase 3 splitting):
    - For each Tier C entity, add nullable `tenantId uuid` + FK + index.
    - For Tier C entities whose parent is a Tier A object that _also_ has `organizationId`, add nullable `organizationId uuid` + FK + index.
    - **Tier C list:** `conversation_messages`, `task_assignees`, `task_approvers`, `task_reviewers`, `task_watchers`, `task_blocks`, `task_chat_messages`, `task_kb_mentions`, `task_attachments`, `task_relations`, `agent_runs`, `agent_run_logs`, `agent_budgets`, `agent_memberships`, `skill_bindings`, `work_members`, `work_invitations`, `work_generation_history`, `work_knowledge_chunks`, `work_knowledge_citations`, `work_knowledge_tags`, `work_knowledge_uploads`, `webhook_deliveries`, `usage_ledger_entries`, `plugin_usage_events`, `activity_log`.
2. Update each entity to declare the columns.
3. **Service-layer change:** every create path that writes a Tier C row must set `tenantId` and `organizationId` (if the parent has one) from the currently active scope context. This is the largest code change in this phase — ~20–30 services touched.
    - Introduce a `ScopeContext` (request-scoped NestJS provider) carrying `{ tenantId: string | null, organizationId: string | null }`. Resolver middleware (Phase 7) populates it.
    - Update every `Repository.create()` / `Repository.save()` call site for Tier C rows to consume `ScopeContext`.
    - For background jobs / agent ticks / scheduled tasks: extract scope from the parent entity being processed and propagate.
4. **No backfill** in this phase. Existing Tier C rows stay NULL. Backfilled on the user's first-Org-upgrade (Phase 6).

**Risk:** missed service paths leave new rows with `NULL` scope. Mitigation: add a test that asserts new rows created via every service have `tenantId` set when the actor has a Tenant. Lint rule + code review.

---

## Phase 6 — Lazy upgrade flow + Organization-create API

**Goal:** Implement the §5.2 / §5.3 flow — server-side creation of Tenants and Organizations + backfill.

**Changes:**

1. New API endpoints:
    - `POST /api/organizations` — body `{ name, slug? }`. Creates Organization. If user has no Tenant, creates Tenant lazily. Returns the Organization row + scope info.
    - `POST /api/organizations/:id/upgrade-from-account` — moves the user's existing Tier A/C rows from Tenant-root into this Organization (sets `organizationId`), and writes `tenantId` on all Tier A/B/C rows that don't yet have one. **Gated**: only runs if this is the user's first Organization (i.e. `organizations.count(tenantId = user.tenantId) === 1` AND `organizations.id === :id`). Returns **409 Conflict** if called after the user has created additional Orgs. Idempotent on the same first Org.
    - `GET /api/organizations` — list all Orgs for the current user's Tenant.
    - `GET /api/organizations/:slug` — fetch one by slug (used by the slug resolver middleware).
    - `PATCH /api/organizations/:id` — update displayName, legalName, etc.
    - `GET /api/organizations/check-slug?value=<string>` — uniqueness check across `users.slug` + `organizations.slug`.
2. New service: `apps/api/src/organizations/organization.service.ts`.
    - `createOrganization(userId, name, slug?)`:
        1. Lazy-create Tenant if `user.tenantId IS NULL`.
        2. Allocate slug via `UsernameAllocatorService.allocateSlug(name, 'organizations')`.
        3. Insert Organization row.
        4. If `users.lastScopeOrganizationId IS NULL` and this is the user's first Org, store the new Org id on `users.lastScopeOrganizationId` so the next login lands there.
        5. **Unconditional `tenantId` backfill** (runs regardless of which branch — Upgrade or Empty — the user picks later): for every Tier A/B/C row owned by this user where `tenantId IS NULL`, UPDATE to set `tenantId = newTenant.id`. Same transactional shape as `upgradeFromAccount`'s table walk, but writes only `tenantId`. This makes the "Empty" branch ([spec.md §5.2 3b](spec.md#52-user-creates-their-first-organization)) coherent even though it never calls `upgrade-from-account`.
    - `upgradeFromAccount(userId, organizationId)`:
        1. Verify ownership (user owns Tenant; Org belongs to that Tenant).
        2. Verify Org's tenantId matches user's tenantId.
        3. **First-Org guard:** the endpoint is only callable while the user has **exactly one** Organization under their Tenant AND `:organizationId` is that one Org. Concretely: `SELECT COUNT(*) FROM organizations WHERE tenantId = :userTenantId` must equal 1, and the single row's `id` must equal `:organizationId`. Either condition failing → throw `409 Conflict` with error code `UPGRADE_NOT_AVAILABLE_AFTER_MULTIPLE_ORGS`. This prevents retroactively pulling items into a non-first Org.
        4. **Tier A rows** (entities that have `organizationId` + direct `userId`): UPDATE every row where `userId = X AND tenantId IS NULL` → set BOTH `tenantId = newTenant.id` AND `organizationId = newOrg.id`. Rows already migrated to a Tenant are left as-is (idempotency). ~~Tier C deferred to Phase 6b follow-up.~~ **Phase 11 follow-up shipped 2026-05-28 (EW-663)** — Tier C is now handled by the same `upgradeFromAccount` call; see Phase 11 below.
        5. **Tier B rows** (entities without `organizationId`): UPDATE every row where `userId = X AND tenantId IS NULL` → set `tenantId = newTenant.id` ONLY. Do NOT attempt to write `organizationId` — the column does not exist on these tables and the UPDATE would fail.
        6. This is a transaction; the table list is enumerated in code (one UPDATE per table, all under one DB transaction). On Postgres, set `SET LOCAL statement_timeout = '60s'` for safety (bumped from `'30s'` in Phase 11 to give the new Tier C join walks headroom).
3. New service: `apps/api/src/scope/scope-context.service.ts` — the request-scoped provider from Phase 5.
4. New service: `apps/api/src/scope/tenant-bootstrap.service.ts` — `ensureTenant(userId): Promise<Tenant>`. Lazy creation logic in one place.

**Tests:**

- Unit: `OrganizationService.createOrganization` handles no-Tenant, has-Tenant, slug-collision, name-empty cases.
- Integration: `POST /api/organizations` end-to-end against an in-memory DB.
- Integration: `upgrade-from-account` moves expected rows, leaves nothing behind, second call is a no-op.

---

## Phase 7 — Slug routing middleware + scope context propagation

**Goal:** Make `/{slug}/...` route shapes work on the API and the web app.

**Changes:**

1. **API (NestJS):**
    - New middleware: `apps/api/src/scope/scope-resolver.middleware.ts`. Reads `:slug` (or `X-Scope-Slug` header for fetch-from-web-client requests), resolves to `{ tenantId, organizationId | null }`, populates `ScopeContext`. 404s on no hit.
    - Apply globally on `/api/*` routes that are scope-sensitive (most of them — exempt list: `/api/auth/*`, `/api/users/check-username`, `/api/organizations/check-slug`).
2. **Web (Next.js App Router):**
    - New segment: `apps/web/src/app/[slug]/...` — mirrors the existing dashboard tree.
    - Slug validated server-side in the layout; on 404, renders a not-found page.
    - Client-side fetcher adds `X-Scope-Slug` header so the API sees the same scope on every call.
3. **Legacy routes** (un-prefixed) — keep them. They resolve to the bare Tenant context for the session's user. Both shapes coexist (additive — NN #20).

**Test surface:**

- E2E: `/{username}/missions` renders the same data as the legacy `/missions` for a user with no Org.
- E2E: `/{orgSlug}/missions` renders only that Org's data; switching the slug in the URL switches the data.
- 404 path: `/notarealslug/missions` returns 404, not 403, not 500.

---

## Phase 8 — WorkspaceSwitcher UI (sidebar-07 reskin)

**Goal:** Ship the user-facing switcher.

**Changes:**

1. New component: `apps/web/src/components/layout/WorkspaceSwitcher.tsx`.
    - Base: shadcn [`sidebar-07`](https://ui.shadcn.com/blocks#sidebar-07) `TeamSwitcher`, renamed and re-skinned.
    - Reads `organizations` from a SWR hook (`useOrganizations()`) backed by `GET /api/organizations`.
    - Empty state: if `organizations.length === 0`, render the existing `<EverWorksLogo />` component unmodified (no chevron, no popover trigger).
    - Active state: render the switcher chip with avatar + display name + chevron.
    - Popover heading: `"Organizations"` (i18n key TBD — `organizations.switcher.heading`).
    - List item: avatar + display name + check icon for currently active.
    - Footer item: `+ Create Organization` → opens `<CreateOrganizationModal />` (Phase 9).
2. Wire `<WorkspaceSwitcher />` into the existing sidebar layout, replacing the standalone `<EverWorksLogo />` placement. The logo placement keeps showing the logo when zero Orgs exist; it just becomes a switcher chip when 1+ exist.
3. State sync on switch:
    - Clicking an Org row in the popover → POST `/api/users/me/scope` (or PATCH the user row) to persist `lastScopeOrganizationId`; navigate to `/{newSlug}/dashboard`.
    - Clicking the bare-Tenant row (if listed per [spec.md §5.5 option b](spec.md#popover-contents)) → same, with `organizationId = null`; navigate to `/{userSlug}/dashboard`.

**Out of scope this phase:** the Create Organization modal itself (Phase 9 — but Phase 8 still ships the entry point that triggers it; the modal can be a stub for the first PR if the team prefers to ship in two PRs).

---

## Phase 9 — CreateOrganizationModal + upgrade-vs-new dialog

**Goal:** Ship the modal flow from [spec.md §5.2](spec.md#52-user-creates-their-first-organization).

**Changes:**

1. New component: `apps/web/src/components/organizations/CreateOrganizationModal.tsx`.
    - Single input: `Name`.
    - Live slug preview (debounced `GET /api/organizations/check-slug?value=<derivedSlug>`).
    - Submit → POST `/api/organizations` → returns the new Org.
2. New component: `apps/web/src/components/organizations/UpgradeOrCreateDialog.tsx`.
    - Renders _only_ if this is the user's first Organization (gate: `(await GET /api/organizations).length === 1`).
    - Two options:
        - **Upgrade current account** (default, pre-selected, focused).
        - **Create with empty data**.
    - Confirm → if "Upgrade", POST `/api/organizations/:id/upgrade-from-account`. If "Empty", do nothing (the Org was already created, it just stays empty).
    - In both branches: navigate to `/{newOrgSlug}/dashboard` and refresh state.
3. Subsequent Org creates (when the user already has 1+ Orgs) skip the dialog entirely — just create + navigate.

**Tests:**

- Unit: `UpgradeOrCreateDialog` defaults to "Upgrade".
- E2E (Playwright): full flow — open switcher, create Org, choose Upgrade, verify existing items show up in new scope.

---

## Phase 10 — Company chip on `+ New` page + Work-of-type-Company → Org wire-up

**Goal:** Make the "Register Company" path (Stripe Atlas etc.) create an Organization on success.

**Changes:**

1. Add `Company` to the chip list on the `+ New` page (per [spec.md §6.3](spec.md#63--new-page--company-chip)). Order: `Mission · Idea · Website · Landing Page · Store · Blog · Directory · Awesome Repo · Knowledge Base · Company`. (Note: `Store` and `Company` were already coming-soon chips in earlier copy — they become real here.)
2. New Work template/type: `Company`. Plumbing follows existing template/type patterns (`Templates` + `WorkType`).
3. New service hook: when a Work of type Company transitions to "registered" status (provider callback or manual marking), the system:
    - Creates an Organization row with `legalName`, `countryCode`, `registrationProvider`, `registrationStatus = 'registered'`, `linkedWorkId = work.id`.
    - Sets `tenantId` to the user's Tenant (lazy-create Tenant if needed).
    - Triggers the `UpgradeOrCreateDialog` flow client-side on the next page load (or via a notification → action handler).
4. The Work itself stays in its original scope. It just gains `organizationId = newOrg.id` so it's visible in the new Org's scope as well as wherever it was created.

---

## Phase 11 — Tier C historical `organizationId` backfill (EW-663)

**Shipped 2026-05-28.** Closes the Tier C gap deferred from Phase 6 step 4.

**Goal:** Backfill `tenantId` + `organizationId` on historical (pre-upgrade) Tier C rows when the user runs `upgrade-from-account`. New Tier C inserts already auto-stamp via the Phase 5b `ScopeStampingSubscriber`; this catches the rows that predate the user's first Organization.

**Changes (pure service-layer + SQL — no migration, no new columns, no new deps):**

1. `OrganizationService.upgradeFromAccount` gained a third backfill stage after the Tier A + Tier B loops:
    - **Direct-user Tier C tables** (`agent_runs`, `skill_bindings`, `usage_ledger_entries`, `plugin_usage_events`, `activity_log`) carry their own `userId` column, so they use the same `UPDATE ... WHERE "userId" = $3 AND "organizationId" IS NULL` shape as Tier A.
    - **Join-walked Tier C tables** (the other 20) propagate scope from their Tier A parent via `UPDATE "child" SET "tenantId" = $1, "organizationId" = $2 FROM "parent" p WHERE "child"."<fk>" = p."id" AND p."userId" = $3 AND "child"."organizationId" IS NULL`.
2. `SET LOCAL statement_timeout` bumped `'30s'` → `'60s'` for join headroom on large tables.
3. New `tierCRowsUpdated: number` on the `upgradeFromAccount` result + `UpgradeFromAccountResponse` contract.

**Tier C → parent FK walk** (26 tables: 5 direct-user + 20 join-walked + 1 deferred):

| Tier C table             | Parent table          | FK column                | Path                                                    |
| ------------------------ | --------------------- | ------------------------ | ------------------------------------------------------- |
| conversation_messages    | conversations         | conversationId           | join                                                    |
| task_assignees           | tasks                 | taskId                   | join                                                    |
| task_approvers           | tasks                 | taskId                   | join                                                    |
| task_reviewers           | tasks                 | taskId                   | join                                                    |
| task_watchers            | tasks                 | taskId                   | join                                                    |
| task_blocks              | tasks                 | taskId                   | join                                                    |
| task_chat_messages       | tasks                 | taskId                   | join                                                    |
| task_kb_mentions         | tasks                 | taskId                   | join                                                    |
| task_attachments         | tasks                 | taskId                   | join                                                    |
| task_relations           | tasks                 | taskId (source endpoint) | join                                                    |
| agent_budgets            | agents                | agentId                  | join                                                    |
| agent_memberships        | agents                | agentId                  | join                                                    |
| agent_run_logs           | agent_runs            | runId                    | join (after agent_runs is stamped)                      |
| work_members             | works                 | workId                   | join                                                    |
| work_invitations         | works                 | workId                   | join                                                    |
| work_generation_history  | works                 | workId                   | join                                                    |
| work_knowledge_chunks    | works                 | work_id (snake-case)     | join                                                    |
| work_knowledge_citations | works                 | workId                   | join                                                    |
| work_knowledge_tags      | works                 | workId                   | join                                                    |
| work_knowledge_uploads   | works                 | workId                   | join                                                    |
| agent_runs               | — (direct `userId`)   | —                        | direct                                                  |
| skill_bindings           | — (direct `userId`)   | —                        | direct                                                  |
| usage_ledger_entries     | — (direct `userId`)   | —                        | direct                                                  |
| plugin_usage_events      | — (direct `userId`)   | —                        | direct                                                  |
| activity_log             | — (direct `userId`)   | —                        | direct                                                  |
| webhook_deliveries       | webhook_subscriptions | subscriptionId           | **deferred — parent has no direct user FK (Phase 11b)** |

**Deviation from the original prompt mapping:** `agent_runs` was expected to be join-walked via `agentId`, but the entity carries a direct `userId` so it moved to the direct-user path. `agent_run_logs` uses `runId` (not `agentRunId`). `task_blocks` uses `taskId` (its sibling FK is `blockedByTaskId`); `task_relations` uses `taskId` (sibling `relatedTaskId`). `work_knowledge_*` parent FK is `documentId` for the doc tables in some other contexts, but for scope ownership we walk the direct `workId`/`work_id` column straight to `works` (the KB-document tables themselves are not user-owned Tier A). `webhook_deliveries` is deferred because `webhook_subscriptions` has no direct `userId` (it uses `accountId`).

**Tests:** extended `organization.service.spec.ts` — Tier C UPDATE shapes + params, total `tierCRowsUpdated`, idempotency (second call = 0), and the 60s `statement_timeout` bump.

---

## Cross-cutting concerns

### Database safety

- All migrations are forward-only and additive (NN #16).
- No DROP / ALTER TYPE / data deletion anywhere.
- Pre-checks at the top of each migration to detect impossible states (e.g. duplicate usernames, orphan `organizationId` UUIDs); fail loud rather than silently corrupting.
- Every PR with a TypeORM entity change ships the corresponding migration in the same PR (NN #16).

### Tests

Each phase ships with:

- Migration tests (apply + revert idempotency).
- Entity tests (round-trip, ClassToObject).
- Service unit tests for new business logic.
- Integration tests for new API endpoints.
- E2E tests for new user-facing flows (Phases 7–10).

The bar: existing 26 agent test suites + 719 tests all keep passing. New phases add their own suites alongside.

### Rollout

- **No feature flag needed for v1.** The columns are added but unused on existing data; the switcher is gated by `organizations.length === 0` (no UI change for users who don't have Orgs). Forward-looking and safe.
- Deploy in phase order. Each phase is a separately mergeable PR. The full work spans Phases 0 → 10.

### CI / release gates

Refer to [`CI_RELEASE_GATES.md`](../../../../../../Workspace/knowledge/runbooks/CI_RELEASE_GATES.md):

- Lightweight CI runs on every PR + release-branch push (typecheck, lint, agent test suite).
- Medium/heavy CI runs on `stage`/`main` pushes only.
- All 10 phase PRs follow the standard `develop → stage → main` cascade (NN #21).

---

## Sequencing summary

| Phase | Title                                             | Depends on | PR target |
| ----- | ------------------------------------------------- | ---------- | --------- |
| 0     | Username uniqueness contract                      | —          | `develop` |
| 1     | Create `tenants` + `organizations` tables         | 0          | `develop` |
| 2     | `tenantId` on users + Tier B                      | 1          | `develop` |
| 3     | `tenantId` + `organizationId` on Tier A           | 1          | `develop` |
| 4     | Upgrade existing free-form `organizationId` to FK | 1, 3       | `develop` |
| 5     | Tier C denormalization                            | 1, 3       | `develop` |
| 6     | Lazy upgrade flow + Organization-create API       | 2, 3, 4, 5 | `develop` |
| 7     | Slug routing middleware                           | 6          | `develop` |
| 8     | WorkspaceSwitcher UI                              | 6, 7       | `develop` |
| 9     | CreateOrganizationModal + upgrade-vs-new dialog   | 6, 7, 8    | `develop` |
| 10    | Company chip + Work→Org wire-up                   | 6, 7       | `develop` |
| 11    | Tier C historical `organizationId` backfill       | 5, 6       | `develop` |

Phases 3, 4, 5 can run in parallel after Phase 1. Phases 8, 9, 10 can run in parallel after Phases 6–7. Otherwise, sequential.
