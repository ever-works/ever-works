# Task Breakdown: Onboarding Wizard v2

> Ordered, granular tasks derived from [`plan.md`](./plan.md). Each task is small enough
> to land in a single commit (and ideally tested) per Constitution Principle VI.

**Feature ID**: `onboarding-wizard-v2`
**Plan**: [`./plan.md`](./plan.md)
**Status**: `Draft`
**Last updated**: 2026-05-11

---

## How to use

- Phases are sequential. Within a phase, tasks marked `(parallel)` can run alongside their predecessor.
- Each task names explicit file paths so an implementer can pick it up cold.
- Use the checkbox to track progress as commits/PRs land.
- Add new tasks at the bottom rather than renumbering.

## Phase 1 — Plugin scaffolding (commit: `chore(plugins)`)

- [ ] **T1**. Scaffold `packages/plugins/grok/` by copying `packages/plugins/groq/` and adjusting `package.json` metadata (`id: 'grok'`, name "Grok (xAI)", `uiHints.includeInOnboarding: true`, `onboardingPriority: 3`, brand icon).
- [ ] **T2**. Implement `packages/plugins/grok/src/grok.plugin.ts` extending `BaseAiProvider` with `providerType: 'openai'`, `baseURL: 'https://api.x.ai/v1/'`, settings schema (`apiKey` `x-secret`, `defaultModel: 'grok-2-latest'`, tiered models, `temperature`, `maxTokens`), `getCapabilities()`, `validateConnection()` and an xAI-flavoured readme.
- [ ] **T3**. Vitest spec at `packages/plugins/grok/src/__tests__/grok.plugin.spec.ts` covering manifest shape, schema, connection validation happy + sad path with mocked `fetch`.
- [ ] **T4**. Register `grok` in the plugin loader / build pipeline (anywhere `groq` is referenced as a built-in).
- [ ] **T5**. Add `apiKey` to `packages/plugins/gemini/src/gemini.plugin.ts` (`x-secret`, `x-envVar: GEMINI_API_KEY`, `x-scope: 'user'`). Update existing Vitest spec to assert presence and to assert CLI-mode still works when `apiKey` is empty.
- [ ] **T6**. Flip `packages/plugins/k8s/package.json` `everworks.plugin.uiHints.includeInOnboarding` from `false` to `true`; add `onboardingPriority: 4` and `onboardingDescription`. Confirm the existing k8s test suite still passes.
- [ ] **T7**. Copy tweak in `claude-code` config wizard (`packages/plugins/claude-code/...`) clarifying "Use OAuth token for Claude Pro/Max subscription (no per-token cost); otherwise paste an Anthropic API key."
- [ ] **T8**. Lint + type-check the four touched plugin packages; commit as `chore(plugins): add grok, gemini api key, k8s onboarding, claude-code copy`.

## Phase 2 — Agent provider work (commit: `feat(agent)`)

### Data model

- [ ] **T9**. Add `storageProvider` and `deployProvider` columns to the `Work` entity in `packages/agent/src/entities/work.entity.ts`. Defaults `'user-github'` / `'vercel'`. Update entity tests in `packages/agent/src/entities/__tests__/`.
- [ ] **T10**. Hand-written TypeORM migration at `apps/api/src/migrations/{nextTs}-AddWorkStorageAndDeployProvider.ts` adding both columns plus the partial index `idx_works_user_deploy_active`.
- [ ] **T11**. Update `packages/agent/src/dto/create-work.dto.ts` + any other Work DTOs to optionally accept `storageProvider` / `deployProvider`. Validate enums.

### Ever Works Git provider

