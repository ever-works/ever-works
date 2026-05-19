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

| Route                              | Status | Spec(s)                                        |
| ---------------------------------- | ------ | ---------------------------------------------- |
| `/[locale]/(auth)/login`           | [x]    | auth.spec.ts, accessibility.spec.ts            |
| `/[locale]/(auth)/register`        | [x]    | auth.spec.ts, forms-validation.spec.ts         |
| `/[locale]/(auth)/forgot-password` | [x]    | password-reset.spec.ts                         |
| `/[locale]/(auth)/reset-password`  | [x]    | password-reset.spec.ts                         |
| `/[locale]/(auth)/auth/error`      | [x]    | error-pages.spec.ts                            |
| `/[locale]/claim/[token]`          | [x]    | claim-flow.spec.ts, zero-friction-flow.spec.ts |
| `/[locale]/[...rest]` (404)        | [x]    | error-pages.spec.ts                            |

### Dashboard

| Route                                               | Status | Spec(s)                                            |
| --------------------------------------------------- | ------ | -------------------------------------------------- |
| `/[locale]/(dashboard)/(home)`                      | [x]    | dashboard.spec.ts, dashboard-comprehensive.spec.ts |
| `/[locale]/(dashboard)/activity`                    | [x]    | activity-log.spec.ts                               |
| `/[locale]/(dashboard)/discover`                    | [x]    | dashboard-comprehensive.spec.ts                    |
| `/[locale]/(dashboard)/admin/usage`                 | [x]    | budgets.spec.ts                                    |
| `/[locale]/(dashboard)/plugins`                     | [x]    | plugins.spec.ts                                    |
| `/[locale]/(dashboard)/plugins/[pluginId]`          | [x]    | plugin-detail-ui.spec.ts, plugins.spec.ts          |
| `/[locale]/(dashboard)/profile`                     | [x]    | profile.spec.ts                                    |
| `/[locale]/(dashboard)/templates`                   | [x]    | website-templates.spec.ts                          |
| `/[locale]/(dashboard)/settings`                    | [x]    | settings.spec.ts                                   |
| `/[locale]/(dashboard)/settings/api-keys`           | [x]    | api-keys.spec.ts                                   |
| `/[locale]/(dashboard)/settings/security`           | [x]    | security-settings.spec.ts                          |
| `/[locale]/(dashboard)/settings/data`               | [x]    | account-data.spec.ts                               |
| `/[locale]/(dashboard)/settings/danger`             | [x]    | account-data.spec.ts                               |
| `/[locale]/(dashboard)/settings/github-app`         | [x]    | github-app.spec.ts                                 |
| `/[locale]/(dashboard)/settings/plugins/[category]` | [x]    | plugin-detail-ui.spec.ts, settings-extra.spec.ts   |

### Works

| Route                                                           | Status | Spec(s)                                             |
| --------------------------------------------------------------- | ------ | --------------------------------------------------- |
| `/[locale]/(dashboard)/works`                                   | [x]    | works.spec.ts, works-detail.spec.ts                 |
| `/[locale]/(dashboard)/works/new`                               | [x]    | works-detail.spec.ts, zero-friction-flow.spec.ts    |
| `/[locale]/(dashboard)/works/[id]`                              | [x]    | works-detail.spec.ts                                |
| `/[locale]/(dashboard)/works/[id]/activity`                     | [x]    | activity-feed-perwork.spec.ts, activity-log.spec.ts |
| `/[locale]/(dashboard)/works/[id]/deploy`                       | [x]    | screenshot-and-deploy.spec.ts                       |
| `/[locale]/(dashboard)/works/[id]/generator`                    | [x]    | work-generator.spec.ts, works-detail.spec.ts        |
| `/[locale]/(dashboard)/works/[id]/generator/comparisons`        | [x]    | work-generator.spec.ts                              |
| `/[locale]/(dashboard)/works/[id]/generator/comparisons/[slug]` | [x]    | work-generator.spec.ts                              |
| `/[locale]/(dashboard)/works/[id]/generator/history`            | [x]    | work-generator.spec.ts                              |
| `/[locale]/(dashboard)/works/[id]/generator/schedule`           | [x]    | work-generator.spec.ts                              |
| `/[locale]/(dashboard)/works/[id]/items`                        | [x]    | items-import-export.spec.ts                         |
| `/[locale]/(dashboard)/works/[id]/members`                      | [x]    | work-members.spec.ts                                |
| `/[locale]/(dashboard)/works/[id]/plugins`                      | [x]    | plugin-detail-ui.spec.ts, plugins.spec.ts           |
| `/[locale]/(dashboard)/works/[id]/settings`                     | [x]    | settings-extra.spec.ts                              |
| `/[locale]/(dashboard)/works/[id]/settings/budgets-usage`       | [x]    | budgets.spec.ts                                     |
| `/[locale]/(dashboard)/works/[id]/settings/members`             | [x]    | work-members.spec.ts                                |

