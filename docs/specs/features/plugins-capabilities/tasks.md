# Task Breakdown: Plugins Capabilities (HTTP Surface)

**Feature ID**: `plugins-capabilities`
**Plan**: `./plan.md`
**Status**: `Done` (retrospective; surface already shipped on `develop`)
**Last updated**: 2026-05-08

---

## How to use

This is a retrospective task list — every numbered task already shipped on
`develop`. Outstanding follow-ups (T16 onward) are not blockers for the
spec backfill but are good candidates for a future hourly-tracker run.

## Phase 1 — Module scaffolding

- [x] **T1**. `DeployModule` at `apps/api/src/plugins-capabilities/deploy/deploy.module.ts`
    - Imports: `FacadesModule`, `DatabaseModule`, `WebsiteGeneratorModule`,
      `WorkModule`, `ActivityLogModule`, `forwardRef(() => AuthModule)`
    - Providers: `DeployService`, `DeploymentVerifierService`
    - Exports: `DeployService`, `DeploymentVerifierService`
- [x] **T2**. `SearchModule` at `apps/api/src/plugins-capabilities/search/search.module.ts`
- [x] **T3**. `ScreenshotModule` at `apps/api/src/plugins-capabilities/screenshot/screenshot.module.ts`
- [x] **T4**. `OAuthModule` at `apps/api/src/plugins-capabilities/oauth/oauth.module.ts`
- [x] **T5**. `GitProviderModule` at `apps/api/src/plugins-capabilities/git-provider/git-provider.module.ts`
- [x] **T6**. `DeviceAuthModule` at `apps/api/src/plugins-capabilities/device-auth/device-auth.module.ts`
- [x] **T7**. Mount all six modules in `apps/api/src/api.module.ts`
      (lines 18-24 imports + 64-71 module list).

## Phase 2 — Controllers

- [x] **T8**. `DeployController` covering 13 endpoints (providers/configured,
      works/:id deploy + check + lookup + teams + domains GET/POST/DELETE +
      verify, batch, validate-token, /teams placeholder).
    - Owner gate: `WorkOwnershipService.ensureCanEdit` / `.ensureCanView`
      on every `:id`-scoped endpoint.
    - Activity-log emission: `work.deployed` (single deploy) + `deployment.batch_started`
      (batch) — both fire-and-forget with `.catch(() => {})`.
    - Domain regex validation on `AddDomainDto`.
- [x] **T9**. `SearchController` covering 2 endpoints (`/check-availability`,
      `/`).
    - Per-call provider resolution via private `resolveConfiguredProvider`
      helper (no per-call `providerOverride` from the DTO — see OQ-4).
    - Two distinct unconfigured-vs-not-enabled messages on
      `/check-availability`.
    - `NoProviderError` re-mapped; non-Error throws coerce to `"Search failed"`.
- [x] **T10**. `ScreenshotController` covering 3 endpoints (`/check-availability`,
      `/capture`, `/get-url`).
    - Three-tier sort (default → configured → name) on the provider list.
    - `cacheUrl` preferred over `imageUrl` in the response.
    - `imageBuffer.toString('base64')` only when present; else `null`.
- [x] **T11**. `OAuthController` covering 6 endpoints (providers list,
      connection, connect/url, callback/plugins, user, DELETE disconnect).
    - Strict-`'true'` parse on `forceConsent`.
    - Missing-code `BadRequest` BEFORE service call.
    - 200-envelope-with-error on `getUser` / `disconnect`.
- [x] **T12**. `GitProviderController` covering 5 endpoints (providers list,
      connection, organizations, repositories, user).
    - `parseInt(_, 10)` on `page`/`perPage`, each independently
      undefined-able.
    - Two-branch auth resolution (OAuth vs PAT) with shape-discriminated
      `getUser` calls.
- [x] **T13**. `DeviceAuthController` covering 2 endpoints (`/status`,
      `/start`).
    - Two-line passthroughs to `DeviceAuthService`; errors propagate
      unwrapped.

## Phase 3 — Services

