# Task Breakdown: Integrations — GitHub App

**Feature ID**: `integrations-github-app`
**Plan**: `./plan.md`
**Status**: `Done` (retrospective — surface already shipped)
**Last updated**: 2026-05-08

---

## Phase 1 — Module + config (shipped)

- [x] **T1**. Nest module at
      [`apps/api/src/integrations/github-app/github-app.module.ts`](../../../../apps/api/src/integrations/github-app/github-app.module.ts)
    - Imports `DatabaseModule`, `HttpModule`, `AuthModule`,
      `WorkModule`, `ImportModule`.
    - Providers: `GitHubAppService`, `GitHubAppOnboardingService`,
      `GitHubAppSyncService`.
    - Controllers: `GitHubAppController`,
      `GitHubAppWebhookController`.
    - Exports the three services so the agent-onboarding flow can
      re-use them.
- [x] **T2**. `config.githubApp.*` in
      [`apps/api/src/config/constants.ts`](../../../../apps/api/src/config/constants.ts)
    - Reads `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`,
      `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY` (with
      `\\n` → `\n` rewrite), `GITHUB_APP_WEBHOOK_SECRET`,
      `GITHUB_APP_SLUG` (default `'ever-works'`),
      `GITHUB_APP_SETUP_URL`/`GITHUB_APP_CALLBACK_URL` (with
      `webAppUrl` defaults).

## Phase 2 — Auth + GitHub HTTP layer (shipped)

- [x] **T3**. `GitHubAppService` at
      [`apps/api/src/integrations/github-app/github-app.service.ts`](../../../../apps/api/src/integrations/github-app/github-app.service.ts)
    - `getConfiguration` — five-field tuple.
    - `getUserAuthorizationUrl(state)` — full URL builder.
    - `exchangeUserCode(code)` — POST `/login/oauth/access_token`,
      throws `UnauthorizedException` on `data.error`,
      `BadRequestException` when no token returned.
    - `getAuthenticatedGithubUser(accessToken)` — GET `/user` +
      email-fallback via `resolveGitHubAccountEmail`, normalised
      output shape.
    - `getInstallation(installationId)` — GET
      `/app/installations/:id` with app JWT.
    - `createInstallationAccessToken(installationId)` — proxy to
      `requestGitHubAppInstallationAccessToken` (agent helper).
    - `listInstallationRepositories(installationId)` —
      pagination loop (per_page=100, break on short page or
      total_count met).
    - `verifyWebhookSignature(rawBody, signature?)` — short-circuits
      to `false` when secret unset.
    - `getAppJwt` / `getCredentials` — private helpers; throws
      hard Error when credentials missing.

## Phase 3 — User + installation onboarding (shipped)

- [x] **T4**. `GitHubAppOnboardingService` at
      [`apps/api/src/integrations/github-app/github-app-onboarding.service.ts`](../../../../apps/api/src/integrations/github-app/github-app-onboarding.service.ts)
    - `beginSetup` — first `getInstallation`, then
      `upsertFromGithub`, then HMAC-sign 10-minute state payload,
      then return `getUserAuthorizationUrl(state)` envelope.
    - `completeUserAuth` — verifyState → exchangeUserCode →
      getAuthenticatedGithubUser → findOrCreateLocalUser →
      upsertProviderAccount → upsertLink (user-link table) →
      re-getInstallation → re-upsertFromGithub →
      claimOwnershipIfUnassigned → throw if claim returns null.
    - `findOrCreateLocalUser` — four-step chain (user-link →
      auth-account → email lookup with verified-email gate →
      create), with username uniqueness via
      `resolveUniqueUsername` and synthetic noreply email when no
      verified address available.
    - `signState` / `verifyState` — base64url-encoded payload +
      HMAC-SHA-256 signature + 10-minute TTL + constant-time
      comparison via `timingSafeEqual` after a length guard.
    - `normalizeRedirectTo` — only strings starting with `/`
      survive.

## Phase 4 — Repo sync + onboarding handoff (shipped)

- [x] **T5**. `GitHubAppSyncService` at
      [`apps/api/src/integrations/github-app/github-app-sync.service.ts`](../../../../apps/api/src/integrations/github-app/github-app-sync.service.ts)
    - `listInstallationsForUser(userId)` — list rows + fan-out
      to `listForInstallation` via `Promise.all`.
    - `syncInstallation(installationId, userId?)` — short-circuit
      on missing/deleted/suspended/ownership-mismatch; otherwise
      mint installation token, list repos, replace per-installation
      repo list with `selected: true` on every row.
    - `onboardInstallationRepository(installationId, repositoryId, user)`
      — short-circuit branches; analyze repo with installation
      token; gate on `detectedType === 'data_repo'`; forward to
      `WorkImportService.onboardLinkedRepository` with
      `mode: 'github_app_installation'` auth payload.
    - `handleWebhook(eventName, payload)` — `installation` and
      `installation_repositories` only. Soft-delete on
      `installation.deleted`. Suspend / unsuspend handling via
      `suspendedAt`. Re-sync on `created` / `new_permissions_accepted`
      / `unsuspend`.

