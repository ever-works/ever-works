# Implementation Plan: Onboarding Wizard v2

> Translates the approved [`spec.md`](./spec.md) into an architecture and tech-choice plan.
> The plan owns implementation details; the spec owns behaviour.

**Feature ID**: `onboarding-wizard-v2`
**Spec**: [`./spec.md`](./spec.md)
**Tasks**: [`./tasks.md`](./tasks.md)
**Status**: `Draft`
**Last updated**: 2026-05-11

---

## 1. Architecture summary

```mermaid
flowchart TB
    User[Dashboard mount] --> Layout[apps/web (dashboard) layout.tsx]
    Layout -->|RSC fetch| StateAPI[GET /api/onboarding/state]
    Layout -->|RSC fetch| CatalogAPI[GET /api/onboarding/catalog]
    Layout --> Wizard[EverWorksOnboardingWizard v2]

    Wizard --> Flow[useOnboardingFlow hook]
    Flow -->|PATCH| StateAPI
    Flow -->|server action| Track[trackOnboardingEvent → AnalyticsService]
    Flow --> Reuse[Existing OnboardingPluginStep + PluginOnboardingWizard]

    Reuse --> Plugins[(packages/plugins/*)]

    WorkCreate[WorksService.create] -->|reads choices| State[(users.onboarding_state)]
    WorkCreate -->|writes| WorksRow[(works.storage_provider,<br/>works.deploy_provider)]

    WorksRow -->|storage=ever-works-git| EWGit[EverWorksGitProvider<br/>(platform PAT → ever-works-cloud org)]
    WorksRow -->|deploy=ever-works| EWDeploy[EverWorksK8sDeployProvider<br/>(env kubeconfig → tenant namespace)]
    WorksRow -->|other choices| ExistingPath[existing git/deploy facades]
```

**Reuses without change**:

- `OnboardingPluginStep` and `PluginOnboardingWizard` components — wrapped, not replaced.
- All AI provider plugins (`openrouter`, `claude-code` with its dual `oauthToken`+`apiKey`, `codex`, `gemini` after FR-27 extension).
- `github` plugin OAuth + GitHub App flows.
- `vercel` plugin.
- `k8s` plugin's settings schema and validation.
- `@ever-works/monitoring` `AnalyticsService` (server-side PostHog).
- `GitFacade.createRepository` interface — we add a new branch, not a new façade.

**Net-new**:

- `apps/api/src/onboarding/` controller, service, DTOs for state + catalog endpoints.
- `users.onboarding_completed_at` / `onboarding_dismissed_at` / `onboarding_state` columns.
- `works.storage_provider` / `works.deploy_provider` columns.
- `packages/agent/src/git/ever-works-git.provider.ts` + `EverWorksGitProvider` service.
- `packages/agent/src/deployment/ever-works-k8s.provider.ts` + `EverWorksK8sDeployProvider` service.
- `packages/plugins/grok/` package.
- `apiKey` setting on the existing `gemini` plugin.
- Web: rewritten `EverWorksOnboardingWizard.tsx` driven by `useOnboardingFlow`, plus choice-card + plugins-catalog primitives.
- Server action `trackOnboardingEvent` in `apps/web/src/app/actions/onboarding/track.ts`.

## 2. Tech choices

| Concern | Choice | Rationale |
|---|---|---|
| State persistence | TypeORM columns on `users`; jsonb for `onboarding_state` | Matches existing user-scoped flag pattern; jsonb avoids a side table |
| State API | New `apps/api/src/onboarding/` Nest module with `OnboardingStateController` | Follows existing per-feature module structure |
| Catalog API | Same controller, `GET /api/onboarding/catalog` reads env-flag status server-side | Server is authoritative on which Ever Works defaults are enabled |
| Wizard state hook | Custom `useOnboardingFlow` using `useReducer` + SWR for state sync | Avoids adding a new dep; SWR already in apps/web for similar patterns |
| Telemetry | Server action calling `@ever-works/monitoring` `AnalyticsService.track` | Reuses server-side PostHog client; no `posthog-js` bundle growth |
| Ever Works Git auth | Octokit with PAT from `EVER_WORKS_CUSTOMERS_GITHUB_PAT` env var | Same library the github plugin already uses |
| Ever Works Deploy auth | Build a `k8s` plugin config object at call time from env vars; pass to existing k8s deploy primitives | Reuses validated k8s plugin code; no kubeconfig persisted per user |
| Quota check | Indexed `COUNT(*)` on `works` where `user_id = ?` AND `deploy_provider = 'ever-works'` AND `status NOT IN ('deleted','archived')` | One round-trip; explicit non-negotiable index on (user_id, deploy_provider) |
| Grok integration | LangChain `@langchain/openai` with `baseURL: https://api.x.ai/v1/` | xAI is OpenAI-API-compatible; matches how `groq` plugin works |
| Gemini API key surfacing | Add optional `apiKey` field to existing plugin schema; CLI path unchanged when empty | Minimum-diff; matches FR-27 expectation |
| Logos | Vendor official SVG marks under `apps/web/public/logos/` (Apache/CC0 sources) | Static, predictable, no third-party fetch |
| Tests (agent) | Jest, mocking Octokit + k8s plugin entrypoints | Matches existing pattern in `packages/agent/src/__tests__/` |
| Tests (web) | Vitest for hook unit tests; Playwright for the end-to-end happy path | Matches existing split between web unit and e2e tests |

