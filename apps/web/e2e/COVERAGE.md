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
| `ai-conversation/openai-compat.controller.ts`                  | [ ]    | _gap — openai-compat.spec.ts (new)_                            |
| `auth/api-keys.controller.ts`                                  | [x]    | api-keys.spec.ts                                               |
| `auth/auth.controller.ts`                                      | [x]    | auth.spec.ts, password-reset.spec.ts, forms-validation.spec.ts |
| `auth/oauth.controller.ts`                                     | [x]    | oauth-state.spec.ts                                            |
| `budgets/admin-usage.controller.ts`                            | [ ]    | _gap — budgets-admin.spec.ts (new)_                            |
| `budgets/budgets.controller.ts`                                | [ ]    | _gap — budgets.spec.ts (new)_                                  |
| `budgets/usage.controller.ts`                                  | [ ]    | _gap — budgets.spec.ts (new)_                                  |
| `data-sync.controller.ts`                                      | [x]    | data-sync.spec.ts                                              |
| `integrations/github-app/github-app.controller.ts`             | [ ]    | _gap — github-app.spec.ts (new)_                               |
| `integrations/github-app/github-app-webhook.controller.ts`     | [ ]    | _gap — github-app.spec.ts_                                     |
| `notifications.controller.ts`                                  | [x]    | notifications.spec.ts                                          |
| `onboarding/claim.controller.ts`                               | [~]    | zero-friction-flow.spec.ts                                     |
| `onboarding/onboarding-catalog.controller.ts`                  | [x]    | onboarding.spec.ts, onboarding-wizard-v2.spec.ts               |
| `onboarding/onboarding-state.controller.ts`                    | [x]    | onboarding.spec.ts                                             |
| `onboarding/onboarding-telemetry.controller.ts`                | [ ]    | _gap — onboarding-telemetry.spec.ts (new)_                     |
| `onboarding/onboarding.controller.ts`                          | [x]    | onboarding.spec.ts                                             |
| `onboarding/well-known.controller.ts`                          | [ ]    | _gap — well-known.spec.ts (new)_                               |
| `plugins-capabilities/deploy/deploy.controller.ts`             | [x]    | screenshot-and-deploy.spec.ts                                  |
| `plugins-capabilities/device-auth/device-auth.controller.ts`   | [ ]    | _gap — device-auth.spec.ts (new)_                              |
| `plugins-capabilities/git-provider/git-provider.controller.ts` | [x]    | git-providers.spec.ts                                          |
| `plugins-capabilities/oauth/oauth.controller.ts`               | [x]    | plugins.spec.ts                                                |
| `plugins-capabilities/screenshot/screenshot.controller.ts`     | [x]    | screenshot-and-deploy.spec.ts                                  |
| `plugins-capabilities/search/search.controller.ts`             | [ ]    | _gap — plugins-search.spec.ts (new)_                           |
| `plugins/plugins.controller.ts`                                | [x]    | plugins.spec.ts                                                |
| `subscriptions/subscriptions.controller.ts`                    | [x]    | subscriptions.spec.ts                                          |
| `telemetry/telemetry.controller.ts`                            | [ ]    | _gap — telemetry.spec.ts (new)_                                |
| `template-catalog/template-catalog.controller.ts`              | [x]    | website-templates.spec.ts                                      |
| `trigger/trigger-internal.controller.ts`                       | [skip] | internal-only, secret-gated                                    |
| `work-proposals/work-proposals.controller.ts`                  | [ ]    | _gap — work-proposals.spec.ts (new)_                           |
| `works/activity-feed/activity-feed.controller.ts`              | [x]    | activity-log.spec.ts                                           |
| `works/invitations.controller.ts`                              | [ ]    | _gap — work-invitations.spec.ts (new)_                         |
| `works/members.controller.ts`                                  | [ ]    | _gap — work-members.spec.ts (new)_                             |
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
| `/[locale]/(dashboard)/admin/usage`                 | [ ]    | _gap — budgets-admin.spec.ts (new)_                |
| `/[locale]/(dashboard)/plugins`                     | [x]    | plugins.spec.ts                                    |
| `/[locale]/(dashboard)/plugins/[pluginId]`          | [~]    | plugins.spec.ts                                    |
| `/[locale]/(dashboard)/profile`                     | [x]    | profile.spec.ts                                    |
| `/[locale]/(dashboard)/templates`                   | [x]    | website-templates.spec.ts                          |
| `/[locale]/(dashboard)/settings`                    | [x]    | settings.spec.ts                                   |
| `/[locale]/(dashboard)/settings/api-keys`           | [x]    | api-keys.spec.ts                                   |
| `/[locale]/(dashboard)/settings/security`           | [x]    | security-settings.spec.ts                          |
| `/[locale]/(dashboard)/settings/data`               | [x]    | account-data.spec.ts                               |
| `/[locale]/(dashboard)/settings/danger`             | [x]    | account-data.spec.ts                               |
| `/[locale]/(dashboard)/settings/github-app`         | [ ]    | _gap — github-app.spec.ts (new)_                   |
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
| `/[locale]/(dashboard)/works/[id]/generator/comparisons`        | [ ]    | _gap — work-generator.spec.ts (new)_             |
| `/[locale]/(dashboard)/works/[id]/generator/comparisons/[slug]` | [ ]    | _gap — work-generator.spec.ts_                   |
| `/[locale]/(dashboard)/works/[id]/generator/history`            | [ ]    | _gap — work-generator.spec.ts_                   |
| `/[locale]/(dashboard)/works/[id]/generator/schedule`           | [ ]    | _gap — work-generator.spec.ts_                   |
| `/[locale]/(dashboard)/works/[id]/items`                        | [x]    | items-import-export.spec.ts                      |
| `/[locale]/(dashboard)/works/[id]/members`                      | [ ]    | _gap — work-members.spec.ts (new)_               |
| `/[locale]/(dashboard)/works/[id]/plugins`                      | [~]    | plugins.spec.ts                                  |
| `/[locale]/(dashboard)/works/[id]/settings`                     | [x]    | settings-extra.spec.ts                           |
| `/[locale]/(dashboard)/works/[id]/settings/budgets-usage`       | [ ]    | _gap — budgets.spec.ts (new)_                    |
| `/[locale]/(dashboard)/works/[id]/settings/members`             | [ ]    | _gap — work-members.spec.ts (new)_               |