## Phase 5 — Controllers + webhook (shipped)

- [x] **T6**. `GitHubAppController` at
      [`apps/api/src/integrations/github-app/github-app.controller.ts`](../../../../apps/api/src/integrations/github-app/github-app.controller.ts)
    - `setup` (`@Public`) — query DTO, returns `{url}` envelope.
    - `callback` (`@Public`) — query DTO, returns
      `{...auth, installationId, redirectTo}` after issuing the
      session via `AuthProvider.issueSession`.
    - `listInstallations` — proxies to
      `gitHubAppSyncService.listInstallationsForUser(req.user.userId)`.
    - `syncInstallation` — proxies; `null` → 401 Unauthorized.
    - `onboardRepository` — `null` → 404; `{status:'error', message}`
      → 400.
- [x] **T7**. `GitHubAppWebhookController` at
      [`apps/api/src/integrations/github-app/github-app-webhook.controller.ts`](../../../../apps/api/src/integrations/github-app/github-app-webhook.controller.ts)
    - `handleWebhook` (`@Public`) — 400 on missing event header,
      400 on missing `req.rawBody`, 401 on signature mismatch.
    - Returns `{ ok: true }` on success.

## Phase 6 — DTOs (shipped)

- [x] **T8**. Query-string DTOs in
      [`dto/github-app.dto.ts`](../../../../apps/api/src/integrations/github-app/dto/github-app.dto.ts)
    - `GitHubAppSetupQueryDto`: `installation_id` required string,
      `setup_action` ∈ `{install, request}` if present,
      `redirectTo` optional string.
    - `GitHubAppCallbackQueryDto`: `code` required, `state`
      required.

## Phase 7 — Entities + repositories (shipped via agent package)

- [x] **T9**. `GitHubAppInstallation` entity at
      [`packages/agent/src/entities/github-app-installation.entity.ts`](../../../../packages/agent/src/entities/github-app-installation.entity.ts)
- [x] **T10**. `GitHubAppInstallationRepository` entity at
      [`packages/agent/src/entities/github-app-installation-repository.entity.ts`](../../../../packages/agent/src/entities/github-app-installation-repository.entity.ts)
- [x] **T11**. `GitHubAppUserLink` entity at
      [`packages/agent/src/entities/github-app-user-link.entity.ts`](../../../../packages/agent/src/entities/github-app-user-link.entity.ts)
- [x] **T12**. Repository classes for all three entities at
      [`packages/agent/src/database/repositories/`](../../../../packages/agent/src/database/repositories/)
    - `GitHubAppInstallationRepository.upsertFromGithub` w/
      unique-constraint retry,
      `claimOwnershipIfUnassigned` w/ `WHERE createdByUserId IS NULL`
      atomicity guarantee, `markSuspended` / `markDeleted`,
      `listByCreatedByUserId` / `findByInstallationId`.
    - `GitHubAppInstallationRepoRepository.replaceForInstallation`
      (atomic delete-then-insert) and `listForInstallation`.
    - `GitHubAppUserLinkRepository.findByGithubUserId` / `upsertLink`.

## Phase 8 — Tests (shipped)

- [x] **T13**. Service-level unit tests
    - `github-app.service.spec.ts` — JWT minting, OAuth code
      exchange, GitHub user resolution, installation token mint,
      pagination loop, webhook signature short-circuit, hard
      Error when credentials missing.
    - `github-app-onboarding.service.spec.ts` — state HMAC sign +
      verify (round-trip + tamper / TTL / payload-shape rejection),
      find-or-create chain (link → auth-account → email-with-verify-
      gate → create), uniqueness suffixing, claim-ownership
      negative branch surfacing as 400, redirectTo normalisation.
    - `github-app-sync.service.spec.ts` — soft-deleted /
      suspended / not-owned short-circuit on the three service
      methods; `replaceForInstallation` shape (selected: true,
      owner-fallback, full-name-fallback); webhook event handling
      (deleted / suspend / unsuspend / created / repo-list /
      missing-id / unsupported-event).