### Web API routes (Next.js)

| Route                                                    | Status | Spec(s)                                           |
| -------------------------------------------------------- | ------ | ------------------------------------------------- |
| `/api/health`                                            | [x]    | health-meta.spec.ts                               |
| `/api/auth/authorize`                                    | [x]    | oauth-authorize-flow.spec.ts, oauth-state.spec.ts |
| `/api/auth/provider/callback/[providerId]`               | [x]    | oauth-state.spec.ts                               |
| `/api/auth/reset-password`                               | [x]    | password-reset.spec.ts                            |
| `/api/auth/verify-email`                                 | [x]    | auth-providers-list.spec.ts, auth.spec.ts         |
| `/api/chat`                                              | [x]    | chat-api.spec.ts                                  |
| `/api/github-app/callback`                               | [x]    | github-app.spec.ts                                |
| `/api/github-app/setup`                                  | [x]    | github-app.spec.ts                                |
| `/api/oauth/[providerId]/callback`                       | [x]    | oauth-state.spec.ts                               |
| `/api/oauth/[providerId]/callback/plugins`               | [x]    | plugins-readpackages.spec.ts, plugins.spec.ts     |
| `/api/oauth/[providerId]/callback/plugins/read-packages` | [x]    | plugins-readpackages.spec.ts                      |
| `/api/works/[id]/comparisons/generation-status`          | [x]    | work-generator.spec.ts                            |
| `/api/works/[id]/deploy/status`                          | [x]    | screenshot-and-deploy.spec.ts                     |
| `/api/works/[id]/export-items`                           | [x]    | items-import-export.spec.ts                       |
| `/api/works/[id]/import-items`                           | [x]    | items-import-export.spec.ts                       |
| `/api/works/[id]/usage/export`                           | [x]    | budgets.spec.ts                                   |
| `/api/activity-log/[id]`                                 | [x]    | activity-log-export.spec.ts, activity-log.spec.ts |
| `/api/activity-log/export`                               | [x]    | activity-log-export.spec.ts                       |

---

## Cross-cutting concerns

| Concern                               | Status | Spec(s)                     |
| ------------------------------------- | ------ | --------------------------- |
| i18n routing (locale handling)        | [x]    | i18n-locales.spec.ts        |
| Navigation & breadcrumbs              | [x]    | navigation.spec.ts          |
| SEO meta tags                         | [x]    | seo-meta.spec.ts            |
| Accessibility                         | [x]    | accessibility.spec.ts       |
| CORS / preflight                      | [x]    | health-meta.spec.ts         |
| Form validation client-side           | [x]    | forms-validation.spec.ts    |
| OAuth state CSRF                      | [x]    | oauth-state.spec.ts         |
| Public API unauth contract            | [x]    | api-public-contract.spec.ts |
| Concurrent multi-user (collaboration) | [x]    | multi-user-collab.spec.ts   |
| Rate limiting / throttler             | [x]    | rate-limit.spec.ts          |

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

## Pass 3 — this PR (`chore/e2e-coverage-pass-3`)

Closed the 3 remaining hard gaps + deepened every `[~]` row from passes 1–2 + started pass 4+ hardening early. **+13 new spec files.**

- [x] `plugins-readpackages.spec.ts` — read-packages OAuth subflow + main plugin callback deepening + providers/connection endpoints
- [x] `activity-log-export.spec.ts` — `/api/activity-log/export` + `running-count` + `summary` + `:id` + ingest + web route
- [x] `multi-user-collab.spec.ts` — cross-tenant isolation (work / items / API keys / notifications) + invitation smoke
- [x] `auth-providers-list.spec.ts` — `/api/auth/providers` + `/anonymous` + `/claim` + `/profile` + `/profile/fresh` + `/update-password` + `/send-verification` + `/logout` + `/logout-all` + verify-email edges
- [x] `oauth-authorize-flow.spec.ts` — `/api/auth/authorize` web-tier route
- [x] `plugin-detail-ui.spec.ts` — plugin detail per known plugin-id + settings/plugins/[category] per category + works/[id]/plugins
- [x] `sitemap-robots.spec.ts` — sitemap.xml, robots.txt, favicon
- [x] `cors-credentialed.spec.ts` — credentialed preflight on sensitive paths + security headers sanity
- [x] `subscriptions-tiers.spec.ts` — fresh user defaults to free tier + plan switching + unknown code rejection
- [x] `onboarding-deeper.spec.ts` — state GET/PUT lifecycle + catalog endpoints + dismiss/complete transitions
- [x] `webhook-subscriptions.spec.ts` — webhook subscription endpoint probe (skips if not exposed)
- [x] `i18n-content.spec.ts` — login title varies across 6 locales + lang attribute match + unknown-locale fallback
- [x] `template-catalog-deep.spec.ts` — template catalog list/get + customizations + user preferences