- [ ] **T12**. Env config: extend `apps/api/src/config/` with `STORAGE_EVER_WORKS_GIT_ENABLED`, `EVER_WORKS_CUSTOMERS_GITHUB_ORG` (default `'ever-works-cloud'`), `EVER_WORKS_CUSTOMERS_GITHUB_PAT`, `EVER_WORKS_CUSTOMERS_GITHUB_VISIBILITY`. Document each in `.env.example`.
- [ ] **T13**. New `EverWorksGitProvider` at `packages/agent/src/git/ever-works-git.provider.ts` implementing the `GitProvider` shape:
    - `createRepository(work)` → Octokit `POST /orgs/{org}/repos`.
    - `push(work, content)` and `delete(work)` (soft).
    - Each call wraps `ActivityLogService.record({ actorKind: 'platform', userId, action, resource })`.
- [ ] **T14**. Branch in `packages/agent/src/facades/git.facade.ts` `createRepository()`: switch on `work.storageProvider`. Existing `user-github` path stays the default.
- [ ] **T15**. Reject `storageProvider = 'ever-works-git'` with typed `storage_provider_disabled` error in `WorksService` when the env flag is off.
- [ ] **T16**. Jest tests in `packages/agent/src/git/__tests__/ever-works-git.provider.spec.ts` mocking Octokit: happy path, collision retry with `-{shortId}`, PAT-missing failure, activity-log written.

### Ever Works Deploy provider

- [ ] **T17**. Env config: `DEPLOY_EVER_WORKS_ENABLED`, `EVER_WORKS_DEPLOY_KUBECONFIG` / `_PATH`, `EVER_WORKS_DEPLOY_NAMESPACE`, `EVER_WORKS_DEPLOY_INGRESS_HOST_TEMPLATE`, `EVER_WORKS_DEPLOY_INGRESS_CLASS`, `EVER_WORKS_DEPLOY_TLS_ISSUER`, `EVER_WORKS_DEPLOY_REGISTRY`, `EVER_WORKS_DEPLOY_MAX_WORKS_PER_USER` (default `3`). Documented in `.env.example`.
- [ ] **T18**. New `EverWorksK8sDeployProvider` at `packages/agent/src/deployment/ever-works-k8s.provider.ts`:
    - `getDeployConfig(user)` builds a `k8s` plugin config from env vars (substitute `{slug}` in ingress host template).
    - `ensureNamespace(user)` — idempotent.
    - `deploy(work)` — calls the existing k8s plugin deploy primitive.
- [ ] **T19**. Quota service: `checkQuota(userId)` queries `works` filtered by user + provider + active status. Throws typed `QuotaExceededError`. Wired into `WorksService.create` and any redeploy path.
- [ ] **T20**. Branch in deployment façade (the existing `apps/api/src/plugins-capabilities/deploy/...` or equivalent): when `work.deployProvider === 'ever-works'`, route through `EverWorksK8sDeployProvider`; otherwise unchanged.
- [ ] **T21**. Jest tests in `packages/agent/src/deployment/__tests__/ever-works-k8s.provider.spec.ts`: env-derived config, namespace creation idempotency, quota under/over scenarios, env-flag-off rejection.

### WorksService glue

- [ ] **T22**. In `WorksService.create` (and wherever defaults flow), read `users.onboarding_state` and seed `work.storageProvider` / `work.deployProvider` from the user's choices, falling back to entity defaults.
- [ ] **T23**. Run quota check before creating a Work with `deployProvider = 'ever-works'`. Surface as `429 quota_exceeded` to the controller.

### Commit

- [ ] **T24**. `pnpm test` in `packages/agent` + `apps/api` (the touched modules). Commit as `feat(agent): ever-works-git + ever-works-k8s providers, work provider columns, quota`.

## Phase 3 — Onboarding API + user state (commit: `feat(api)`)