- [x] **T14**. Controller-level unit tests — 22 tests across
      `github-app.controller.spec.ts` (15) and
      `github-app-webhook.controller.spec.ts` (7). Mocks
      `@ever-works/agent/{database,entities,import,services}` plus
      the `@src/auth` barrel — see PR
      [#502](https://github.com/ever-works/ever-works/pull/502).

## Outstanding follow-ups

- [ ] **T15** (OQ-1) Promote `getCredentials` Error to a
      `ServiceUnavailableException` (or `InternalServerErrorException`
      with a structured body) so missing-credentials returns 503
      instead of an opaque 500.
- [ ] **T16** (OQ-2) Add a `GitHubAppSyncGuard` that short-circuits
      to 503 when any required env var is unset, mirroring
      `CrmSyncGuard`. Apply to `GitHubAppController` (the public
      `setup`/`callback` endpoints would still need to bypass the
      guard via `@Public` semantics).
- [ ] **T17** (OQ-3) Render the email-not-verified callback 401 as
      a friendlier setup-error page in `apps/web` rather than the
      raw 401 JSON.
- [ ] **T18** (OQ-4) Derive the synthetic noreply suffix from
      `webAppUrl()` (e.g. `@users.noreply.<host>`) rather than the
      hard-coded `@users.noreply.ever.works` so multi-deployment
      setups don't share an email namespace.
- [ ] **T19** (OQ-5) Decide on second-user-installs-same-app
      semantics: today, `claimOwnershipIfUnassigned` returns the
      existing row when `createdByUserId` is already set. Either
      return `Conflict` for the second user, OR teach the
      installation row to support multi-owner / per-org mapping.
- [ ] **T20** (OQ-6) Log unsupported webhook event names at
      `debug` so payload-shape changes (e.g. GitHub renaming
      events) are spottable in production logs.
- [ ] **T21** (OQ-7) Decide on activity-log emission for
      installation lifecycle events (`installation.created`,
      `installation.deleted`, `installation.suspended`,
      `installation.unsuspend`). Today nothing is emitted; an
      audit trail for org-level GitHub-App actions may be a
      compliance requirement.
- [ ] **T22** (OQ-8) Move the "data_repo only" message into a
      shared constant / i18n key. Today the message is hard-coded
      English at the service layer.
- [ ] **T23** (OQ-9) `replaceForInstallation` defaults
      `selected: true` for every repo; orgs with hundreds of
      repos see all of them in the platform UI. Preserve prior
      `selected: false` rows by reading the existing list before
      replacement.
- [ ] **T24** Add a Postgres-container integration test that
      exercises the three repositories end-to-end:
      `upsertFromGithub` → `claimOwnershipIfUnassigned` → atomicity
      under concurrent claims; `replaceForInstallation` atomicity
      under concurrent webhook deliveries; `markDeleted` ordering
      with `markSuspended`. Today only mocked unit tests cover
      these surfaces.
- [ ] **T25** Add an e2e test that posts crafted GitHub webhook
      payloads (with a real HMAC signature) to
      `/api/github-app/webhooks` and asserts the resulting DB
      state. Today only the controller's input-validation paths
      are unit-tested — the end-to-end webhook → repository
      pipeline is exercised only via the service-level mocks.
- [ ] **T26** Add a `github-app.module.spec.ts` Nest-module wiring
      test (the only remaining "module-level" gap in the folder
      per the row in `COVERAGE-TRACKER.md`). Defer until
      `apps/api` has a precedent for module-wiring tests; today
      `@nestjs/testing` is used at the controller/service level
      only.
- [ ] **T27** GitHub Enterprise Server support — add
      `GITHUB_APP_BASE_URL` and `GITHUB_APP_API_BASE_URL` env vars
      and thread them through every `firstValueFrom(httpService.*)`
      call in `GitHubAppService`.
- [ ] **T28** Bulk repo-onboarding — extend
      `onboardInstallationRepository` to accept an array (or add a
      sibling endpoint), and move the analyzer + onboarding work
      into a Trigger.dev queue per `Plan §10`.
- [ ] **T29** Allow non-`data_repo` types — coordinate with
      `WorkImportService.onboardLinkedRepository` so website / agent
      / pipeline repos can be onboarded from the GitHub App surface
      directly. Currently those require manual Work creation.
- [ ] **T30** Update `apps/api`'s OpenAPI documentation to include
      the GitHub-App endpoints. Today the OpenAPI generator picks
      them up automatically via the controller decorators, but the
      `setup` and `callback` routes are `@Public()` and the Swagger
      tags + descriptions could be tightened (e.g. clarifying that
      `setup` returns a JSON envelope, not a redirect).

## References

- [Spec](./spec.md), [Plan](./plan.md)
- Source: `apps/api/src/integrations/github-app/`
- Tests: 22 controller + 3 service unit suites — see PR
  [#502](https://github.com/ever-works/ever-works/pull/502).
- External: see `spec.md` §10.
