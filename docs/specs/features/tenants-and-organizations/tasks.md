# Tenants & Organizations — Task Checklist

**Status:** Draft v1 · **Date:** 2026-05-27
**Spec:** [spec.md](spec.md) · **Plan:** [plan.md](plan.md) · **Acceptance:** [acceptance.md](acceptance.md)

This file is the granular checklist agents and reviewers tick off as work lands. JIRA Epic + Story keys are added once the tickets exist (see "JIRA linkage" at the bottom).

---

## Phase 0 — Username uniqueness contract

### Database

- [ ] Migration `AddUniqueIndexToUsername` — pre-check duplicates, add `lower(username)` UNIQUE expression index (Postgres) / UNIQUE on raw column (SQLite).
- [ ] Migration `AddSlugToUsers` — add nullable `slug`, backfill from `username` via URL-normalize, add UNIQUE expression index on `lower(slug)`, flip NOT NULL.

### Entities

- [ ] `user.entity.ts` — `username` gets `unique: true`; add `@Column({ unique: true }) slug: string`.

### Services

- [ ] New `apps/api/src/users/username-allocator.service.ts` exporting `allocateUsername(base)` and `allocateSlug(base, ownerTable)`.
- [ ] Replace inline loop in `apps/api/src/integrations/github-app/github-app-onboarding.service.ts:223-229` with `UsernameAllocatorService.allocateUsername(base)`.

### API

- [ ] `GET /api/users/check-username?value=<string>` — public, throttled, returns `{ available, suggestion? }`.

### Tests

- [ ] `username-allocator.service.spec.ts` — collision suffixing, idempotency, normalization edge cases.
- [ ] `users.check-username.controller.spec.ts` — happy path + collision suggestion.
- [ ] Migration test for both migrations (apply + revert).

---

## Phase 1 — Create `tenants` and `organizations` tables

### Database

- [ ] Migration `CreateTenantsTable`.
- [ ] Migration `CreateOrganizationsTable`.

### Entities

- [ ] `packages/agent/src/entities/tenant.entity.ts`.
- [ ] `packages/agent/src/entities/organization.entity.ts`.
- [ ] Register in `packages/agent/src/entities/index.ts`.

### Repositories

- [ ] `TenantRepository` (under `packages/agent/src/database/`).
- [ ] `OrganizationRepository`.

### Tests

- [ ] Migration tests.
- [ ] `tenant.entity.spec.ts` — round-trip + ClassToObject.
- [ ] `organization.entity.spec.ts` — round-trip + ClassToObject + FK cascades.

---

## Phase 2 — `tenantId` on `users` and Tier B entities

### Database