- [ ] **T25**. Add `onboardingCompletedAt`, `onboardingDismissedAt`, `onboardingState` columns to `packages/agent/src/entities/user.entity.ts`. Defaults `NULL`. Update user entity tests.
- [ ] **T26**. Hand-written migration at `apps/api/src/migrations/{nextTs+1}-AddUserOnboardingState.ts` adding the three columns. Forward-only, additive.
- [ ] **T27**. Zod schema for `onboarding_state` payload at `packages/contracts/src/api/onboarding/state.ts` (version, choices, lastStep, skippedSteps, pluginsReviewed). Re-export from the API barrel.
- [ ] **T28**. `OnboardingStateController` at `apps/api/src/onboarding/onboarding-state.controller.ts` exposing:
    - `GET /api/onboarding/state` — returns row, normalised to v2 shape.
    - `PATCH /api/onboarding/state` — partial update, class-validator + Zod, validates enum membership.
    - `POST /api/onboarding/complete` — sets `onboardingCompletedAt = now()`.
    - `POST /api/onboarding/dismiss` — sets `onboardingDismissedAt = now()`.
- [ ] **T29**. `OnboardingStateService` at `apps/api/src/onboarding/onboarding-state.service.ts` with the corresponding repository methods.
- [ ] **T30**. `OnboardingCatalogController` at `apps/api/src/onboarding/onboarding-catalog.controller.ts` with `GET /api/onboarding/catalog`. Service reads env flags and the plugin manifests to produce the AI / Storage / Deploy / Plugins lists.
- [ ] **T31**. Auto-complete hook: when `WorksService.create` succeeds AND all chosen vendors have credentials, call `OnboardingStateService.markCompletedIfReady(userId)`.
- [ ] **T32**. Jest controller + service specs at `apps/api/src/onboarding/__tests__/onboarding-state.controller.spec.ts` and `.service.spec.ts`. Cover auth, validation, idempotency, env-flag-off catalog filtering, auto-complete trigger.
- [ ] **T33**. Wire `OnboardingModule` into `apps/api/src/api.module.ts`.
- [ ] **T34**. `pnpm test` in `apps/api`. Commit as `feat(api): onboarding state + catalog endpoints, user columns`.

## Phase 4 — Web wizard (commit: `feat(web)`)

### Hook + state sync

- [ ] **T35**. `apps/web/src/components/onboarding/useOnboardingFlow.ts` — `useReducer` step machine. Inputs: server state + catalog. Outputs: `step`, `canGoBack`, `canSkip`, `goNext / goBack / skip / refresh`, and a sync side-effect that PATCHes the server on every transition (debounced 300 ms).
- [ ] **T36**. Refactor `apps/web/src/components/onboarding/use-onboarding-state.ts` to thin SWR-style hook over `/api/onboarding/state`. Keep localStorage only as offline-cache.

### Reusable components

- [ ] **T37**. `ChoiceCard.tsx` and `ChoiceCardGrid.tsx` at `apps/web/src/components/onboarding/`. Props: logo, title, description, badges (Default / BYOK / Planned), `disabled`, `selected`, `onSelect`.
- [ ] **T38**. `PluginsCatalogGrid.tsx` + inline-expand behaviour, embedding existing `OnboardingPluginStep`.
- [ ] **T39**. `WizardFooter.tsx` with Back / Skip / Refresh / Next, hidden/disabled per props.

### Steps

- [ ] **T40**. `WelcomeStep.tsx` — extracted from the existing welcome JSX in `EverWorksOnboardingWizard.tsx`.
- [ ] **T41**. `AIChoiceStep.tsx` — six cards from the AI catalog: ever-works (default), openrouter, claude-code, codex, gemini, grok.
- [ ] **T42**. `AIConfigStep.tsx` — when `choice !== 'ever-works'`, renders the chosen plugin's existing `OnboardingPluginStep`.
- [ ] **T43**. `StorageChoiceStep.tsx` — four cards: ever-works-git (default, Planned-when-disabled), user-github, user-gitlab (Planned), user-git (Planned).
- [ ] **T44**. `StorageConfigStep.tsx` — when `choice === 'user-github'`, render the existing GitHub OAuth/Connect flow; otherwise auto-skip.
- [ ] **T45**. `DeployChoiceStep.tsx` — three cards: ever-works (default, Planned-when-disabled), vercel, k8s.
- [ ] **T46**. `DeployConfigStep.tsx` — when `choice === 'vercel'` or `choice === 'k8s'`, render the chosen plugin's `OnboardingPluginStep`; otherwise auto-skip.
- [ ] **T47**. `PluginsCatalogStep.tsx` — renders cards for `make`, `sim-ai`, `zapier`, `activepieces` (driven by the catalog endpoint). "Skip — set up later" primary button. Inline expand per card.
- [ ] **T48**. `CreateWorkStep.tsx` — extracted from the existing work-step JSX.