### Web API routes (Next.js)

| Route                                                    | Status | Spec(s)                                    |
| -------------------------------------------------------- | ------ | ------------------------------------------ |
| `/api/health`                                            | [x]    | health-meta.spec.ts                        |
| `/api/auth/authorize`                                    | [~]    | oauth-state.spec.ts                        |
| `/api/auth/provider/callback/[providerId]`               | [x]    | oauth-state.spec.ts                        |
| `/api/auth/reset-password`                               | [x]    | password-reset.spec.ts                     |
| `/api/auth/verify-email`                                 | [~]    | auth.spec.ts                               |
| `/api/chat`                                              | [ ]    | _gap — chat-api.spec.ts (new)_             |
| `/api/github-app/callback`                               | [ ]    | _gap — github-app.spec.ts (new)_           |
| `/api/github-app/setup`                                  | [ ]    | _gap — github-app.spec.ts (new)_           |
| `/api/oauth/[providerId]/callback`                       | [x]    | oauth-state.spec.ts                        |
| `/api/oauth/[providerId]/callback/plugins`               | [~]    | plugins.spec.ts                            |
| `/api/oauth/[providerId]/callback/plugins/read-packages` | [ ]    | _gap — plugins-readpackages.spec.ts (new)_ |
| `/api/works/[id]/comparisons/generation-status`          | [ ]    | _gap — work-generator.spec.ts_             |
| `/api/works/[id]/deploy/status`                          | [x]    | screenshot-and-deploy.spec.ts              |
| `/api/works/[id]/export-items`                           | [x]    | items-import-export.spec.ts                |
| `/api/works/[id]/import-items`                           | [x]    | items-import-export.spec.ts                |
| `/api/works/[id]/usage/export`                           | [ ]    | _gap — budgets.spec.ts_                    |
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
| Rate limiting / throttler             | [ ]    | _gap — rate-limit.spec.ts (new)_        |

---

## Plan for pass 1 (this PR — `chore/e2e-coverage-pass-1`)

New specs being added:

- [ ] `budgets.spec.ts` — `/api/works/:id/usage/*`, `/api/budgets/*`, `/api/admin/usage` API + work-budgets-usage page
- [ ] `work-members.spec.ts` — invitations + members API + members page
- [ ] `work-proposals.spec.ts` — community PR proposals API
- [ ] `plugins-search.spec.ts` — search capability API
- [ ] `device-auth.spec.ts` — CLI device auth flow API
- [ ] `chat-api.spec.ts` — `/api/chat` route
- [ ] `well-known.spec.ts` — well-known endpoints
- [ ] `telemetry.spec.ts` — telemetry endpoints
- [ ] `openai-compat.spec.ts` — OpenAI-compat API contract

## Plan for pass 2 (next iteration)

- [ ] `work-generator.spec.ts` — comparisons / history / schedule pages
- [ ] `github-app.spec.ts` — settings/github-app + /api/github-app/\* routes
- [ ] `activity-log-export.spec.ts` — `/api/activity-log/export`
- [ ] `plugins-readpackages.spec.ts` — read-packages OAuth subflow
- [ ] `budgets-admin.spec.ts` — admin/usage page + admin-usage API
- [ ] `multi-user-collab.spec.ts` — concurrent user actions
- [ ] `rate-limit.spec.ts` — throttler enforcement

## Plan for pass 3 and beyond

Deepen thin coverage marked `[~]`:

- claim flow happy path + invalid token
- plugin detail page interactions
- work generator full UI journey
- onboarding step-by-step UI
- work activity feed real-time updates

---

## How to extend

1. Pick a `[ ]` row.
2. Add a new spec file under `apps/web/e2e/<name>.spec.ts` using the API helpers in `helpers/`.
3. Flip the row to `[x]` (or `[~]` if partial) and add the spec filename.
4. PR to `develop`; CI runs E2E on develop / stage / main pushes.

The existing helper `helpers/api.ts` registers users, logs them in, and creates works. Use it for fast unauthenticated-only or fast-setup tests. Reach for full UI driving only when the test is about UI behavior.