- [ ] Migration `AddTenantIdToUsers` — nullable `tenantId uuid` FK + index, **no backfill**. ALSO adds the nullable `users.lastScopeOrganizationId uuid` FK column (→ `organizations(id)` ON DELETE SET NULL) in the same migration — see [spec.md §5.6](spec.md#56-default-organization-on-next-login). NULL means "default to bare Tenant on next login."
- [ ] Migration `AddTenantIdToTierB` — same shape, applied to: `auth_accounts`, `auth_sessions`, `auth_verifications`, `refresh_tokens`, `user_template_preferences`, `user_task_counters`.

### Entities

- [ ] `user.entity.ts` — add `@ManyToOne(() => Tenant, { nullable: true })` AND `@ManyToOne(() => Organization, { nullable: true })` for `lastScopeOrganization`.
- [ ] Six Tier B entities — same.

---

## Phase 3 — Tier A entities (both columns)

For each of the entities below, do all four sub-tasks (migration, entity, repo, test). One PR per group is fine; or batch by domain if review-friendly.

- [ ] `missions` — `tenantId` + `organizationId`, both nullable, both FK + index.
- [ ] `work_proposals` (Ideas) — both.
- [ ] `tasks` — both.
- [ ] `agents` — both.
- [ ] `skills` — both.
- [ ] `conversations` — both.
- [ ] `notifications` — both.
- [ ] `api_keys` — both.
- [ ] `templates` — both.
- [ ] `template_customizations` — both.
- [ ] `user_subscriptions` — both.
- [ ] `work_schedules` — both.
- [ ] `work_deployments` — both.
- [ ] `onboarding_requests` — both.
- [ ] `webhook_subscriptions` — both.
- [ ] `github_app_installations` — both.
- [ ] `github_app_user_links` — both.
- [ ] `works` — **only `tenantId`** (organizationId already exists; FK upgrade is Phase 4).
- [ ] `work_knowledge_documents` — **only `tenantId`** (same reason).

Tests:

- [ ] One migration test per entity (idempotency).
- [ ] Entity spec updated for each (column nullable, ClassToObject round-trip).

---

## Phase 4 — FK upgrade for pre-existing `organizationId` columns

- [ ] Migration `UpgradeWorkOrganizationIdToFk` — orphan-UUID null-out + add FK + index already exists (verify).
- [ ] Migration `UpgradeWorkKnowledgeDocumentOrganizationIdToFk` — same.
- [ ] Entity update — `work.entity.ts` and `work-knowledge-document.entity.ts` declare `@ManyToOne(() => Organization, ...)`.

---

## Phase 5 — Tier C children (denormalized scope)

For each Tier C entity below: migration adds `tenantId` (always) + `organizationId` (if parent has it). Service-layer create paths updated to set both.

- [ ] `conversation_messages` — both.
- [ ] `task_assignees`, `task_approvers`, `task_reviewers`, `task_watchers`, `task_blocks`, `task_chat_messages`, `task_kb_mentions`, `task_attachments`, `task_relations` — both.
- [ ] `agent_runs`, `agent_run_logs`, `agent_budgets`, `agent_memberships` — both.
- [ ] `skill_bindings` — both.
- [ ] `work_members`, `work_invitations`, `work_generation_history` — both.
- [ ] `work_knowledge_chunks`, `work_knowledge_citations`, `work_knowledge_tags`, `work_knowledge_uploads` — both.
- [ ] `webhook_deliveries`, `usage_ledger_entries`, `plugin_usage_events`, `activity_log` — both.

Service updates:

- [ ] New `ScopeContext` request-scoped provider (`apps/api/src/scope/scope-context.service.ts`).
- [ ] Walk through every Tier C row creation path; set `tenantId` + `organizationId` from `ScopeContext`.
- [ ] Background-job / agent-tick / scheduled-task paths: extract scope from the parent entity being processed.

Tests:

- [ ] Per-entity migration test.
- [ ] Service-level: assert new rows have `tenantId` set when the actor has a Tenant.
- [ ] Integration tests for the affected services to verify scope propagation.

---

## Phase 6 — Lazy upgrade flow + Org-create API

### API endpoints

- [ ] `POST /api/organizations` — create Org, lazy-create Tenant if needed.
- [ ] `POST /api/organizations/:id/upgrade-from-account` — backfill existing rows.
- [ ] `GET /api/organizations` — list for current user's Tenant.
- [ ] `GET /api/organizations/:slug` — fetch by slug.
- [ ] `PATCH /api/organizations/:id` — update Org metadata.
- [ ] `GET /api/organizations/check-slug?value=<string>` — slug availability.

### Services

- [ ] `apps/api/src/organizations/organization.service.ts`:
    - [ ] `createOrganization(userId, name, slug?)`.
    - [ ] `upgradeFromAccount(userId, organizationId)` — transactional, idempotent.
- [ ] `apps/api/src/scope/tenant-bootstrap.service.ts` — `ensureTenant(userId)`.

### DTOs / contracts

- [ ] Add `CreateOrganizationDto`, `UpdateOrganizationDto`, `OrganizationResponseDto` to `packages/contracts/api`.
- [ ] OpenAPI annotations on every endpoint so the MCP server picks them up.

### Tests

- [ ] `organization.service.spec.ts` — all branches.
- [ ] `organization.controller.spec.ts` — all endpoints.
- [ ] Integration test for `upgrade-from-account` flow end-to-end.

---

## Phase 7 — Slug routing middleware

### API

- [ ] `apps/api/src/scope/scope-resolver.middleware.ts` — reads `:slug` param or `X-Scope-Slug` header.
- [ ] Apply middleware globally on `/api/*` with exempt list (`/api/auth/*`, `/api/users/check-username`, `/api/organizations/check-slug`).

### Web (Next.js)

- [ ] New segment `apps/web/src/app/[slug]/` mirroring the existing dashboard tree.
- [ ] Layout-level slug validation + redirect to user's default scope on root path.
- [ ] Client fetcher passes `X-Scope-Slug` on every API call from a scoped page.

### Tests

- [ ] Middleware unit test — all branches (Org hit, User hit, 404).
- [ ] E2E: `/{username}/missions` vs `/{orgSlug}/missions` show correct data sets.
- [ ] E2E: 404 on bad slug.

---

## Phase 8 — WorkspaceSwitcher UI

### Components

- [ ] `apps/web/src/components/layout/WorkspaceSwitcher.tsx` (reskin of shadcn sidebar-07 TeamSwitcher).
- [ ] `apps/web/src/hooks/useOrganizations.ts` (SWR over `GET /api/organizations`).
- [ ] `apps/web/src/hooks/useActiveScope.ts` (current scope from URL slug).

### Wiring

- [ ] Replace standalone Ever Works logo placement in sidebar with `<WorkspaceSwitcher />`.
- [ ] Empty state path: render `<EverWorksLogo />` unmodified when `organizations.length === 0`.

### i18n

- [ ] Add new keys: `organizations.switcher.heading` ("Organizations"), `organizations.switcher.createNew` ("Create Organization"), `organizations.switcher.bareTenant` ("My account" or fallback to username). Update all locales (NN-equivalent: don't half-translate).

### Tests

- [ ] Unit: empty state renders logo only.
- [ ] Unit: active state renders chip + chevron + popover with correct items.
- [ ] Playwright: clicking another Org in popover navigates to its slug.

---

## Phase 9 — CreateOrganizationModal + upgrade-vs-new dialog

### Components

- [ ] `apps/web/src/components/organizations/CreateOrganizationModal.tsx` — single-name form, live slug preview, submit.
- [ ] `apps/web/src/components/organizations/UpgradeOrCreateDialog.tsx` — first-Org-only, defaults to Upgrade.
- [ ] **Settings → Account "Create your first Organization" banner** — gate on `organizations.length === 0`; opens the same `CreateOrganizationModal`. Required because the empty-state switcher is intentionally silent ([spec.md §5.5](spec.md#empty-state-zero-organizations)) so there must be an alternative discoverable entry point. Lives on the existing `/{slug}/settings/account` page (or equivalent), banner auto-hides once the user has at least one Org.

### Wiring

- [ ] Switcher's "+ Create Organization" item opens the modal.
- [ ] On modal submit (server returns the new Org), if it's the user's first Org → open the dialog; else → just navigate.
- [ ] Settings-page banner → same modal handler.

### i18n

- [ ] Modal copy: name field label, slug preview, submit button.
- [ ] Dialog copy: "Upgrade current account" (default) and "Create with empty data" descriptions per [spec.md §5.2](spec.md#52-user-creates-their-first-organization). Refine final wording with Product/Design.

### Tests

- [ ] Unit: dialog default focus is on "Upgrade".
- [ ] Playwright: full flow — open switcher → create Org → choose Upgrade → existing items appear in new scope.
- [ ] Playwright: full flow — choose Empty → new scope is empty; bare-Tenant scope still has the user's items.

---

## Phase 10 — Company chip on `+ New` + Work-of-type-Company → Org wire-up

### `+ New` page

- [ ] Add `Company` to the chip array in order specified in [spec.md §6.3](spec.md#63--new-page--company-chip).
- [ ] Picking the `Company` chip routes the submit into the Register-Company sub-flow.

### Work type "Company"

- [ ] New template / WorkType `Company` plumbed through existing template/type patterns.
- [ ] Registration provider integration (Stripe Atlas — out of scope to _implement_ if no SDK yet; the WorkType + manual-completion path is enough for v1).

### Wire-up

- [ ] On Company Work transitioning to `registered` status:
    - [ ] Lazy-create Tenant if needed.
    - [ ] Create Organization row with `legalName`, `countryCode`, `registrationProvider`, `registrationStatus='registered'`, `linkedWorkId=work.id`.
    - [ ] Trigger client-side `UpgradeOrCreateDialog` (via in-app notification → action) if this is the user's first Org.

### Tests

- [ ] E2E: pick Company chip → fill details → mark registered → Organization appears in switcher → user is offered the upgrade dialog.

---

## Cross-cutting

- [ ] Update `apps/docs/` user-facing documentation: Organizations & scopes.
- [ ] Update `apps/web/src/components/onboarding/*` if the onboarding wizard references the future Org flow.
- [ ] No changes to existing UI strings other than additions (per NN #20).
- [ ] Every entity touched gets a migration in the same PR (NN #16).
- [ ] Every PR drives to a clean review state (NN #14) and green CI (NN #19).
- [ ] All PRs target `develop`; never `main`/`master`/`stage` directly (NN #21).

---

## JIRA linkage

JIRA Epic and per-phase Stories live in the `EW` project at <https://evertech.atlassian.net>:

- **Epic:** [EW-651](https://evertech.atlassian.net/browse/EW-651) — Tenants & Organizations
    - Phase 0 — Username uniqueness contract: [EW-652](https://evertech.atlassian.net/browse/EW-652)
    - Phase 1 — Create tenants + organizations tables: [EW-653](https://evertech.atlassian.net/browse/EW-653)
    - Phase 2 — `tenantId` on users + Tier B: [EW-654](https://evertech.atlassian.net/browse/EW-654)
    - Phase 3 — `tenantId` + `organizationId` on Tier A: [EW-655](https://evertech.atlassian.net/browse/EW-655)
    - Phase 4 — Upgrade free-form `organizationId` to FK: [EW-656](https://evertech.atlassian.net/browse/EW-656)
    - Phase 5 — Tier C denormalization: [EW-657](https://evertech.atlassian.net/browse/EW-657)
    - Phase 6 — Lazy upgrade flow + Org-create API: [EW-658](https://evertech.atlassian.net/browse/EW-658)
    - Phase 7 — Slug routing middleware: [EW-659](https://evertech.atlassian.net/browse/EW-659)
    - Phase 8 — WorkspaceSwitcher UI: [EW-660](https://evertech.atlassian.net/browse/EW-660)
    - Phase 9 — CreateOrganizationModal + upgrade-vs-new dialog: [EW-661](https://evertech.atlassian.net/browse/EW-661)
    - Phase 10 — Company chip + Work→Org wire-up: [EW-662](https://evertech.atlassian.net/browse/EW-662)

(See [JIRA_ATLASSIAN_MCP.md](../../../../../../Workspace/knowledge/runbooks/JIRA_ATLASSIAN_MCP.md) for ticket-management commands.)
