# Tenants & Organizations — Acceptance Criteria

**Status:** Draft v1 · **Date:** 2026-05-27
**Spec:** [spec.md](spec.md) · **Plan:** [plan.md](plan.md) · **Tasks:** [tasks.md](tasks.md)

This file describes the **observable behavior** required for each phase to be considered complete. Implementation details are in plan/tasks; this file is the user-and-reviewer-visible contract.

---

## Phase 0 — Username uniqueness contract

### AC-0.1 — DB-enforced uniqueness

- Two attempts to `INSERT INTO users (username) VALUES ('ever')` (case-equivalent — `EVER`, `Ever`, `ever`) from any code path fail with a UNIQUE violation. Postgres + SQLite both enforce.

### AC-0.2 — Slug column present

- Every user row has a non-null `slug` column populated with the URL-safe form of `username`. The slug is also case-insensitively unique.

### AC-0.3 — Programmatic collision flow

- An OAuth signup whose suggested username already exists produces a User with `username = '<suggested>-2'` (next free integer). No error surfaced to the user.

### AC-0.4 — Interactive collision flow

- `GET /api/users/check-username?value=ever` for an existing `ever` user returns `{ available: false, suggestion: 'ever-2' }`.
- `GET /api/users/check-username?value=verynewname` returns `{ available: true }`.

### AC-0.5 — No regressions

- Existing 26 agent test suites + 719 tests pass. Existing auth flows (login, GitHub App, anonymous claim) succeed.

---

## Phase 1 — `tenants` and `organizations` tables

### AC-1.1 — Tables exist