## 3. Data model

### 3.1 `users` columns (one migration)

```sql
ALTER TABLE users
  ADD COLUMN onboarding_completed_at  timestamptz NULL,
  ADD COLUMN onboarding_dismissed_at  timestamptz NULL,
  ADD COLUMN onboarding_state         jsonb       NULL;
```

`onboarding_state` payload shape:

```ts
{
  version: 2,
  lastStep: number,
  ai:      { choice: 'ever-works' | 'openrouter' | 'claude-code' | 'codex' | 'gemini' | 'grok' },
  storage: { choice: 'ever-works-git' | 'user-github' | 'user-gitlab' | 'user-git' },
  deploy:  { choice: 'ever-works' | 'vercel' | 'k8s' },
  skippedSteps: string[],
  pluginsReviewed: boolean
}
```

### 3.2 `works` columns (same migration or paired)

```sql
ALTER TABLE works
  ADD COLUMN storage_provider varchar(32) NOT NULL DEFAULT 'user-github',
  ADD COLUMN deploy_provider  varchar(32) NOT NULL DEFAULT 'vercel';

CREATE INDEX idx_works_user_deploy_active
  ON works (user_id, deploy_provider)
  WHERE status NOT IN ('deleted','archived');
```

Defaults are conservative ("Your GitHub" / "Vercel") so any pre-existing rows
behave exactly like today's hard-coded path. New rows pick up the user's
onboarding choice via `WorksService.create`.

## 4. New env vars

All registered via `@nestjs/config` with class-validator schema in
`apps/api/src/config/`. Documented in `.env.example`.

```env
# Storage — Ever Works Git
STORAGE_EVER_WORKS_GIT_ENABLED=false
EVER_WORKS_CUSTOMERS_GITHUB_ORG=ever-works-cloud
EVER_WORKS_CUSTOMERS_GITHUB_PAT=
EVER_WORKS_CUSTOMERS_GITHUB_VISIBILITY=private   # private | public

# Deploy — Ever Works (k8s tenant cluster)
DEPLOY_EVER_WORKS_ENABLED=false
EVER_WORKS_DEPLOY_KUBECONFIG=                     # full contents or use _PATH
EVER_WORKS_DEPLOY_KUBECONFIG_PATH=
EVER_WORKS_DEPLOY_NAMESPACE=ever-works-tenants
EVER_WORKS_DEPLOY_INGRESS_HOST_TEMPLATE={slug}.ever.works
EVER_WORKS_DEPLOY_INGRESS_CLASS=nginx
EVER_WORKS_DEPLOY_TLS_ISSUER=letsencrypt-prod
EVER_WORKS_DEPLOY_REGISTRY=
EVER_WORKS_DEPLOY_MAX_WORKS_PER_USER=3
```

The catalog endpoint (`GET /api/onboarding/catalog`) surfaces the boolean
flags to the web app so the wizard renders the matching cards as Planned
when the underlying provider is disabled.

## 5. Server-side modules

### 5.1 `apps/api/src/onboarding/`

- `onboarding.module.ts` — registers controllers + service + telemetry hook.
- `onboarding-state.controller.ts` — `GET/PATCH /api/onboarding/state`, `POST /api/onboarding/complete`, `POST /api/onboarding/dismiss`.
- `onboarding-catalog.controller.ts` — `GET /api/onboarding/catalog`.
- `onboarding-state.service.ts` — reads/writes `users.onboarding_*` via repository.
- `onboarding-catalog.service.ts` — composes catalog from plugin manifests + env flags.
- `dto/{state,patch-state,catalog}.dto.ts` — class-validator + Swagger annotations.