## Pass 4 — this PR (`chore/e2e-coverage-pass-4`)

Deep UI driving (using the existing `e2e/.auth/user.json` storageState
from `global-setup.ts`) + early pass-5 hardening. **+12 new spec files.**

- [x] `dashboard-authenticated.spec.ts` — home heading + nav chrome, stats overview, keyboard Tab, /works nav, user menu dropdown
- [x] `work-create-ui-journey.spec.ts` — /works/new form renders, empty submit blocked, full wizard flow → detail URL
- [x] `plugin-toggle-ui.spec.ts` — plugin index rows, detail navigation, toggle / configure affordance present
- [x] `settings-profile-ui.spec.ts` — username pre-populated, save persists across reload, email read-only
- [x] `notifications-bell-ui.spec.ts` — bell in header, click opens dropdown / panel
- [x] `audit-log-immutable.spec.ts` — PATCH/PUT/DELETE on activity-log entries all rejected, stranger can't mutate
- [x] `security-2fa.spec.ts` — 2FA status / enroll endpoint probe across 5 candidate paths (skips when not exposed)
- [x] `performance-budget.spec.ts` — login + register load-time SLO, request-count ceiling
- [x] `theme-toggle.spec.ts` — `<html>` carries a theme indicator, toggle flips it
- [x] `responsive-viewports.spec.ts` — login page across mobile/tablet/desktop, no horizontal overflow, CTA on-screen
- [x] `error-recovery.spec.ts` — `/works` doesn't white-screen on API 503, bell survives 500, login shows error on 401 (route-mocking)
- [x] `keyboard-navigation.spec.ts` — Tab/Shift+Tab order on login form, Escape closes menu
- [x] `api-schema-validation.spec.ts` — canonical user / works-list / health shape, typed field checks (no null timestamps, non-empty ids)
- [x] `session-persistence.spec.ts` — reload + cross-page nav + new tab keep session; HttpOnly cookie present

Auth project routing — `playwright.config.ts` testIgnore now also
excludes `performance-budget`, `responsive-viewports`, `error-recovery`,
and `keyboard-navigation` from the storageState project so they run
with a fresh, unauthenticated context.

## Pass 5 — this PR (`chore/e2e-coverage-pass-5`)

Long-tail hardening + cross-cutting concerns. **+13 new spec files.**

