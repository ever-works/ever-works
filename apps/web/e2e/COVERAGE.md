# E2E Coverage Tracker

> **Goal:** every web page, every API controller, every realistic user flow is covered by at least one Playwright spec.
> **Cadence:** continuous, one PR per cluster of features. Started 2026-05-19.

## Legend

- `[x]` covered by a dedicated or shared spec
- `[ ]` not yet covered
- `[~]` partial coverage — listed in a spec but with thin assertions
- `(spec)` the file under `apps/web/e2e/` that owns the coverage

---

## API controllers (`apps/api/src/**/*.controller.ts`)

| Controller                                                     | Status | Spec(s)                                                        |
| -------------------------------------------------------------- | ------ | -------------------------------------------------------------- |
| `account/account.controller.ts`                                | [x]    | account-data.spec.ts                                           |
| `activity-log/activity-log.controller.ts`                      | [x]    | activity-log.spec.ts                                           |
| `ai-conversation/conversation.controller.ts`                   | [x]    | conversations.spec.ts                                          |
| `ai-conversation/openai-compat.controller.ts`                  | [x]    | openai-compat.spec.ts                                          |
| `auth/api-keys.controller.ts`                                  | [x]    | api-keys.spec.ts                                               |
| `auth/auth.controller.ts`                                      | [x]    | auth.spec.ts, password-reset.spec.ts, forms-validation.spec.ts |
| `auth/oauth.controller.ts`                                     | [x]    | oauth-state.spec.ts                                            |
| `budgets/admin-usage.controller.ts`                            | [x]    | budgets.spec.ts                                                |
| `budgets/budgets.controller.ts`                                | [x]    | budgets.spec.ts                                                |
| `budgets/usage.controller.ts`                                  | [x]    | budgets.spec.ts                                                |
| `data-sync.controller.ts`                                      | [x]    | data-sync.spec.ts                                              |
| `integrations/github-app/github-app.controller.ts`             | [x]    | github-app.spec.ts                                             |
| `integrations/github-app/github-app-webhook.controller.ts`     | [x]    | github-app.spec.ts                                             |
| `notifications.controller.ts`                                  | [x]    | notifications.spec.ts                                          |
| `onboarding/claim.controller.ts`                               | [x]    | claim-flow.spec.ts, zero-friction-flow.spec.ts                 |
| `onboarding/onboarding-catalog.controller.ts`                  | [x]    | onboarding.spec.ts, onboarding-wizard-v2.spec.ts               |
| `onboarding/onboarding-state.controller.ts`                    | [x]    | onboarding.spec.ts                                             |
| `onboarding/onboarding-telemetry.controller.ts`                | [x]    | telemetry.spec.ts                                              |
| `onboarding/onboarding.controller.ts`                          | [x]    | onboarding.spec.ts                                             |
| `onboarding/well-known.controller.ts`                          | [x]    | well-known.spec.ts                                             |
| `plugins-capabilities/deploy/deploy.controller.ts`             | [x]    | screenshot-and-deploy.spec.ts                                  |
| `plugins-capabilities/device-auth/device-auth.controller.ts`   | [x]    | device-auth.spec.ts                                            |
| `plugins-capabilities/git-provider/git-provider.controller.ts` | [x]    | git-providers.spec.ts                                          |
| `plugins-capabilities/oauth/oauth.controller.ts`               | [x]    | plugins.spec.ts                                                |
| `plugins-capabilities/screenshot/screenshot.controller.ts`     | [x]    | screenshot-and-deploy.spec.ts                                  |
| `plugins-capabilities/search/search.controller.ts`             | [x]    | plugins-search.spec.ts                                         |
| `plugins/plugins.controller.ts`                                | [x]    | plugins.spec.ts                                                |
| `subscriptions/subscriptions.controller.ts`                    | [x]    | subscriptions.spec.ts                                          |
| `telemetry/telemetry.controller.ts`                            | [x]    | telemetry.spec.ts                                              |
| `template-catalog/template-catalog.controller.ts`              | [x]    | website-templates.spec.ts                                      |
| `trigger/trigger-internal.controller.ts`                       | [skip] | internal-only, secret-gated                                    |
| `work-proposals/work-proposals.controller.ts`                  | [x]    | work-proposals.spec.ts                                         |
| `works/activity-feed/activity-feed.controller.ts`              | [x]    | activity-log.spec.ts                                           |
| `works/invitations.controller.ts`                              | [x]    | work-members.spec.ts                                           |
| `works/members.controller.ts`                                  | [x]    | work-members.spec.ts                                           |
| `works.controller.ts`                                          | [x]    | works-api.spec.ts, works.spec.ts                               |

