# Organization Switch Scope Persistence Implementation Plan

> **For Codex:** Execute this plan in `E:\Coding\_worktrees\ever-works-org-switch-scope` on
> `codex/fix-organization-switch-scope`. Follow test-driven development and do not merge or deploy.

**Goal:** Make the real WorkspaceSwitcher persist the selected Organization before navigation, make
`/{organizationSlug}/dashboard` load safely, and prove subsequent Mission, Goal, Work, and Agent writes
inherit that persisted Organization through the existing session-scope guard.

**Architecture:** Add an authenticated `GET/POST /api/users/me/scope` API that validates the requested
Organization against the caller's Tenant before updating `users.lastScopeOrganizationId`. Proxy it through a
Next.js BFF so the browser never receives the bearer token. The client hook reads the persisted selection on
legacy routes, while the switcher POSTs before navigating. A narrow slug-dashboard compatibility Server
Component validates that its slug equals the persisted active Organization and redirects to the existing root
dashboard without mutating on GET. Existing unprefixed API calls remain unchanged: `SessionScopeGuard` seeds
their request scope from the persisted column.

**Tech Stack:** NestJS 11, TypeORM, Next.js 16 App Router, React 19, Vitest/Testing Library, Jest, Playwright.

---

## Task 1: Lock the authenticated active-scope API contract

**Files:**

- Create: `apps/api/src/users/dto/update-active-scope.dto.ts`
- Create: `apps/api/src/users/services/active-scope.service.ts`
- Create: `apps/api/src/users/services/active-scope.service.spec.ts`
- Create: `apps/api/src/users/controllers/user-scope.controller.ts`
- Create: `apps/api/src/users/controllers/user-scope.controller.spec.ts`
- Modify: `apps/api/src/users/users.module.ts`

1. Write service tests that fail because no active-scope service exists. Cover:
    - returning the persisted Organization;
    - persisting a same-Tenant slug;
    - explicit `null` personal/bare-Tenant scope, required by the existing product contract;
    - unknown and foreign slugs returning the same not-found outcome;
    - `UserRepository.update` never being called for either rejection;
    - a stale persisted pointer returning bare-Tenant scope without mutating during GET.
2. Run the focused Jest test and capture the expected RED failure.
3. Implement the minimum service, DTO, controller, and module wiring.
4. Add thin controller tests for GET/POST delegation and run the focused suite GREEN.

## Task 2: Lock the browser-to-BFF switch contract

**Files:**

- Create: `apps/web/src/app/api/users/me/scope/route.ts`
- Create: `apps/web/src/app/api/users/me/scope/route.unit.spec.ts`
- Modify: `apps/web/src/components/layout/WorkspaceSwitcher.tsx`
- Modify: `apps/web/src/components/layout/WorkspaceSwitcher.unit.spec.tsx`

1. Add a failing component test that opens the real switcher row, clicks a second Organization, and proves:
    - `POST /api/users/me/scope` receives `{ organizationSlug }`;
    - navigation does not happen before persistence resolves;
    - successful persistence navigates to `/{slug}/dashboard`;
    - failed persistence leaves the route and active label unchanged.
2. Add failing BFF route tests for authenticated forwarding, unauthenticated 401, invalid JSON, and upstream
   status/body propagation.
3. Run both tests RED.
4. Implement the route handler and asynchronous switcher flow. Disable duplicate selection while pending and
   surface a safe error without navigating.
5. Run both focused Vitest files GREEN.

## Task 3: Restore persisted active scope on legacy routes

**Files:**

- Create: `apps/web/src/lib/hooks/use-active-scope.unit.spec.tsx`
- Modify: `apps/web/src/lib/hooks/use-active-scope.ts`
- Modify: `apps/web/src/components/layout/WorkspaceSwitcher.tsx`

1. Write failing hook tests proving URL slug precedence, persisted-scope fallback on `/`, and an immediate
   in-component selection update after a successful switch.
2. Run the hook test RED.
3. Add a request-local client hook state that GETs the BFF when no slug is present and exposes a setter for a
   successful switch. Do not use localStorage as an authority.
4. Run hook and switcher tests GREEN.

## Task 4: Make the slug dashboard URL safe without GET mutation

**Files:**

- Create: `apps/web/src/app/[locale]/[slug]/dashboard/page.tsx`
- Create: `apps/web/src/app/[locale]/[slug]/dashboard/page.unit.spec.ts`

1. Write failing Server Component contract tests proving:
    - a slug matching `GET /users/me/scope` redirects to `/`;
    - a mismatched, personal, failed, or unknown active scope produces not-found;
    - the route performs GET only and never changes active scope.
2. Run the route test RED.
3. Implement the narrow async-`params` App Router page using `serverFetch`, `redirect`, and `notFound`.
4. Run the route test GREEN.

## Task 5: Replace the fake end-to-end propagation proof

**Files:**

- Modify: `apps/web/e2e/flow-org-switch-context-propagation.spec.ts`
- Modify: `apps/web/e2e/organization-create-switch.spec.ts`
- Modify only if needed: `apps/web/e2e/helpers/organizations.ts`

1. Replace the localStorage/manual-header UI test with a real browser click that observes the BFF POST,
   successfully traverses the compatibility URL, returns to the dashboard, and shows the selected Organization.
2. Add API integration coverage that POSTs the active scope and then uses a fresh login with no
   `X-Scope-Slug` header. Prove GET returns the same Organization.
3. Prove unknown and foreign Organization slugs do not change the previously selected scope.
4. Through the real API paths, create isolated test Mission, Goal, Work, and Agent rows after selection without
   a scope header and assert each response is stamped with the selected `organizationId` and `tenantId`.
   Do not use production data and do not add Fleet behavior in this task.
5. Update the older switch test to expect the validated compatibility redirect rather than a permanent slug URL.
6. Run the focused Playwright spec against the local e2e stack. If environment services are unavailable,
   preserve the runnable contract and report that constraint separately from unit/integration evidence.

## Task 6: Verify, review, and hand off without rollout

1. Run focused Jest and Vitest suites fresh.
2. Run API/web type-check and lint for the changed applications.
3. Run API/web builds proportional to the cross-boundary change.
4. Inspect the diff for secrets, migrations, plugin/Fleet files, deletion, and accidental scope expansion.
5. Run the repository's applicable React quality checklist after TSX edits.
6. Commit with a conventional semantic message and push only `codex/fix-organization-switch-scope`.
7. Open a PR to `develop` if permitted, but do not merge or deploy while the existing rollout claim is active.
8. Keep the maintenance claim active for review/rollout, update its heartbeat accurately, and report exact
   commands, branch/PR, remaining rollout gate, and rollback (`revert` the feature commit/PR).