- After migration: `SELECT * FROM tenants` and `SELECT * FROM organizations` succeed and return zero rows.
- Both tables have the indexes specified in [spec.md §1.1 / §1.2](spec.md#1-the-two-concepts).

### AC-1.2 — FK + cascade behavior

- `DELETE FROM tenants WHERE id = X` cascades to delete every Organization with `tenantId = X`.
- `DELETE FROM works WHERE id = X` sets `organizations.linkedWorkId = NULL` for any Org pointing at it.

### AC-1.3 — No row writes

- Phase 1 does not insert any row anywhere. No existing user gains a `tenantId`.

---

## Phase 2 — `tenantId` on `users` + Tier B

### AC-2.1 — Columns present

- `users.tenantId`, `auth_accounts.tenantId`, etc. all exist as nullable UUID columns.

### AC-2.2 — No backfill

- All existing rows have `tenantId IS NULL`.

### AC-2.3 — No write-path change

- Creating a new User via any existing signup path still produces `tenantId = NULL` (no Tenant exists yet for them).

---

## Phase 3 — Tier A entities

### AC-3.1 — Columns present

- Every Tier A entity has both `tenantId` and `organizationId` as nullable UUID columns.

### AC-3.2 — Indexes present

- `idx_<table>_tenant_id` and `idx_<table>_organization_id` exist on each table per [spec.md §2.3](spec.md#23-three-tiers-of-entities-which-columns-each-tier-gets).

### AC-3.3 — Idempotent migrations

- Running each migration twice does not error (matches the existing `hasColumn` guard pattern).

---

## Phase 4 — FK upgrade for pre-existing `organizationId`

### AC-4.1 — FK enforced

- `INSERT INTO works (..., organizationId)` with a UUID not in `organizations.id` fails with FK violation.
- Same for `work_knowledge_documents`.

### AC-4.2 — Cascade behavior

- `DELETE FROM organizations WHERE id = X` sets `works.organizationId = NULL` and `work_knowledge_documents.organizationId = NULL` for matching rows.

---

## Phase 5 — Tier C denormalization

### AC-5.1 — Columns present

- All Tier C entities have `tenantId` (nullable) and, where parent has it, `organizationId` (nullable).

### AC-5.2 — Service propagation

- After Phase 5, creating any Tier C row via the affected services (with an actor whose User has a `tenantId` set) results in the row having `tenantId` populated to match.
- If the actor's User has `tenantId = NULL`, the row has `tenantId = NULL` (no change from pre-Phase-5 behavior).

### AC-5.3 — Audit script clean

- An audit query `SELECT COUNT(*) FROM <tier_c_table> WHERE tenantId IS NULL AND <parent_fk> IN (SELECT id FROM <parent> WHERE tenantId IS NOT NULL)` returns 0 for every Tier C table.

---

## Phase 6 — Lazy upgrade + Org-create API

### AC-6.1 — First Organization creates a Tenant

- User Alice has `tenantId = NULL` initially.
- `POST /api/organizations { "name": "Acme Inc" }` succeeds; response includes the new Organization.
- After the call: Alice has `tenantId = <new>`, exactly one Tenant row exists for her, one Organization row exists with `tenantId = Alice.tenantId`.

### AC-6.2 — Second Organization reuses the Tenant

- Alice creates `Globex LLC` via the same endpoint. After the call: exactly one Tenant row for Alice, two Organization rows, both with the same `tenantId`.

### AC-6.3 — Upgrade-from-account moves rows

- Alice has 5 Missions, 3 Works, 12 Tasks all with `organizationId IS NULL` (currently in her Tenant root).
- `POST /api/organizations/:id/upgrade-from-account` moves all 20 rows: their `organizationId` is now the upgraded Org's id.
- Re-running the same endpoint a second time is a no-op (idempotent).

### AC-6.4 — Slug uniqueness across tables

- `GET /api/organizations/check-slug?value=alice` returns `{ available: false }` if Alice's `users.slug` is `alice`.
- Creating an Org with a slug that collides with an existing `users.slug` or `organizations.slug` either fails with a clear 409 (interactive flow) or auto-suffixes (programmatic flow).

### AC-6.5 — Tenant ownership enforced

- Bob attempts `POST /api/organizations/<aliceOrgId>/upgrade-from-account`. Server returns 404 (not 403 — see [spec.md §4.3](spec.md#43-authorization)).

---

## Phase 7 — Slug routing

### AC-7.1 — Slug routes resolve

- `GET /api/missions` on Alice's session with `X-Scope-Slug: alice` returns Alice's bare-Tenant Missions.
- `GET /api/missions` with `X-Scope-Slug: acme-inc` returns only Acme Inc's Missions.
- `GET /api/missions` with `X-Scope-Slug: notarealsulug` returns 404.

### AC-7.2 — Org takes precedence on collision (defensive)

- A degenerate test setup with `users.slug = 'acme'` and `organizations.slug = 'acme'` (which shouldn't be possible thanks to the allocator) resolves to the Organization. _(This is a defensive check; the allocator prevents this case at write time.)_

### AC-7.3 — Web app routes work

- Navigating to `/alice/missions` shows Alice's bare-Tenant data.
- Navigating to `/acme-inc/missions` shows Acme Inc's data only.
- Bookmarks to the existing un-prefixed URLs (`/missions`) still work for the lifetime of v1.

---

## Phase 8 — WorkspaceSwitcher UI

### AC-8.1 — Empty state shows the Ever Works logo

- A user with zero Organizations sees the existing Ever Works logo in the top-left sidebar slot. No chevron, no popover trigger, no visual hint that switching is possible.

### AC-8.2 — Active state shows the switcher chip

- A user with 1+ Organizations sees a chip displaying the currently active scope (Org logo + name OR user's display name if on bare Tenant) and a small chevron icon.

### AC-8.3 — Popover lists Organizations

- Clicking the chip opens a popover with heading "**Organizations**" (NOT "Workspaces", NOT "Tenants" — verified in i18n).
- The currently active scope has a check icon.
- Footer item "+ Create Organization" is present.

### AC-8.4 — Switching navigates and persists

- Clicking a different Organization navigates the user to `/{newOrgSlug}/dashboard` and persists `users.lastScopeOrganizationId`. The next session login lands on the same scope.

---

## Phase 9 — CreateOrganizationModal + upgrade-vs-new dialog

### AC-9.1 — First-Org dialog defaults to Upgrade

- When the user creates their FIRST Organization, the upgrade-vs-new dialog appears with "Upgrade current account" pre-selected and focused.

### AC-9.2 — Upgrade choice moves all existing items

- After confirming "Upgrade", every Tier A/B/C row owned by the user gets its `organizationId` set to the new Org. The new Org scope now shows the user's pre-existing items.

### AC-9.3 — Empty choice leaves bare Tenant intact

- After confirming "Create with empty data", the new Org scope is empty; the bare-Tenant scope still shows the user's pre-existing items.

### AC-9.4 — Subsequent Orgs skip the dialog

- When the user creates a SECOND (or later) Organization, no upgrade-vs-new dialog is shown. The Org is created empty.

### AC-9.5 — Slug live-check

- The modal shows a live slug suggestion (debounced) and disables submit until the slug is available.

---

## Phase 10 — Company chip + Work→Org wire-up

### AC-10.1 — Chip present and ordered

- The `+ New` page shows the chips in the order: `Mission · Idea · Website · Landing Page · Store · Blog · Directory · Awesome Repo · Knowledge Base · Company`.

### AC-10.2 — Company chip routes to Register Company flow

- Selecting the Company chip + submitting the prompt opens the Register Company flow (UI copy uses "**Register Company**", not "Create Organization").

### AC-10.3 — Registered Company creates an Organization

- When a Work of type Company is marked `registered`, an Organization row is created with `legalName`, `countryCode`, `registrationProvider`, `registrationStatus = 'registered'`, `linkedWorkId = work.id`.

### AC-10.4 — Work stays in place

- The Work that triggered the registration stays in its original scope (no relocation). It does, however, gain `organizationId = newOrg.id` so it's also visible in the new Org's scope.

### AC-10.5 — First-Org upgrade dialog triggers (if applicable)

- If this is the user's FIRST Organization (regardless of whether it came from manual create or Stripe-Atlas), the upgrade-vs-new dialog appears with the same defaults.

---

## Cross-cutting acceptance

### AC-X.1 — No live data corruption

- Running the full migration set on a snapshot of staging data leaves all existing tests green and no orphan rows.

### AC-X.2 — Reversibility

- Every migration's `down()` method runs cleanly in reverse order. (Not a routine operation, but the safety valve.)

### AC-X.3 — CI gates

- Lightweight CI (typecheck, lint, agent test suite) is green on every PR.
- Medium + heavy CI (E2E, Lighthouse, k8s-e2e) is green on the `develop → stage` and `stage → main` cascade PRs.

### AC-X.4 — No NN violations

- No PR removes existing UI strings or surfaces (NN #20).
- Every PR with an entity change ships the migration in the same PR (NN #16).
- No PR force-pushes or pushes directly to `main`/`master`/`stage` (NN #21).

### AC-X.5 — Documentation up-to-date

- [spec.md](spec.md) reflects any deviation discovered during implementation (treated as additive amendments — never silent reshapes).
- [tasks.md](tasks.md) checkboxes are ticked as each item lands.
- The companion Workspace note [2026-05-27-tenants-and-organizations-spec.md](../../../../../../Workspace/knowledge/notes/2026-05-27-tenants-and-organizations-spec.md) is kept in sync.

---

## Definition of Done (overall)

The Tenants & Organizations feature is **done** when:

1. All 10 phases land on `develop` and cascade to `stage` and `main` per NN #21.
2. Every Acceptance Criterion above is observably true on `stage`.
3. The Workspace companion note links to the Epic in JIRA and back to this spec.
4. The implementation prompt (for fresh agents) in the conversation history has been superseded (or marked as completed in JIRA).
5. The Missions/Ideas/Works spec ([2026-05-24-missions-ideas-works-spec.md](../../../../../../Workspace/knowledge/notes/2026-05-24-missions-ideas-works-spec.md)) is cross-referenced from this spec, and vice versa.