## Web routes (`apps/web/src/app/**/page.tsx`)

### Public / auth

| Route                              | Status | Spec(s)                                |
| ---------------------------------- | ------ | -------------------------------------- |
| `/[locale]/(auth)/login`           | [x]    | auth.spec.ts, accessibility.spec.ts    |
| `/[locale]/(auth)/register`        | [x]    | auth.spec.ts, forms-validation.spec.ts |
| `/[locale]/(auth)/forgot-password` | [x]    | password-reset.spec.ts                 |
| `/[locale]/(auth)/reset-password`  | [x]    | password-reset.spec.ts                 |
| `/[locale]/(auth)/auth/error`      | [x]    | error-pages.spec.ts                    |
| `/[locale]/claim/[token]`          | [~]    | zero-friction-flow.spec.ts             |
| `/[locale]/[...rest]` (404)        | [x]    | error-pages.spec.ts                    |

### Dashboard

| Route                                               | Status | Spec(s)                                            |
| --------------------------------------------------- | ------ | -------------------------------------------------- |
| `/[locale]/(dashboard)/(home)`                      | [x]    | dashboard.spec.ts, dashboard-comprehensive.spec.ts |
| `/[locale]/(dashboard)/activity`                    | [x]    | activity-log.spec.ts                               |
| `/[locale]/(dashboard)/discover`                    | [x]    | dashboard-comprehensive.spec.ts                    |
| `/[locale]/(dashboard)/admin/usage`                 | [x]    | budgets.spec.ts                                    |
| `/[locale]/(dashboard)/plugins`                     | [x]    | plugins.spec.ts                                    |
| `/[locale]/(dashboard)/plugins/[pluginId]`          | [~]    | plugins.spec.ts                                    |
| `/[locale]/(dashboard)/profile`                     | [x]    | profile.spec.ts                                    |
| `/[locale]/(dashboard)/templates`                   | [x]    | website-templates.spec.ts                          |
| `/[locale]/(dashboard)/settings`                    | [x]    | settings.spec.ts                                   |
| `/[locale]/(dashboard)/settings/api-keys`           | [x]    | api-keys.spec.ts                                   |
| `/[locale]/(dashboard)/settings/security`           | [x]    | security-settings.spec.ts                          |
| `/[locale]/(dashboard)/settings/data`               | [x]    | account-data.spec.ts                               |
| `/[locale]/(dashboard)/settings/danger`             | [x]    | account-data.spec.ts                               |
| `/[locale]/(dashboard)/settings/github-app`         | [x]    | github-app.spec.ts                                 |
| `/[locale]/(dashboard)/settings/plugins/[category]` | [~]    | plugins.spec.ts, settings-extra.spec.ts            |

### Works