### Driver + integration

- [ ] **T49**. Rewrite `apps/web/src/components/onboarding/EverWorksOnboardingWizard.tsx` to drive the new step machine; keep the dialog chrome, progress bar, and sidebar.
- [ ] **T50**. `apps/web/src/app/[locale]/(dashboard)/layout.tsx` — server-side fetch `/api/onboarding/state` and `/api/onboarding/catalog`; pass into client.
- [ ] **T51**. Update `apps/web/src/app/[locale]/(dashboard)/layout-client.tsx` to consume the new props and render the rewritten wizard.

### Telemetry

- [ ] **T52**. `apps/web/src/app/actions/onboarding/track.ts` — `'use server'` action calling `AnalyticsService.track`. Validate event name against a whitelist.
- [ ] **T53**. Wire events listed in `plan.md` §8 inside the wizard hook + footer + cards.

### Static assets

- [ ] **T54**. Vendor SVG logos under `apps/web/public/logos/{openrouter,anthropic,xai,google,vercel,github,gitlab,kubernetes,everworks}.svg`. Note licence / source comment per file.

### Tests

- [ ] **T55**. Vitest unit tests for `useOnboardingFlow` covering every (ai, storage, deploy) combo + skip + back + refresh + planned-card click.
- [ ] **T56**. Playwright e2e at `apps/web/e2e/onboarding-wizard-v2.spec.ts`:
    - Full-defaults happy path → create Work.
    - OpenRouter BYOK path → create Work with `ai.choice = 'openrouter'`.
    - Claude Code subscription path → uses `oauthToken`.
    - Back / Skip / Refresh on a config step.
    - Reopen after clearing cookies restores server state.
    - Quota-block: with `EVER_WORKS_DEPLOY_MAX_WORKS_PER_USER=1` and one existing Work, creating a second ever-works-deploy Work shows the quota error.

### Commit + PR

- [ ] **T57**. `pnpm lint`, `pnpm type-check`, web build clean. Commit as `feat(web): onboarding wizard v2 with choice-driven flow, plugins catalog, telemetry`.
- [ ] **T58**. Open PR `feat/ew-onboarding-wizard-v2` → `develop`. Body links this spec; tracks Jira ticket `[EW-XXX]` (added by owner when ticket is created).
- [ ] **T59**. Follow develop → stage → main after CI green, per release-flow memory.

## Phase 5 — Post-merge follow-ups

The original "deferred" set landed in the same PR after the user pulled
them forward (apps/web Vitest runner, Playwright wizard spec, brand SVGs,
`WorksService.create` wire-up). Items still requiring ops action are
documented in [`./deployment.md`](./deployment.md):

- [ ] **T60**. Create the `ever-works-cloud` GitHub PAT (manual web-UI
  step — GitHub disallows API creation; see deployment.md §1.3); store
  in k8s + GH-Actions secrets; flip `STORAGE_EVER_WORKS_GIT_ENABLED=true`.
- [ ] **T61**. Push the `do-sfo2-k8s-ever` kubeconfig into the API
  deployment secret as `EVER_WORKS_DEPLOY_KUBECONFIG`; flip
  `DEPLOY_EVER_WORKS_ENABLED=true` (see deployment.md §2).
- [ ] **T62**. Admin override for the 3-Work cap (lifts the limit for a
  specific user — useful for internal Ever Works staff demoing the flow).
- [ ] **T63**. Cost reporting / per-user usage panel for Ever Works Deploy.
- [ ] **T64**. Migrate `EverWorksGitProvider` to the GitHub App
  installation-token path so we don't rely on a long-lived PAT (the App
  is already installed for user GitHub flows).
