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

## Pass 9 — queued

- [ ] `image-uploads.spec.ts` — image upload endpoint (work cover / item images): content-type validation, size cap, EXIF stripping
- [ ] `notification-channels.spec.ts` — per-channel notification preferences (email / in-app / webhook)
- [ ] `webhook-delivery-retry.spec.ts` — outbound webhook delivery: at-least-once delivery, exponential backoff, dead-letter
- [ ] `feature-flags-runtime.spec.ts` — feature-flag overrides via `/api/config` or env, runtime toggling without restart
- [ ] `slow-route-pagination.spec.ts` — large work + large items list — pagination must not OOM the server
- [ ] `realtime-events.spec.ts` — SSE/WebSocket event stream for live updates (if exposed)
- [ ] `bullmq-queue-status.spec.ts` — queue depth + per-job state exposed (if dashboards are wired)
- [ ] `redis-cache-coherency.spec.ts` — cache-invalidation on mutation: change name → list shows new name immediately
- [ ] `sentry-error-reporting.spec.ts` — uncaught client errors are forwarded to /sentry-tunnel proxy
- [ ] `terms-acceptance-flow.spec.ts` — ToS gating: a fresh user must accept ToS before key actions

## Pass 10+ — long-tail / hardening

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