- [x] **T14**. `DeployService.deploy(workId, userId, options)` —
      orchestrates the dispatch chain (resolve plugin + token + settings
      → fetch git token → ensure repo context → enable workflows → set
      required + optional + cron secrets → call plugin
      `getDeploymentSecrets` → dispatch with retry → emit
      `DeploymentDispatchedEvent`).
- [x] **T15**. `DeployService.deployBatch` — rolling batches of 5 with
      2 000 ms sleep between batches.
- [x] **T16**. `DeploymentVerifierService.startVerification` — replaces
      any existing poller for the work, then registers a fresh
      `setInterval(10s)` loop (max 18 cycles + 13 min wall-clock cap).
- [x] **T17**. `DeploymentVerifierService.lookupExistingDeployment` —
      one-shot lookup helper used by `POST /api/deploy/works/:id/lookup`.
- [x] **T18**. `OAuthService` — six methods (isConfigured, available
      providers, connection check, OAuth URL builder, callback handler,
      disconnect).
- [x] **T19**. `GitProviderService` — five methods (isConfigured,
      available providers, connection check, get user/organizations/
      repositories).
- [x] **T20**. `DeviceAuthService` — two passthrough methods.

## Phase 4 — Plugin contract evolution

- [x] **T21**. Add optional `IDeploymentPlugin.getWorkflowFilenames()`
      to `packages/plugin/src/deployment/`.
- [x] **T22**. Add optional `IDeploymentPlugin.getDeploymentSecrets(settings)`
      to `packages/plugin/src/deployment/`.
- [x] **T23**. Implement `getWorkflowFilenames` in `packages/plugins/vercel/`
      to return `['deploy_vercel.yaml', 'deploy_prod.yaml']`.

## Phase 5 — Event-driven activity-log

- [x] **T24**. Define `DeploymentDispatchedEvent` /
      `DeploymentCompletedEvent` / `DeploymentFailedEvent` in
      `packages/agent/src/events/`.
- [x] **T25**. Register the three event types in `ActivityLogListener`
      (consumer-side spec lives in [`activity-log`](../activity-log/spec.md)).

## Phase 6 — Tests (per [`COVERAGE-TRACKER.md`](../../../../COVERAGE-TRACKER.md))