| Route                                                           | Status | Spec(s)                                          |
| --------------------------------------------------------------- | ------ | ------------------------------------------------ |
| `/[locale]/(dashboard)/works`                                   | [x]    | works.spec.ts, works-detail.spec.ts              |
| `/[locale]/(dashboard)/works/new`                               | [x]    | works-detail.spec.ts, zero-friction-flow.spec.ts |
| `/[locale]/(dashboard)/works/[id]`                              | [x]    | works-detail.spec.ts                             |
| `/[locale]/(dashboard)/works/[id]/activity`                     | [~]    | activity-log.spec.ts                             |
| `/[locale]/(dashboard)/works/[id]/deploy`                       | [x]    | screenshot-and-deploy.spec.ts                    |
| `/[locale]/(dashboard)/works/[id]/generator`                    | [~]    | works-detail.spec.ts                             |
| `/[locale]/(dashboard)/works/[id]/generator/comparisons`        | [x]    | work-generator.spec.ts                           |
| `/[locale]/(dashboard)/works/[id]/generator/comparisons/[slug]` | [x]    | work-generator.spec.ts                           |
| `/[locale]/(dashboard)/works/[id]/generator/history`            | [x]    | work-generator.spec.ts                           |
| `/[locale]/(dashboard)/works/[id]/generator/schedule`           | [x]    | work-generator.spec.ts                           |
| `/[locale]/(dashboard)/works/[id]/items`                        | [x]    | items-import-export.spec.ts                      |
| `/[locale]/(dashboard)/works/[id]/members`                      | [x]    | work-members.spec.ts                             |
| `/[locale]/(dashboard)/works/[id]/plugins`                      | [~]    | plugins.spec.ts                                  |
| `/[locale]/(dashboard)/works/[id]/settings`                     | [x]    | settings-extra.spec.ts                           |
| `/[locale]/(dashboard)/works/[id]/settings/budgets-usage`       | [x]    | budgets.spec.ts                                  |
| `/[locale]/(dashboard)/works/[id]/settings/members`             | [x]    | work-members.spec.ts                             |

### Web API routes (Next.js)

| Route                                                    | Status | Spec(s)                                    |
| -------------------------------------------------------- | ------ | ------------------------------------------ |
| `/api/health`                                            | [x]    | health-meta.spec.ts                        |
| `/api/auth/authorize`                                    | [~]    | oauth-state.spec.ts                        |
| `/api/auth/provider/callback/[providerId]`               | [x]    | oauth-state.spec.ts                        |
| `/api/auth/reset-password`                               | [x]    | password-reset.spec.ts                     |
| `/api/auth/verify-email`                                 | [~]    | auth.spec.ts                               |
| `/api/chat`                                              | [x]    | chat-api.spec.ts                           |
| `/api/github-app/callback`                               | [x]    | github-app.spec.ts                         |
| `/api/github-app/setup`                                  | [x]    | github-app.spec.ts                         |
| `/api/oauth/[providerId]/callback`                       | [x]    | oauth-state.spec.ts                        |
| `/api/oauth/[providerId]/callback/plugins`               | [~]    | plugins.spec.ts                            |
| `/api/oauth/[providerId]/callback/plugins/read-packages` | [ ]    | _gap — plugins-readpackages.spec.ts (new)_ |
| `/api/works/[id]/comparisons/generation-status`          | [x]    | work-generator.spec.ts                     |
| `/api/works/[id]/deploy/status`                          | [x]    | screenshot-and-deploy.spec.ts              |
| `/api/works/[id]/export-items`                           | [x]    | items-import-export.spec.ts                |
| `/api/works/[id]/import-items`                           | [x]    | items-import-export.spec.ts                |
| `/api/works/[id]/usage/export`                           | [x]    | budgets.spec.ts                            |
| `/api/activity-log/[id]`                                 | [~]    | activity-log.spec.ts                       |
| `/api/activity-log/export`                               | [ ]    | _gap — activity-log-export.spec.ts (new)_  |

---

## Cross-cutting concerns

| Concern                               | Status | Spec(s)                                 |
| ------------------------------------- | ------ | --------------------------------------- |
| i18n routing (locale handling)        | [x]    | i18n-locales.spec.ts                    |
| Navigation & breadcrumbs              | [x]    | navigation.spec.ts                      |
| SEO meta tags                         | [x]    | seo-meta.spec.ts                        |
| Accessibility                         | [x]    | accessibility.spec.ts                   |
| CORS / preflight                      | [x]    | health-meta.spec.ts                     |
| Form validation client-side           | [x]    | forms-validation.spec.ts                |
| OAuth state CSRF                      | [x]    | oauth-state.spec.ts                     |
| Public API unauth contract            | [x]    | api-public-contract.spec.ts             |
| Concurrent multi-user (collaboration) | [ ]    | _gap — multi-user-collab.spec.ts (new)_ |
| Rate limiting / throttler             | [x]    | rate-limit.spec.ts                      |

---

## Pass 1 — landed in PR #846

Closed 9 controller gaps + introduced the tracker. Specs:
`budgets`, `work-members`, `work-proposals`, `plugins-search`,
`device-auth`, `well-known`, `telemetry`, `chat-api`, `openai-compat`.