- [x] `download-export.spec.ts` — `/api/account/export`, `/api/activity-log/export` (+ workId filter), `/api/works/:id/usage/export` (incl. stranger isolation)
- [x] `upload-import.spec.ts` — `/api/account/import/preview` + `/apply`, `/api/works/:id/import-items` (empty + minimal item + stranger isolation)
- [x] `concurrent-actions.spec.ts` — same-user parallel API contexts (read consistency, create visibility, two simultaneous POSTs don't 5xx)
- [x] `i18n-fallback.spec.ts` — unknown `/xx/login` locale falls back, root path redirects to a default locale, `<html lang>` matches URL locale
- [x] `print-styles.spec.ts` — `emulateMedia({ media: 'print' })` keeps text content + submit buttons present on login + register
- [x] `clipboard-actions.spec.ts` — copy affordance on `/settings/api-keys`, clipboard `writeText` hook fires when a copy button is clicked
- [x] `security-headers-strict.spec.ts` — API nosniff + frame-options + no x-powered-by + referrer-policy; web clickjacking defense via XFO or `frame-ancestors`
- [x] `rate-limit-deeper.spec.ts` — per-endpoint isolation (register throttle doesn't block /health), login throttle on wrong passwords, 429 body shape
- [x] `subscriptions-plan-lifecycle.spec.ts` — fresh user = free, switch free → standard → free walkthrough, /plans advertises a paid tier, bogus code → 4xx
- [x] `data-sync-idempotency.spec.ts` — GET key-set stable across repeated calls, repeated POST stays in same status family
- [x] `public-pages-cache.spec.ts` — Cache-Control on /en/login + root, no long-term public caching of login
- [x] `chat-api-streaming.spec.ts` — auth gate, malformed payload 4xx, content-type signals streaming or JSON
- [x] `screenshots-visual.spec.ts` — visual-regression baselines for login / register / forgot-password (opt-in via `RUN_VISUAL_REGRESSION=1`; first run with `--update-snapshots`)

Auth project routing — `playwright.config.ts` testIgnore + testMatch
now also exclude `i18n-fallback`, `print-styles`, `public-pages-cache`,
and `screenshots-visual` from the storageState project so they run
fresh-context.

## Pass 6 — this PR (`chore/e2e-coverage-pass-6`)

Security + protocol hardening + boundary checks. **+10 new spec files.**

- [x] `webhook-signature.spec.ts` — github-app webhook HMAC validation (missing + bogus signature both rejected, signature never echoed back)
- [x] `pagination.spec.ts` — `/api/works`, `/api/notifications`, `/api/activity-log` honour `?limit=1` + `?offset` without 5xx
- [x] `sort-filter.spec.ts` — `?sort=name`, `?sort=-createdAt`, SQL-injection-style sort, `?status=...`, `?actionType=...` all respond < 500
- [x] `large-payload.spec.ts` — 100 KB description accepted, 50 MB rejected with 4xx, huge query string rejected, 10K bulk items handled
- [x] `oauth-state-replay.spec.ts` — random/unconsumed state → 4xx, callback without state → 4xx, two identical bogus callbacks both fail, two `/connect/url` calls return different state values
- [x] `password-policy.spec.ts` — weak passwords rejected (length, complexity, common-passwords, empty, all-spaces), strong password works, update-password requires current password
- [x] `account-deletion-flow.spec.ts` — probe 4 candidate delete-account paths, danger-zone UI page exposes destructive copy
- [x] `email-verification-flow.spec.ts` — fresh user is unverified, send-verification responds < 500 (rate-limit OK), verify-email rejects bogus / empty tokens, validate-email-token never echoes the candidate token (H-01 contract)
- [x] `password-reset-uniformity.spec.ts` — H-03 timing-uniformity (real vs bogus email within 3x mean), forgot-password ALWAYS returns 200/202 regardless of existence (no enumeration leak)
- [x] `error-page-contract.spec.ts` — `/en/not-existent-route` → 404 page with home link, `/en/auth/error` renders, invalid `?error=BogusError` on `/en/login` doesn't crash

Routing — `playwright.config.ts` testIgnore + testMatch now also exclude `error-page-contract` from the storageState project so unauth UI assertions actually hit unauth pages.

## Pass 7 — this PR (`chore/e2e-coverage-pass-7`)

Long-tail security + protocol + collation. **+10 new spec files.**

- [x] `csp-strict.spec.ts` — API + web Content-Security-Policy: no `script-src *`, `object-src 'none'`, `frame-ancestors 'none'|'self'`, web sets some CSP
- [x] `chat-api-events.spec.ts` — streaming chat uses `data:` / `event:` framing or NDJSON, ends with a completion sentinel
- [x] `git-providers-oauth-happy.spec.ts` — `/api/oauth/providers` shape, `/connect/url` returns github.com URL with embedded state, `/connection` fresh-user is disconnected, disconnect is idempotent
- [x] `audit-log-sequences.spec.ts` — PATCH → GET preserves entry (no tamper leak), DELETE → GET still lists, replay PATCH stays in same status family
- [x] `multi-user-invitation.spec.ts` — owner POST + list invitations happy path, stranger isolated from invite list + create, members CRUD smoke, owner shows up as OWNER in members
- [x] `bulk-operations.spec.ts` — probe 4 bulk-op candidate paths, notifications read-all clears unread-count, work-scoped /items/bulk-\* respond < 500
- [x] `search-fts.spec.ts` — `?q=` filters /api/works, SQL-injection-style payload responds < 500, very long query doesn't crash
- [x] `unicode-collation.spec.ts` — emoji / RTL Arabic / Han / cyrillic+combining / surrogate-pair italic survive create → list → read byte-for-byte
- [x] `concurrent-conflict.spec.ts` — two parallel PUTs land at A or B (no frankenstein merge), partial PATCHes don't 5xx, owner+stranger race rejects stranger's write
- [x] `slug-collision.spec.ts` — same-owner duplicate slug → 409 or auto-disambiguated (never silent shadow), cross-owner duplicate handled cleanly, slug rename responds < 500

Routing — `playwright.config.ts` testIgnore + testMatch now also exclude `chat-api-events` and `csp-strict` from the storageState project so their unauth assertions actually hit unauth surfaces.

## Pass 8 — this PR (`chore/e2e-coverage-pass-8`)

Observability + accessibility + protocol-shape coverage. **+10 new
spec files.**

- [x] `web-vitals.spec.ts` — inject web-vitals via CDN, measure LCP / FCP / CLS on login + register with loose CI-friendly ceilings (LCP 8s, FCP 6s, CLS 0.5)
- [x] `playwright-trace.spec.ts` — golden-path trace recording for regression triage (artifact-only — login → dashboard → works → settings)
- [x] `pwa-offline.spec.ts` — service worker registration is queryable, /manifest.webmanifest reachable, /sw.js reachable (skips when not registered)
- [x] `internationalization-rtl.spec.ts` — `/ar/` / `/he/` / `/fa/` / `/ur/` carry `dir="rtl"`, `/en/` stays `ltr`, locale flip back to en doesn't blank the page
- [x] `accessibility-axe-deep.spec.ts` — axe-core injected via CDN against login + register, serious+ violations bounded below 10, color-contrast violations ≤ 3
- [x] `csv-export-schema.spec.ts` — activity-log + usage CSV header rows contain recognised column families; no PII (email, token) in header row
- [x] `oauth-consent-screen.spec.ts` — github authorize URL has client_id + redirect_uri + scope + response_type=code + state; redirect_uri is https in prod-shaped URLs; redirect_uri belongs to localhost or \*.ever.works (no external redirector)
- [x] `rate-limit-headers.spec.ts` — successful requests carry `X-RateLimit-Limit`/`Remaining`/`Reset`, remaining never increases between consecutive calls, 429 carries Retry-After (numeric or HTTP-date)
- [x] `dropdown-keyboard.spec.ts` — ArrowDown moves focus inside an opened menu, Escape closes it, Enter on a menu item produces a visible effect
- [x] (deferred) `audit-log-fixture` — direct DB introspection lives in `/apps/api/test` integration suite, not in black-box e2e; tracked as long-tail.

Routing — `playwright.config.ts` testIgnore + testMatch now also exclude `web-vitals`, `pwa-offline`, `internationalization-rtl`, and `accessibility-axe-deep` from the storageState project so their unauth UI assertions hit fresh contexts.

## Pass 9 — this PR (`chore/e2e-coverage-pass-9`)

Infra integration + content-handling + observability. **+10 new spec
files.**

- [x] `image-uploads.spec.ts` — probe 4 upload paths, 1x1 PNG accepted, non-image content-type rejected without 5xx, stranger can't upload to another's work
- [x] `notification-channels.spec.ts` — preferences endpoint requires auth, returns channel-shaped object, malformed PATCH 4xx, fresh user has SOME default channel enabled
- [x] `webhook-delivery-retry.spec.ts` — webhook subscription rejects bogus URL + `javascript:` URL (SSRF guard), `/deliveries` endpoint exists and gates auth
- [x] `feature-flags-runtime.spec.ts` — config endpoint JSON object, stable across calls, no `DATABASE_URL`/`JWT_SECRET`/etc leakage, authed sees ≥ unauth keys
- [x] `slow-route-pagination.spec.ts` — `/api/works` with 25 owned rows under 30s, `/api/notifications` under load, 3-call degradation ratio < 5x
- [x] `realtime-events.spec.ts` — probe 5 SSE candidate paths + 3 WS paths, content-type signals streaming, WS upgrade attempt over plain GET returns 4xx
- [x] `bullmq-queue-status.spec.ts` — queue-status endpoint requires admin auth (regular user does NOT get queue admin shape), `/api/health` doesn't report Redis/BullMQ subsystem as down
- [x] `redis-cache-coherency.spec.ts` — create → list, rename → detail + list, profile update → /profile/fresh all reflect new state immediately (no stale cache)
- [x] `sentry-error-reporting.spec.ts` — Sentry tunnel path accepts envelope without 5xx, never echoes the DSN, login page doesn't preemptively capture events
- [x] `terms-acceptance-flow.spec.ts` — fresh user has terms acceptance timestamp set (when exposed), accept-terms endpoint requires auth, accept-terms is idempotent, /en/terms page renders

Routing — `playwright.config.ts` testIgnore + testMatch now also exclude `sentry-error-reporting` from the storageState project so its unauth `/en/login` Sentry-event assertion measures the unauth case.

## Pass 10 — this PR (`chore/e2e-coverage-pass-10`)

Mobile + admin + enterprise features. **+10 new spec files.**

- [x] `mobile-touch.spec.ts` — iPhone 13 + Pixel 7 viewport, tap → fill → readback, submit reachable without horizontal scroll, viewport meta has width=device-width
- [x] `pdf-export.spec.ts` — probe 5 PDF candidate paths, owner gets %PDF- magic bytes, stranger isolated (401/403/404)
- [x] `email-template-render.spec.ts` — preview endpoint requires admin (regular user 401/403), no unresolved `{{handlebars}}` markers in rendered body
- [x] `recovery-codes.spec.ts` — 4 candidate paths, without 2FA enrolled returns 4xx (not silent 200), POST regenerate also 4xx without 2FA
- [x] `magic-link.spec.ts` — issuance always 2xx/204 (no email-existence signal), timing-uniformity 5x ratio between known/unknown emails, redemption with bogus/empty token 4xx
- [x] `sso-saml.spec.ts` — metadata XML shape, init returns redirect or 4xx, ACS rejects bogus SAMLResponse, providers list returns array
- [x] `team-billing.spec.ts` — unauth teams/orgs gates, stranger cannot read billing of unowned team (401/403/404), team-invitation listing requires auth
- [x] `usage-quota.spec.ts` — usage endpoint requires auth, numeric shape for fresh user with no negative cost/usage values, hammering create-work N times never produces 5xx
- [x] `audit-export-sanitization.spec.ts` — activity-log + account + usage exports never carry secret patterns (bcrypt/argon2/scrypt hashes, JWT, AWS/Google/Stripe/GitHub/OpenAI key prefixes), cross-tenant id/email isolation
- [x] `share-links.spec.ts` — owner creates share returns ref (url/token/id), stranger cannot create on owner's work, DELETE auth-gated, public consumption endpoint reachable unauthed

Routing — `playwright.config.ts` testIgnore + testMatch now also exclude `mobile-touch` from the storageState project so the iPhone/Pixel device viewports actually hit the unauth login form.

## Pass 11 — this PR (`chore/e2e-coverage-pass-11`)

UX polish + infra-shape probes. **+10 new spec files.**

- [x] `localization-strings.spec.ts` — every non-en locale has parity with en, no `[MISSING]` / `[TODO]` / `FIXME-i18n` placeholders, en baseline has > 20 keys
- [x] `worker-job-failure.spec.ts` — generation on non-existent work returns 4xx (not 5xx), activity-log status enum sanity, repeated invalid-job POSTs don't deadlock
- [x] `database-migration-safety.spec.ts` — /api/health doesn't report db subsystem down, /api/health/db (if exposed) carries migration metadata, 10x health hammer no 5xx
- [x] `cron-schedules.spec.ts` — work-schedule endpoint < 500, bogus cron rejected (4xx not 5xx), cron-like fields are syntactically parseable
- [x] `webrtc-permissions.spec.ts` — /en/login and /en/register don't preemptively call getUserMedia / getDisplayMedia, Permissions-Policy doesn't grant camera/microphone/geolocation=\*
- [x] `tour-onboarding-replay.spec.ts` — `?tour=1`, `?onboarding=replay`, `?welcome=1`, `?showTour=true` all render without 5xx + non-empty body
- [x] `dark-mode-pinned.spec.ts` — localStorage-pinned dark theme survives reload, html carries theme markers before first paint (FOUC guard), new tab inherits pinned theme
- [x] `breadcrumbs-deep.spec.ts` — /settings/\* + works detail subroutes expose either a breadcrumb landmark OR a link back to parent
- [x] `keyboard-shortcuts.spec.ts` — `/`, `?`, `Ctrl+K` and `Escape` all leave the page chrome rendering (no crash on unknown hotkeys)
- [x] `tooltip-hover.spec.ts` — hovering a tooltip trigger renders a `[role="tooltip"]`, Escape doesn't break the page

Routing — `playwright.config.ts` testIgnore + testMatch now also exclude `webrtc-permissions` from the storageState project so its unauth /en/login getUserMedia probe measures the unauth case.

## Pass 12 — this PR (`chore/e2e-coverage-pass-12`)

Web bundle + browser security boundaries. **+10 new spec files.**

- [x] `bundle-size-budget.spec.ts` — `_next/static/*` aggregate < 5 MB, < 100 JS chunks, no single chunk > 2 MB
- [x] `service-worker-update.spec.ts` — `getRegistrations` callable, `update()` doesn't crash, reload survives SW
- [x] `polyfill-presence.spec.ts` — no core-js / regenerator-runtime / babel-polyfill / es5-shim scripts, ≤ 5 nomodule scripts, Promise/fetch/Object.assign native
- [x] `xss-html-encoding.spec.ts` — `<script>` in work name doesn't crash, response is JSON not HTML, login page never echoes executable `alert(1)`
- [x] `csv-injection.spec.ts` — `=cmd|...`, `+sum(...)`, `-cmd|...`, `@SUM(...)` payloads escaped/prefixed in CSV exports
- [x] `sql-where-clause-injection.spec.ts` — 8 payloads × 6 param keys never 5xx, UNION-style doesn't leak cross-tenant rows, POST body SQLi also < 500
- [x] `tls-version-header.spec.ts` — production HSTS posture (skip on http), Server header no `nginx/1.18.0`-style versions, X-Powered-By stripped
- [x] `cookie-rotation.spec.ts` — update-password: new password works, OLD password rejected post-rotation
- [x] `device-fingerprinting-opt-out.spec.ts` — DNT=1 + Sec-GPC=1 → no PostHog/Clarity/GA/DoubleClick/Segment/Amplitude/Mixpanel/FullStory/Hotjar requests on /en/login
- [x] `redirect-prevention.spec.ts` — `?next/redirect/returnTo/continueTo/callbackUrl` × 5 evil targets don't land off-origin, OAuth callback no 3xx to attacker, `javascript:` blocked

Routing — `playwright.config.ts` testIgnore + testMatch now also exclude `bundle-size-budget`, `service-worker-update`, `polyfill-presence`, `xss-html-encoding`, `device-fingerprinting-opt-out`, `redirect-prevention`, and `tls-version-header` from the storageState project so their unauth UI assertions hit fresh contexts.

## Pass 13 — this PR (`chore/e2e-coverage-pass-13`)

Realtime + i18n + browser hygiene. **+10 new spec files.**

- [x] `realtime-collaboration.spec.ts` — rename in one context visible to the next GET, parallel renames produce deterministic final state, 3 parallel create-work all show in list
- [x] `time-zone-rendering.spec.ts` — Asia/Tokyo + America/Los_Angeles render distinct timestamps (no ISO leak in visible text), `Intl.DateTimeFormat(navigator.language)` no raw ISO
- [x] `referrer-policy-redirects.spec.ts` — external `target=_blank` links carry `rel=noopener noreferrer`, Referrer-Policy header in safe set (no-referrer / strict-origin / same-origin / strict-origin-when-cross-origin)
- [x] `cors-preflight-cache.spec.ts` — Access-Control-Max-Age in [300s, 86400s], no `Allow-Headers='*'` with `Allow-Credentials=true`, preflight returns 200/204
- [x] `clock-skew-tolerance.spec.ts` — access_token works immediately on register (no nbf future-reject), 5 consecutive uses don't 401, server `Date` header within 5 min of test runner
- [x] `static-asset-fingerprint.spec.ts` — `_next/static/*` URLs are hashed (>50%), >70% carry `max-age >= 3600`
- [x] `hydration-no-errors.spec.ts` — /en, /en/works, /en/settings each emit ≤1 hydration warning + ≤1 pageerror in console
- [x] `feature-detect-storage.spec.ts` — login page survives `localStorage.setItem` throwing, `getItem` throwing, `sessionStorage.setItem` throwing
- [x] `error-boundary-isolation.spec.ts` — `/works/non-existent` + `/works/non-existent/items` render without nuking shell, /works with API 503 still shows nav
- [x] `iframe-sandbox.spec.ts` — cross-origin iframes on /en/login + /en/register + /en carry `sandbox` attribute (not `allow-scripts allow-same-origin` combo), no `camera=* | microphone=* | payment=* | geolocation=*` allow attributes

Routing — `playwright.config.ts` testIgnore + testMatch now also exclude `referrer-policy-redirects`, `static-asset-fingerprint`, `feature-detect-storage`, and `iframe-sandbox` from the storageState project so their unauth UI assertions hit fresh contexts.

## Pass 14 — this PR (`chore/e2e-coverage-pass-14`)

Service boundary + observability + transport security. **+10 new spec
files.**

- [x] `service-isolation.spec.ts` — work-create doesn't regress /api/notifications shape, /api/health hits don't consume auth throttler bucket, profile id/email byte-stable across unrelated module writes
- [x] `metrics-endpoint.spec.ts` — `/api/metrics` returns text/plain (not JSON) when exposed, carries `# HELP` + `# TYPE` directives + one canonical Prometheus series
- [x] `graphql-introspection.spec.ts` — `/graphql` / `/api/graphql` either 404, reject introspection 4xx, return GraphQL errors, or empty schema — never a populated `__schema.types` array in production
- [x] `connection-pool-leak.spec.ts` — 50 sequential authed /profile hits maintain ≥48/50 success rate, 20 parallel /api/health bursts ≤1 5xx
- [x] `idempotency-keys.spec.ts` — POST /api/works with same `Idempotency-Key` retry stays < 500, empty key not 5xx
- [x] `content-security-violations.spec.ts` — one of `/api/csp-report` / `/api/reports/csp` / `/api/security/csp-violations` accepts application/csp-report POST without 5xx; CSP report-to/report-uri presence soft-warns
- [x] `secure-cookies-on-https.spec.ts` — auth cookies carry HttpOnly, carry Secure on https, carry SameSite=Lax/Strict/None — skip http for Secure
- [x] `password-history.spec.ts` — rotating BACK to original password is either 4xx (history enforced) or informational (policy off); update-password without current_password rejected 4xx
- [x] `api-version-header.spec.ts` — `/api/health` exposes a version via X-API-Version/X-Version/body version field that looks semver/sha/date-shaped; stable across calls
- [x] `signed-url-expiry.spec.ts` — when a signed-URL endpoint exists, the URL carries `Expires=` / `X-Amz-Expires=` / `?exp=` / `?expires_in=` / `token=` / `signature=` marker; unauth GET on upload-url path is auth-gated 401/403/404

## Pass 15 — this PR (`chore/e2e-coverage-pass-15`)

Replication coherency + multi-tenant isolation + observability tracing. **+10 new spec files.**

- [x] `db-readonly-replica.spec.ts` — write-then-read coherency: new work observable on /api/works within 5s; 5 rapid reads share ≥1 common id (no replica-lag-induced drift)
- [x] `feature-flag-runtime-toggle.spec.ts` — config/flag endpoint returns stable JSON, never leaks DB_URL/JWT_SECRET-shape keys, unauthed payload ≤ authed keys
- [x] `webhook-redelivery.spec.ts` — deliveries listing endpoint auth-gated (401/403/404 unauth) and returns JSON < 500; redeliver on bogus id never 5xx
- [x] `multi-tenant-data-leak.spec.ts` — `?owner=`/`?tenant=`/`?org_id=` × 7 param shapes never leak Alice's work to Bob; direct GET on Alice's work id is 401/403/404 for Bob
- [x] `oauth-pkce.spec.ts` — github connect/url either carries `code_challenge` (43-128 chars) + `code_challenge_method=S256` OR informational skip; two calls produce distinct verifiers
- [x] `audit-tamper-resistance.spec.ts` — PATCH rejection never echoes tamper payload back; 5x PATCH burst leaves first-id stable and row count non-decreasing
- [x] `backup-restore-noop.spec.ts` — /api/health backup metadata (when exposed) carries ISO timestamp ≤ 7 days old; informational skip when not surfaced
- [x] `cloud-sdk-headers.spec.ts` — no `x-aws-request-id` / `x-cloud-provider` / Lambda fingerprint headers; Server header doesn't leak SDK; 5× bogus User-Agent strings (shell injection, CRLF, null bytes) stay < 500
- [x] `webhook-secret-rotation.spec.ts` — rotate-secret endpoint auth-gated (401/403/404 unauth) and < 500 authed; response never echoes bcrypt/argon2 hash format
- [x] `request-id-tracing.spec.ts` — /api/health generates request-id ≥ 8 chars; client-supplied X-Request-ID either echoed or informational; two consecutive requests get distinct ids

## Pass 16 — queued

- [ ] `worker-retry-budget.spec.ts` — failed jobs respect a max-retry ceiling; runaway retries don't 5xx the queue API
- [ ] `cron-drift-tolerance.spec.ts` — cron job `nextRunAt` advances monotonically after triggers; drift < 60s between expected vs observed
- [ ] `cors-origin-allowlist.spec.ts` — preflight from `https://evil.example` is rejected; preflight from `*.ever.works` is allowed
- [ ] `cookie-flags-on-logout.spec.ts` — POST /logout sends Set-Cookie with Max-Age=0 / Expires in past
- [ ] `error-detail-leak.spec.ts` — 5xx response bodies don't include stack traces / file paths / DB error codes verbatim
- [ ] `notification-spam-throttle.spec.ts` — generating many notifications doesn't exceed a per-minute throttle
- [ ] `time-window-coercion.spec.ts` — endpoints accepting `from`/`to` reject inverted ranges (from > to) with 4xx not 5xx
- [ ] `archive-soft-delete.spec.ts` — soft-deleted entities are excluded from default listings but reachable via `?archived=1` (or skip if not modeled)
- [ ] `usage-export-pii-isolation.spec.ts` — usage export never includes another tenant's user IDs / emails
- [ ] `image-resize-bounds.spec.ts` — image-resize endpoint rejects extreme width/height (10000×10000+) with 4xx not 5xx; tiny dimensions (1×1) accepted

## Pass 15+ — long-tail / hardening

Then iteratively tighten any `[x]` that still has thin assertions
(the `expect(...).toBeLessThan(500)` smoke pattern should be replaced
with specific shape assertions once the body schemas stabilize).
Candidates:

- [ ] `chat-api-events` — pin EXACT SSE event names when the LLM provider is configured, instead of permissive "any framing"
- [ ] `bulk-operations` — once endpoints exist, pin exact `{affected, errors}` shape
- [ ] `slug-collision` — pin per-error response shape (`{code: "slug_taken"}` style)
- [ ] `search-fts` — verify search-result ordering when relevance scoring is enabled
- [ ] `accessibility-axe-deep` — extend to authenticated dashboard pages once axe-core stability is confirmed in CI

---

## How to extend

1. Pick a `[ ]` row.
2. Add a new spec file under `apps/web/e2e/<name>.spec.ts` using the API helpers in `helpers/`.
3. Flip the row to `[x]` (or `[~]` if partial) and add the spec filename.
4. PR to `develop`; CI runs E2E on develop / stage / main pushes.

The existing helper `helpers/api.ts` registers users, logs them in, and creates works. Use it for fast unauthenticated-only or fast-setup tests. Reach for full UI driving only when the test is about UI behavior.