- [x] **T26**. `device-auth/device-auth.service.spec.ts` (6 tests) +
      `device-auth/device-auth.controller.spec.ts` (4 tests) — PR
      [#518](https://github.com/ever-works/ever-works/pull/518).
- [x] **T27**. `git-provider/git-provider.service.spec.ts` (15 tests) +
      `git-provider/git-provider.controller.spec.ts` (9 tests) — PR
      [#518](https://github.com/ever-works/ever-works/pull/518).
- [x] **T28**. `oauth/oauth.service.spec.ts` (29 tests) +
      `oauth/oauth.controller.spec.ts` (22 tests) — PR
      [#518](https://github.com/ever-works/ever-works/pull/518).
- [x] **T29**. `search/search.controller.spec.ts` (17 tests) — PR
      [#520](https://github.com/ever-works/ever-works/pull/520).
- [x] **T30**. `screenshot/screenshot.controller.spec.ts` (24 tests) — PR
      [#520](https://github.com/ever-works/ever-works/pull/520).
- [x] **T31**. `deploy/deploy.service.spec.ts` (6 suites) — covers
      capability contracts (`getWorkflowFilenames`, `getDeploymentSecrets`),
      event emission, error handling, fallbacks for legacy plugins.

## Phase 7 — Docs & rollout

- [x] **T32**. Author this Spec Kit feature folder (`docs/specs/features/plugins-capabilities/`).
- [x] **T33**. Cross-link from `COVERAGE-TRACKER.md` "Pending — Medium
      Priority" → "Done".
- [ ] **T34**. User-facing API doc under `docs/api/plugins-capabilities/`
      with one page per capability (deploy, search, screenshot, oauth,
      git-provider, device-auth) — see follow-up T-DOCS-1.

## Outstanding follow-ups

- [ ] **T-DEPLOY-CTRL**. Author `apps/api/src/plugins-capabilities/deploy/deploy.controller.spec.ts`
      covering all 13 endpoints. Today only the service has unit
      coverage (6 suites). Pin: `ensureCanEdit` runs BEFORE `isConfigured`
      runs BEFORE `validateToken` runs BEFORE `deploy` runs BEFORE
      `startVerification` runs BEFORE the activity-log emission;
      `validateToken` rejection short-circuits with NO log; the
      activity-log emission is fire-and-forget (`.catch(() => {})`) and
      does not block the response.

- [ ] **T-OQ-1**. Decide the fate of `POST /api/deploy/teams` (the
      workless variant). It currently returns `{teams: [], message: 'To
fetch teams, use the work-specific endpoint or configure your
token in Plugin Settings.'}` — pure placeholder. Either remove it
      (breaking change for the UI's empty-state hint) or rename to
      `/api/deploy/teams/hint` to clarify intent.

- [ ] **T-OQ-2**. Unify the error-envelope shape across all six
      capabilities. Today: deploy/search/screenshot throw
      `BadRequestException` (4xx); OAuth/git-provider/device-auth wrap
      into `{success: false, error}` inside 200. Either flip the
      latter group to throw 4xx (breaking change for UI clients that
      consume the 200 envelope) or document the asymmetry as
      intentional.

- [ ] **T-OQ-3**. Migrate `DeploymentVerifierService` from in-memory
      `setInterval` to a Trigger.dev task so verification survives API
      restarts. The current behaviour is documented in §Plan §11
      (Risks): a redeploy mid-verification silently abandons the
      poller; users can re-resolve via `POST
/api/deploy/works/:id/lookup`. Trigger.dev migration would land
      under `packages/tasks/src/tasks/trigger/deploy-verification.task.ts`
      with idempotent CAS updates on `work.deploymentState`.

- [ ] **T-OQ-4**. Expose `providerOverride` from `SearchDto` so callers
      can pick a specific search plugin per request (mirroring the
      `screenshot/capture` shape). Today, `SearchController` always
      resolves "the first configured plugin sorted by
      `defaultForCapabilities`-first".

- [ ] **T-OQ-5**. Decide whether to emit a `'work.deployment_token_invalid'`
      activity-log entry on `validateToken` rejection so users can see
      failed-credentials attempts in their audit trail. Today the
      controller short-circuits silently with a `BadRequest`.

- [ ] **T-OQ-6**. Add a per-controller `@Throttle` decorator stack so
      bulk endpoints (`POST /api/deploy/batch`, `POST
/api/screenshot/capture`) cannot be hammered. Today they inherit
      the global throttler config only.

- [ ] **T-DOCS-1**. Author `docs/api/plugins-capabilities/{deploy,search,
screenshot,oauth,git-providers,device-auth}.md` with one Markdown
      page per capability listing endpoints, request/response shapes,
      and example curl invocations.

- [ ] **T-DOCS-2**. Add an architecture diagram to
      `docs/architecture/plugins-capabilities.md` showing the
      controller → facade → registry → plugin call chain (similar to
      §Plan §1 but rendered as a static SVG).

- [ ] **T-E2E-1**. Add an e2e test under `apps/api/test/plugins-capabilities/`
      that exercises the deploy + search + screenshot happy paths with
      a stubbed plugin registry.

- [ ] **T-E2E-2**. Add a kind-cluster CI scenario that exercises the
      full deploy chain (controller → service → verifier → terminal
      event → activity-log row) with a real GitHub Actions dispatch
      against a throwaway repo.

## Definition of Done

- [x] All checkboxes T1–T33 ticked.
- [x] All shipped tests passing on `develop`.
- [x] Spec status set to `Implemented`; plan + tasks marked `Done`.
- [ ] T34 + outstanding follow-ups tracked as separate hourly-tracker
      candidates in [`COVERAGE-TRACKER.md`](../../../../COVERAGE-TRACKER.md).