## Pass 2 — this PR (`chore/e2e-coverage-pass-2`)

New specs being added (15):

- [x] `github-app.spec.ts` — webhook + setup + callback + installations CRUD + settings page
- [x] `work-generator.spec.ts` — generator + history + schedule + comparisons subpages + generate-details + cancel
- [x] `work-items-crud.spec.ts` — submit/remove/update/check-health + extract-item-details + bulk-capture-images
- [x] `work-deployment.spec.ts` — deploy capability + deploy/status
- [x] `notifications-lifecycle.spec.ts` — read/dismiss/read-all/unread-count/persistent
- [x] `plugins-crud.spec.ts` — top-level plugin enable/disable + per-work plugin CRUD
- [x] `work-schedule.spec.ts` — full schedule CRUD + scheduled run + activity-sync/rotate-secret
- [x] `work-stats-config.spec.ts` — works/stats + per-work config + website-settings + source-validation + quick-create
- [x] `subscriptions-plan.spec.ts` — plan get/set
- [x] `activity-feed-perwork.spec.ts` — per-work activity feed + pagination + stranger access
- [x] `claim-flow.spec.ts` — anonymous registration + claim token validation (valid + invalid token)
- [x] `api-keys-lifecycle.spec.ts` — full lifecycle: create returns plaintext once, list redacts, revoke
- [x] `rate-limit.spec.ts` — login throttler + anonymous-auth throttler
- [x] `password-reset-edge.spec.ts` — bogus / empty / expired tokens + H-03 timing-uniformity
- [x] `conversations-crud.spec.ts` — conversation CRUD lifecycle + stranger access

## Pass 3 — queued

Still gap-row:

- [ ] `plugins-readpackages.spec.ts` — read-packages OAuth subflow (`/api/oauth/:p/callback/plugins/read-packages`)
- [ ] `activity-log-export.spec.ts` — `/api/activity-log/export` web route
- [ ] `multi-user-collab.spec.ts` — concurrent users on a shared work (Playwright multi-context)

Plus deepening these `[~]`:

- `/[locale]/(dashboard)/plugins/[pluginId]` — plugin detail page interactions (toggle, configure, validate)
- `/[locale]/(dashboard)/settings/plugins/[category]` — settings/plugins/[category] config flow
- `/[locale]/(dashboard)/works/[id]/plugins` — work-scoped plugin UI
- `/[locale]/(dashboard)/works/[id]/activity` — per-work activity UI
- `/[locale]/(dashboard)/works/[id]/generator` — full UI journey for generation
- `/api/auth/authorize` — OAuth authorize web route (currently only oauth-state covers it)
- `/api/auth/verify-email` — verify-email web route (auth.spec.ts touches it lightly)
- `/api/oauth/[providerId]/callback/plugins` — plugin OAuth callback web route

## Pass 4+ — hardening / cross-cutting deepening

- `webhook-subscription.spec.ts` — webhook subscription CRUD (if exposed)
- `seo-sitemap.spec.ts` — sitemap.xml, robots.txt
- `i18n-content.spec.ts` — verify actual translated strings render per locale (not just html lang)
- `cors-credentials.spec.ts` — credentialed CORS pre-flight
- `security-2fa.spec.ts` — 2FA enrollment + verify flow (if exposed)
- `audit-log-immutable.spec.ts` — verify activity-log entries are append-only (no edit/delete endpoints)
- `subscription-tiers.spec.ts` — feature gates per plan (anonymous TTL, schedule cadence limits)

Then iteratively turn every `[~]` into `[x]` and tighten any `[x]` that has thin assertions.

---

## How to extend

1. Pick a `[ ]` row.
2. Add a new spec file under `apps/web/e2e/<name>.spec.ts` using the API helpers in `helpers/`.
3. Flip the row to `[x]` (or `[~]` if partial) and add the spec filename.
4. PR to `develop`; CI runs E2E on develop / stage / main pushes.

The existing helper `helpers/api.ts` registers users, logs them in, and creates works. Use it for fast unauthenticated-only or fast-setup tests. Reach for full UI driving only when the test is about UI behavior.