### 5.2 `packages/agent/src/git/ever-works-git.provider.ts`

Implements the existing `GitProvider` shape used by `GitFacade`:

- `createRepository(work)` — Octokit `POST /orgs/{org}/repos`, private by default.
- `push(work, content)` — same Octokit, using the platform PAT.
- `delete(work)` — soft-only on the Ever Works side (we don't yank user data).
- Every call wraps in `ActivityLogService.record({ actorKind: 'platform', userId, action, resource })`.

### 5.3 `packages/agent/src/deployment/ever-works-k8s.provider.ts`

- `getDeployConfig(user)` — builds a `k8s` plugin config object from env vars, substituting `{slug}` in the ingress host template.
- `ensureNamespace(user)` — idempotent create of `{base-namespace}-{userId}`.
- `deploy(work)` — calls the existing `k8s` plugin's deploy primitive with the env-derived config.
- `checkQuota(userId)` — runs the indexed COUNT and throws a typed `QuotaExceededError` when ≥ `EVER_WORKS_DEPLOY_MAX_WORKS_PER_USER`.

### 5.4 `packages/agent/src/facades/git.facade.ts` (existing file)

Add a `storageProvider` branch in `createRepository`:

```ts
switch (work.storageProvider) {
  case 'ever-works-git':
    return this.everWorksGit.createRepository(work);
  case 'user-github':
  default:
    return this.userGithub.createRepository(work, /* organization */);
}
```

### 5.5 `WorksService.create` (existing)

- Read `users.onboarding_state` for the current user.
- Set `work.storageProvider = onboardingState.storage.choice` (default `user-github` if no state).
- Set `work.deployProvider  = onboardingState.deploy.choice`  (default `vercel`).
- If `deployProvider === 'ever-works'` AND `DEPLOY_EVER_WORKS_ENABLED`,
  call `EverWorksK8sDeployProvider.checkQuota(userId)` before persisting.

## 6. Plugin work

### 6.1 New: `packages/plugins/grok/`

Scaffolded by copying `packages/plugins/groq/` (closest existing analog) and adjusting:

- `package.json` — `everworks.plugin.id = 'grok'`, name "Grok (xAI)", category `ai-provider`, capabilities `["ai-provider"]`. `uiHints.includeInOnboarding: true`, `onboardingPriority: 3`.
- `src/grok.plugin.ts` — extends `BaseAiProvider`, `providerType = 'openai'`, `baseURL = https://api.x.ai/v1/`. Settings: `apiKey` (`x-secret`, `x-envVar: XAI_API_KEY`), `defaultModel` (default `grok-2-latest`), tiered `simple/medium/complex` models, `temperature`, `maxTokens`.
- Vitest spec covering manifest shape, `connectionValidation` happy + sad path with mocked `fetch`.

### 6.2 Modify: `packages/plugins/gemini/src/gemini.plugin.ts`

Add to `settingsSchema.properties`:

```ts
apiKey: {
  type: 'string',
  title: 'Gemini API Key',
  description: 'Use a direct Gemini API key. Leave empty to fall back to the local Gemini CLI.',
  'x-secret': true,
  'x-envVar': 'GEMINI_API_KEY',
  'x-scope': 'user'
}
```

CLI-mode path must still work when `apiKey` is empty (existing behaviour).
Update the plugin spec to assert both states.

### 6.3 Modify: `packages/plugins/k8s/package.json`

Flip `everworks.plugin.uiHints.includeInOnboarding` from `false` to `true`,
add `onboardingPriority: 4` and `onboardingDescription`. No code changes.

## 7. Web changes

### 7.1 New components (`apps/web/src/components/onboarding/`)

- `EverWorksOnboardingWizard.tsx` — rewritten driver; no longer iterates plugins.
- `useOnboardingFlow.ts` — `useReducer` over a step machine; SWR-syncs to `/api/onboarding/state` on every transition.
- `steps/WelcomeStep.tsx`, `AIChoiceStep.tsx`, `AIConfigStep.tsx`, `StorageChoiceStep.tsx`, `StorageConfigStep.tsx`, `DeployChoiceStep.tsx`, `DeployConfigStep.tsx`, `PluginsCatalogStep.tsx`, `CreateWorkStep.tsx`.
- `ChoiceCardGrid.tsx`, `ChoiceCard.tsx`, `PluginsCatalogGrid.tsx`.
- `WizardFooter.tsx` — Back + Skip + Refresh + Next.

### 7.2 Updated

- `apps/web/src/app/[locale]/(dashboard)/layout.tsx` — server-side fetch of state and catalog; pass into the client wizard.
- `apps/web/src/app/[locale]/(dashboard)/layout-client.tsx` — drop `useOnboardingState` localStorage path; render the new wizard.
- `apps/web/src/components/onboarding/use-onboarding-state.ts` — shrink to a thin SWR-style hook over the API; localStorage becomes offline-cache only.

### 7.3 New server action

- `apps/web/src/app/actions/onboarding/track.ts` — `'use server'`, accepts `(event, props)`, server-side validates, calls `AnalyticsService.track`.

### 7.4 Static assets

- `apps/web/public/logos/{openrouter,anthropic,xai,google,vercel,github,gitlab,kubernetes,everworks}.svg`.

## 8. Telemetry events

| Event | Required props | When |
|---|---|---|
| `onboarding_opened` | `trigger: 'auto'|'badge'|'help'` | First render with wizard open |
| `onboarding_closed` | `completed: bool`, `lastStepIndex` | Modal closes |
| `onboarding_completed` | none beyond defaults | Server flag flipped |
| `onboarding_step_viewed` | `stepKind`, `stepIndex`, `pluginId?` | Step paints |
| `onboarding_step_next` / `_back` / `_skipped` | `stepKind` | Footer action |
| `onboarding_ai_choice_selected` | `choice` | AI step Next/Skip |
| `onboarding_storage_choice_selected` | `choice` | Storage step Next/Skip |
| `onboarding_deploy_choice_selected` | `choice` | Deploy step Next/Skip |
| `onboarding_plugin_connected` | `pluginId`, `via: 'oauth'|'fields'|'device-auth'` | A config step reports success |
| `onboarding_plugin_refresh_clicked` | `pluginId` | Refresh button on a config step |
| `onboarding_planned_card_clicked` | `card` | Click on a greyed Planned card |
| `onboarding_byok_skipped` | `choice` | Skip on a BYOK config step |
| `onboarding_plugins_step_expanded` | `pluginId` | A card opens its inline form |
| `onboarding_plugins_step_skipped` / `_advanced` | none | Step 8 exit path |
| `onboarding_ever_works_quota_blocked` | `limit` | API returns `quota_exceeded` |

All events carry `userId` and `wizardVersion: 'v2'`.

## 9. Failure modes

| Scenario | Behaviour |
|---|---|
| `/api/onboarding/state` GET fails | Wizard renders with defaults; sets a banner; localStorage cache used if present |
| `PATCH /api/onboarding/state` fails | UI keeps progress locally; retries on next step transition; toast on permanent failure |
| Telemetry call fails | Logged server-side; never blocks UI |
| `EVER_WORKS_CUSTOMERS_GITHUB_PAT` invalid at runtime | API returns `storage_provider_misconfigured`; UI surfaces "We're working on it" toast; user can pick Your GitHub |
| Quota check race (two concurrent Work creates) | DB-level guard via `INSERT … WHERE COUNT(active) < cap` (or row-level lock on `users`) ensures one wins |
| `k8s` env config invalid | Boot-time validation rejects; deploy never starts |

## 10. Rollout

Per the saved pre-launch instruction, no v2 feature flag or ramp ceremony:

- Migrations run on `develop`.
- `STORAGE_EVER_WORKS_GIT_ENABLED` and `DEPLOY_EVER_WORKS_ENABLED` stay false in
  `.env.example`; flipped per environment once the org PAT and cluster are
  provisioned.
- When either flag is false, the corresponding card renders as Planned in the
  wizard.
- Standard PR flow: `develop → stage → main`.

## 11. PR breakdown (four commits on one branch)

1. **chore(plugins)**: scaffold `grok`, add `apiKey` to `gemini`, flip
   `k8s.includeInOnboarding`, copy tweak in `claude-code` config wizard.
2. **feat(agent)**: `EverWorksGitProvider`, `EverWorksK8sDeployProvider`,
   `git.facade` storage-branching, `works` columns + migration, quota service,
   activity-log integration.
3. **feat(api)**: `/api/onboarding/*` controllers, `users` columns + migration,
   catalog endpoint, server-side telemetry wiring.
4. **feat(web)**: wizard rewrite, choice components, plugins catalog,
   logos, server action, layout integration.
