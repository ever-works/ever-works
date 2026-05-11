# Feature Specification: Onboarding Wizard v2

> Behaviour-first spec per [Constitution Principle IX](../../memory/constitution.md#ix-specs-are-behaviour-first).
> Describe **what** the system does, not how it's structured. Save implementation
> details for `plan.md`. Mark any unresolved questions with `[NEEDS CLARIFICATION: …]`.

**Feature ID**: `onboarding-wizard-v2`
**Branch**: `feat/ew-onboarding-wizard-v2`
**Status**: `Draft` — awaiting owner sign-off before implementation.
**Created**: 2026-05-11
**Last updated**: 2026-05-11
**Owner**: ever@ever.co

---

## 1. Overview

Replace today's single-thread, "iterate over every onboarding plugin one by one"
wizard with a **guided choice flow** that walks a new user through the three
decisions that gate their first Work, plus a quick catalog of optional power-user
integrations:

1. **AI** — pick an AI provider (Ever Works AI default, or BYOK OpenRouter /
   Claude Code / Codex / Gemini / Grok).
2. **Storage** — pick where the user's Work repos live (Ever Works Git default,
   or the user's own GitHub; GitLab and self-hosted Git shown as Planned).
3. **Deployment** — pick where the Work gets deployed (Ever Works default,
   or Vercel / Kubernetes with user credentials).
4. **Plugins & Integrations** — a skippable browsing step listing
   make.com, SIM AI, Zapier, and ActivePieces so users discover them
   without being forced to configure them.

After these four choices, the user lands on the existing "Create your first
Work" step. The wizard also gains shared UX polish (Back, per-step Skip,
Refresh on async steps), analytics telemetry, and a server-side completion
flag so state survives device changes.

The platform also gains two new providers that match the default choices:

- **Ever Works Git**: server-held PAT pushes Work repos to the
  `ever-works-cloud` GitHub org so a user can ship without bringing their own
  GitHub.
- **Ever Works Deploy**: a platform-owned Kubernetes cluster, capped at
  **3 active Works per user**, so a user can preview a Work without bringing
  their own cluster or Vercel account.

## 2. User scenarios

The "user" is a logged-in, newly-registered human owner of a Work.

### 2.1 Primary scenarios

- **Happy path (all defaults)**: **Given** a fresh user opens the dashboard
  for the first time, **when** they advance through the wizard pressing Next
  on every step without changing any default, **then** their `onboardingState`
  records AI = `ever-works`, storage = `ever-works-git`, deploy = `ever-works`,
  the modal closes, `onboardingCompletedAt` is set, and creating a new Work
  inherits those three choices.

- **BYOK AI (OpenRouter)**: **Given** the user picks "OpenRouter" on the AI step
  and enters a valid API key on the Configure AI step, **when** they press Next,
  **then** the `openrouter` plugin is enabled for that user with the key stored
  encrypted, and `onboardingState.ai.choice = 'openrouter'`.

- **BYOK AI (Claude Code subscription)**: **Given** the user picks "Claude Code"
  and pastes a CLAUDE_CODE_OAUTH_TOKEN, **when** they press Next, **then** the
  existing `claude-code` plugin is configured with `oauthToken` populated, the
  platform routes AI work through the user's Claude Pro/Max subscription, and
  no per-token API key is required.

- **User GitHub storage**: **Given** the user picks "Your GitHub" on the Storage
  step, **when** they complete the GitHub OAuth or GitHub App flow on the
  Configure Storage step, **then** future Works are created under the user's
  selected GitHub account/org and `storageProvider = 'user-github'`.

- **Planned storage card**: **Given** the user clicks "Your GitLab" or
  "Your Git", **when** the card renders, **then** it is greyed out, shows a
  "Planned" badge, is not selectable, and clicking emits a
  `onboarding_planned_card_clicked` telemetry event without changing state.

- **Vercel deployment**: **Given** the user picks "Vercel" on the Deploy step,
  **when** they enter a Vercel API token on the Configure Deployment step,
  **then** the existing `vercel` plugin is configured and
  `deployProvider = 'vercel'`.

- **Plugins catalog skip**: **Given** the Plugins & Integrations step renders
  with cards for make.com / SIM AI / Zapier / ActivePieces, **when** the user
  clicks "Skip — set up later", **then** the wizard advances to the Create-Work
  step, `pluginsReviewed = true` is recorded, and no plugin settings are
  touched.

- **Plugins catalog configure inline**: **Given** the user expands the
  `make.com` card in step 8, **when** they save settings using the embedded
  plugin form, **then** that plugin's settings are persisted exactly as they
  would be via Settings → Plugins, and the card shows a green "Configured"
  badge.

### 2.2 Cross-cutting UX scenarios

- **Back button**: **Given** the user is on any step other than Welcome,
  **when** they press Back, **then** the wizard rewinds one effective step
  (skipped/conditional steps don't appear in history) and re-renders previously
  entered values.

- **Per-step Skip on choice steps**: **Given** the user is on a choice step,
  **when** they press "Skip step", **then** the current default option is
  accepted and the wizard advances.

- **Per-step Skip on config steps**: **Given** the user is on a config step
  for a BYOK option, **when** they press "Skip step", **then** the wizard
  advances without saving credentials, the step is recorded in
  `skippedSteps`, and the user is offered the same step again next time the
  wizard reopens.

- **Refresh on async steps**: **Given** the user is on a Configure step that
  waits for an external callback (OAuth return, device-auth polling),
  **when** they press Refresh, **then** the platform re-queries the connection
  status for that specific plugin and updates the panel without reloading the
  page.

- **Reopen on a new device**: **Given** a user finished the wizard on device A,
  **when** they log in on device B with no localStorage state, **then** the
  wizard sees `onboardingCompletedAt` from the server and does not auto-open.

- **Reopen mid-flow**: **Given** a user closed the wizard on step 4 without
  finishing, **when** they reopen the wizard later, **then** they resume at
  step 4 with previous choices preserved (loaded from server state, not
  localStorage).

### 2.3 Ever Works default-providers scenarios

- **Ever Works Git not provisioned**: **Given** `STORAGE_EVER_WORKS_GIT_ENABLED`
  is false (PAT or org not yet configured), **when** the wizard fetches the
  storage catalog, **then** the "Ever Works Git" card shows as Planned and
  is not selectable. The default choice falls back to "Your GitHub".

- **Ever Works Deploy quota exhausted**: **Given** a user already has 3 active
  Works using `deployProvider = 'ever-works'`, **when** they try to create a
  fourth Work with that deploy provider, **then** the API returns
  `429 quota_exceeded` with a typed error, and the UI surfaces a
  message offering Vercel or user-Kubernetes alternatives.

- **Ever Works Git repo creation**: **Given** `storageProvider = 'ever-works-git'`,
  **when** a Work is created, **then** a private repo named
  `{user-slug}-{work-slug}` is created in the `ever-works-cloud` GitHub org
  using the platform-held PAT, all subsequent git operations go through that
  PAT, and each operation logs an activity-log row with
  `actorKind: 'platform'` and the triggering user ID.

## 3. Functional requirements

### 3.1 Wizard structure

- **FR-1**. The wizard MUST present steps in this order: Welcome → AI Choice →
  AI Config → Storage Choice → Storage Config → Deploy Choice → Deploy Config →
  Plugins & Integrations → Create Work.
- **FR-2**. AI/Storage/Deploy Config steps MUST be skipped when the chosen
  vendor needs no configuration (Ever Works AI, Ever Works Git, Ever Works
  Deploy).
- **FR-3**. Every step MUST be skippable. Skipping a choice step accepts the
  pre-selected default.
- **FR-4**. The Plugins & Integrations step MUST surface at least the four
  plugins make.com, SIM AI, Zapier, ActivePieces. Additional plugins with
  `uiHints.includeInOnboarding: true` MAY appear there as the catalog grows.
- **FR-5**. The Plugins & Integrations step MUST NOT block completion of the
  wizard. A clearly-labelled "Skip — set up later" control MUST be present.

### 3.2 Choices and effects

- **FR-6**. The AI choice catalog MUST offer: Ever Works AI (default),
  OpenRouter, Claude Code, Codex, Gemini, Grok.
- **FR-7**. Picking Ever Works AI MUST NOT enable any user-scoped AI plugin;
  the platform falls back to env-configured provider credentials at AI-call
  time.
- **FR-8**. Picking any BYOK AI option MUST route to the corresponding
  plugin's existing onboarding/config UI: `openrouter`, `claude-code`,
  `codex`, `gemini`, `grok`. Claude Code MUST surface both `oauthToken`
  (subscription) and `apiKey` (per-token) inputs because cost-conscious users
  rely on the subscription path.
- **FR-9**. The Storage choice catalog MUST offer: Ever Works Git (default),
  Your GitHub, Your GitLab (Planned), Your Git (Planned). Planned cards MUST
  be non-selectable.
- **FR-10**. The Deploy choice catalog MUST offer: Ever Works (default),
  Vercel, Kubernetes.
- **FR-11**. When a user creates a new Work after onboarding, the Work's
  `storageProvider` and `deployProvider` MUST default to the user's saved
  onboarding choices.
- **FR-12**. Changing a user's onboarding choices later MUST NOT modify
  `storageProvider` or `deployProvider` on previously-created Works.

### 3.3 Ever Works Git provider

- **FR-13**. The platform MUST expose an env-gated "Ever Works Git" storage
  provider that, when enabled, creates a private GitHub repo in the
  `ever-works-cloud` org using a platform-held PAT and writes generated Work
  content there.
- **FR-14**. Every push or repo-mutation performed by the Ever Works Git
  provider on behalf of a user MUST record an activity-log row capturing the
  acting user, the work, the action, and the GitHub repo full name.
- **FR-15**. Repo naming MUST be `{user-slug}-{work-slug}`. Conflicts MUST be
  resolved by appending `-{shortId}` where `shortId` is the first 8 chars of
  the Work's UUID.
- **FR-16**. When `STORAGE_EVER_WORKS_GIT_ENABLED` is false, the API MUST
  reject `storageProvider = 'ever-works-git'` with a typed
  `storage_provider_disabled` error.

### 3.4 Ever Works Deploy provider

- **FR-17**. The platform MUST expose an env-gated "Ever Works" deployment
  provider that, when enabled, deploys generated Works to a platform-owned
  Kubernetes cluster using the existing `k8s` plugin's deployment primitives,
  configured from env vars at call time (no per-user kubeconfig storage).
- **FR-18**. The provider MUST enforce a per-user cap of
  `EVER_WORKS_DEPLOY_MAX_WORKS_PER_USER` (default **3**) **active** Works.
  "Active" means the Work row's status is not `deleted`/`archived`. Hitting
  the cap MUST return a `429 quota_exceeded` typed error from the
  Work-create / redeploy paths.
- **FR-19**. Each user MUST get an isolated Kubernetes namespace
  (`{base-namespace}-{userId}`) when their first ever-works-deploy Work is
  provisioned.

### 3.5 State and persistence

- **FR-20**. Onboarding state MUST be persisted server-side on the `users`
  table, including `onboardingCompletedAt`, `onboardingDismissedAt`, and a
  structured `onboardingState` JSON column capturing the three choices, the
  last viewed step, and the list of skipped step IDs.
- **FR-21**. The wizard MUST seed its initial state from the server, not
  localStorage. localStorage MAY be used as an offline-cache fallback only.
- **FR-22**. `onboardingCompletedAt` MUST be set automatically when:
  (a) the user has at least one Work AND
  (b) every chosen vendor has the credentials it needs (or chose an Ever Works
  default that needs nothing).

### 3.6 Telemetry

- **FR-23**. The web app MUST emit PostHog events for: wizard open/close,
  step view/next/back/skip, AI/Storage/Deploy choice selection, BYOK card
  skip, Planned card click, plugin connect success, plugins-step expand /
  skip / advance, and the Ever Works deploy quota block.
- **FR-24**. Telemetry MUST flow through a server action that calls the
  existing `AnalyticsService` in `@ever-works/monitoring`. No `posthog-js`
  client bundle is to be added.
- **FR-25**. Each event MUST carry `userId` and `wizardVersion: 'v2'`. Step
  events MUST carry `stepKind` and, where applicable, `pluginId`.

### 3.7 Plugin scaffolding

- **FR-26**. A new `grok` plugin MUST exist in `packages/plugins/grok/`,
  category `ai-provider`, with a settings schema containing at least
  `apiKey` (secret), `defaultModel`, and tiered model overrides. xAI's
  OpenAI-compatible API at `https://api.x.ai/v1/` is the integration target.
- **FR-27**. The existing `gemini` plugin MUST gain an optional `apiKey`
  field so direct-API usage is possible without the CLI. The CLI path MUST
  keep working when `apiKey` is empty.
- **FR-28**. The `k8s` plugin's manifest MUST flip `uiHints.includeInOnboarding`
  to `true` so the Deploy → Kubernetes card has a working Configure step.

## 4. Non-functional requirements

- **NFR-1**. The wizard MUST render the first step in under 200 ms after the
  dashboard mounts on a cold load with a primed Next.js build (no extra
  client-side data fetching before paint).
- **NFR-2**. PostHog events for the wizard MUST be best-effort: a failed
  event MUST NOT block the user's next interaction.
- **NFR-3**. The Ever Works Git provider's PAT MUST never be returned by any
  API response or surfaced in logs.
- **NFR-4**. The Ever Works Deploy quota check MUST add at most one extra
  query to the Work-create path (an indexed `COUNT(*)` on `works` filtered by
  user + provider + active status).
- **NFR-5**. Telemetry events MUST be transport-encoded as the existing
  PostHog payload format (no schema changes there).

## 5. Out of scope

- Replacing the existing per-plugin settings UIs (we reuse them inside Config
  and Plugins steps).
- Multi-tenant / per-org onboarding state (this feature stores state per user,
  not per org).
- Cross-device real-time sync of in-progress wizard state (we persist on every
  step transition, but we do not push live updates).
- Building real GitLab or generic-Git providers — those cards remain Planned.
- Migrating already-created Works to `ever-works-git` or `ever-works-deploy`.
- Cost reporting / per-user usage dashboards for Ever Works Deploy quota.

## 6. Open questions

None as of 2026-05-11 — all prior `[NEEDS CLARIFICATION]` items resolved
by the owner (org name `ever-works-cloud`, active-works quota of 3, initial
plugin catalog limited to make / sim-ai / zapier / activepieces, no pre-launch
feature-flag ceremony).

## 7. Acceptance checklist

A reviewer can sign this spec off once they have confirmed each item:

- [ ] Every functional requirement maps to at least one user scenario in §2.
- [ ] Every "Ever Works default" path has a fallback when the corresponding env
  flag is disabled.
- [ ] The wizard never gets the user stuck — every step has a skip path.
- [ ] State survives a localStorage wipe (cookies cleared) without resetting.
- [ ] Existing per-plugin onboarding UIs (PluginOnboardingWizard,
  OnboardingPluginStep) are reused, not duplicated.
- [ ] The Ever Works Git PAT and Ever Works Deploy kubeconfig are read from
  env only; nothing is committed to the repo.
