# Coverage Tracker — Tests, Docs, Specs

> **Purpose**: track 100%-coverage progress for the Ever Works platform across
> tests (unit/e2e), docs, and specs. Maintained by the hourly
> `platform-tests-and-docs` scheduled task so successive runs do not duplicate
> work and nothing is missed.
>
> **Source of truth ordering**: this file > existing CLAUDE.md > AGENTS.md.
> When a task is shipped (PR merged), the corresponding row is moved to the
> "Done" section with the merged PR link.

## How an hourly run uses this file

1. Read this tracker first.
2. Pick the next item from "Pending — High Priority", or fall back to the next
   "Pending — Medium / Low" item if all high-priority is in flight.
3. Open a feature branch, ship in one PR, merge to `develop` (no waiting for
   review — the scheduled task is authorized to merge per the task spec).
4. Update this file in the same PR (move the item to "Done", add the PR link,
   record any follow-ups discovered).

## Inventory snapshot (2026-05-07)

- **Spec files (`*.spec.ts`)**: ~419 across `apps/` + `packages/`
- **Playwright e2e suites**: 31 in `apps/web/e2e/`
- **API source spec count**: only **9** specs inside `apps/api/src/` —
  most modules rely on e2e + agent-package tests instead.
- **Spec Kit features (`docs/specs/features/`)**: 24 directories.
- **Plugins with ZERO unit tests (14)**:
  `brave`, `brightdata`, `comparison-generator`, `exa`, `firecrawl`, `github`,
  `jina`, `linkup`, `local-content-extractor`, `perplexity`, `scrapfly`,
  `serpapi`, `tavily`, `valyu`.
- **Internal packages with ZERO tests**: `contracts`, `monitoring`,
  `cli-shared`, `tasks`.

## Done

| Date       | Area                              | PR                                                        | Notes                                                                                                                                                                                                                                                                                                                 |
| ---------- | --------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-05-07 | Search plugins zero-coverage      | [#471](https://github.com/ever-works/ever-works/pull/471) | brave (25 tests), linkup (27), tavily (26), valyu (29) — 107 new unit tests; mock fetch / SDK; cover metadata, settings, search, extract (where applicable), validateConnection, lifecycle, healthCheck, manifest.                                                                                                    |
| 2026-05-07 | Search plugins zero-coverage (b2) | [#472](https://github.com/ever-works/ever-works/pull/472) | exa (30 tests), perplexity (22), serpapi (22), firecrawl (28) — 102 new unit tests; same coverage shape as batch 1.                                                                                                                                                                                                   |
| 2026-05-07 | Plugin coverage (b3)              | [#473](https://github.com/ever-works/ever-works/pull/473) | jina (25 tests), comparison-generator (12), brightdata (28), scrapfly (26) — 91 new unit tests; covers remaining zero-coverage search plugins plus utility (comparison-generator) and content-extractor (scrapfly).                                                                                                   |
| 2026-05-07 | Plugin coverage (b4)              | [#474](https://github.com/ever-works/ever-works/pull/474) | local-content-extractor (20 tests, axios mock), github (20 tests, fetch + libsodium mock for OAuth flow) — 40 new unit tests; closes the high-priority zero-coverage plugin list.                                                                                                                                     |
| 2026-05-07 | cli-shared first coverage         | [#475](https://github.com/ever-works/ever-works/pull/475) | Scaffolds vitest in `packages/cli-shared` and adds 27 unit tests (slug-utils 13 + validation-utils 14) covering slugify, validateSlug, generateIncrementedSlug, validateUrl, validateEmail, validateGitUsername, validateApiKey, validateModelName.                                                                   |
| 2026-05-07 | cli-shared utils extended         | [#476](https://github.com/ever-works/ever-works/pull/476) | Adds 25 more unit tests in `cli-shared`: config-check (10) covers maskSecret edge cases (incl. <8 char short-circuit and boundary at exactly 8) plus displayConfigurationError/Warnings; generator-steps (15) covers getStepText, getStepProgress, getDynamicStepText, getDynamicStepProgress, getItemsProcessedText. |
| 2026-05-07 | cli-shared prompt services        | [#477](https://github.com/ever-works/ever-works/pull/477) | Adds 64 unit tests for `BasePromptService` (45) and `WorkPromptService` (19). Base covers display helpers and all validators (URL, email, git username, API key, model name, slug, temperature, max tokens, git name, slugifyName). Work covers generateIncrementedSlug, formatRoleLabel, formatSelectedWork, promptWorkSelection, promptSlugConflictResolution, promptGitProviderSelection, promptDeployProviderSelection, promptWorkCreation — inquirer mocked via vi.mock. |
| 2026-05-07 | monitoring first coverage         | [#478](https://github.com/ever-works/ever-works/pull/478) | Scaffolds jest in `packages/monitoring` and adds 72 unit tests across PostHog/Sentry config, services, and interceptors. PostHog config (9), Sentry config (12), AnalyticsService (15), SentryService (20), SentryInterceptor (8), PostHogInterceptor (5). Sentry SDK and posthog-node are mocked at module scope; production-vs-dev sample rates and the /auth filter on `beforeSend`/`beforeSendTransaction` are both covered. |
| 2026-05-07 | contracts first coverage          | [#479](https://github.com/ever-works/ever-works/pull/479) | Scaffolds vitest in `packages/contracts` (with `typecheck` mode for `.spec-d.ts` fixtures) and adds 57 tests: github runtime helper `parseGitHubRepositoryUrl` (10), `isTerminalOnboardingStatus` + `ONBOARDING_TERMINAL_STATUSES` (10), `DomainType` enum (2), and a 35-assertion type-level fixture using `expectTypeOf` that pins the public surface (item / domain / form / github / api/onboarding) so accidental contract regressions fail at type-check. |
| 2026-05-07 | tasks first coverage              | [#481](https://github.com/ever-works/ever-works/pull/481) | Scaffolds vitest in `packages/tasks` and adds 61 tests across 4 suites: `LocalPluginStore` (16) — in-memory CRUD/upsert/findEnabled; `TriggerLogger` (18) — message/context/Error/data extraction across log/error/warn/debug/verbose/fatal + setLogLevels no-op; `TriggerService` (19) — dispatchWorkGeneration / cancelWorkGeneration / dispatchWorkImport with `@trigger.dev/sdk` configure+runs+task mocked, supported-machine matrix; `collectPluginDependencies` (8) — fs-mocked manifest discovery, workspace/@ever-works skip rules, dedup + sort. Excludes spec files and `vitest.config.ts` from the tsc build. |
| 2026-05-07 | api activity-log first coverage   | [#482](https://github.com/ever-works/ever-works/pull/482) | Adds 34 unit tests for `apps/api/src/activity-log/`: `JitsuService` (9) — env-driven enable/disable, object/array/null metadata handling, optional `workId`/`details`; `ActivityLogListener` (25) — every `@OnEvent` handler (work-created, generation-completed with new/in-progress entry branches and history fallback, works-config sync failure, user signup, user confirmed with provider fallback, password changed, member invited, deployment dispatched/completed/failed with URL fallback and CANCELED→cancelled mapping). Mocks `@ever-works/agent/{activity-log,database,events,entities}` plus `../events` to avoid the agent runtime tree. |
| 2026-05-07 | api account + ai-conversation     | [#484](https://github.com/ever-works/ever-works/pull/484) | Adds 70 unit tests across `apps/api/src/account/` (14 — `AccountController` covering all 9 endpoints: export with includeSecrets parsing, import preview/apply with default-`[]` resolutions, sync status/configure/push/pull/applyPull/remove) and `apps/api/src/ai-conversation/` (56 — `ConversationController` 16, `ConversationTitleService` 15, `OpenAiCompatController` 4, `OpenAiCompatService` 21). Highlights: title auto-generation gating (msg count, aiTitle metadata, fallback when work lookup fails), summary windowing (last 4 user/assistant only, 200-char cap per message), OpenAI-compat DTO→internal mapping (model="auto"→undefined, tool_calls, tool_call_id, name passthrough, null content), SSE streaming + tool_call delta passthrough (id/type/name only on first chunk), and the sanitizeErrorMessage redaction path (sk-/Bearer tokens stripped, 300-char truncation, non-Error fallback). |
| 2026-05-07 | api auth (api-key + auth.service) | [#486](https://github.com/ever-works/ever-works/pull/486) | Adds 60 unit tests across `apps/api/src/auth/services/`: `ApiKeyService` (15) — 10-key cap, past-expiry rejection, `ew_live_` prefix + sha256 hashing, unique-key generation, validateKey expiry semantics + fire-and-forget `updateLastUsed`; `AuthService` (45) — assertCanRegister, validateSocialUser (new-user creation w/ trusted-email confirmation emit, unverified-email gating w/ provider-link bypass, suspended-account rejection, upsertProviderAccount field mapping incl. defaults), sendVerificationEmail (24h expiry + callback-URL token-append-vs-default), verifyEmail, forgotPassword (1h expiry, callback-URL handling, generic-message safety on unknown email), getUserByPasswordResetToken, consumePasswordResetToken, getUserProfile (sensitive-field stripping, github repo-scope gating, expired-token filtering), updateUserProfile (selective updates, committer-field clearing), validate{Email,Password}Token. Mocks `@ever-works/agent/{database,entities}` to avoid the agent runtime tree. |
| 2026-05-07 | api mail providers                | [#492](https://github.com/ever-works/ever-works/pull/492) | Adds 16 unit tests across `apps/api/src/mail/providers/`: `FakerMailerService` (2) — debug log shape + undefined-recipient tolerance; `MailerService` (14) — SMTP path (single recipient, mixed string+Address array log format, `to=unknown` log when omitted, object-without-`address`-key falls through to `toString`), Resend path (no client → faker fallback w/ warn, html-string body, Buffer html / Buffer text / empty body, Handlebars template via `fs.readFile` w/ correct path + `utf8` opts, undefined `result.data?.id` → `id=unknown`, documents the existing unguarded `getDestination(undefined)` bug in resend.emails.send), faker fallback for `MAILER_PROVIDER` unset / `none`, and constructor `Mailer service initialized with provider:` log via `Logger.prototype` spy. Mocks `fs/promises.readFile` at module scope. |
| 2026-05-07 | api notifications module          | [#490](https://github.com/ever-works/ever-works/pull/490) | Adds 14 unit tests across `apps/api/src/notifications/`: `NotificationsController` (10) — getNotifications (limit cap at 100, equal-to-cap, undefined category passthrough), getUnreadCount, getPersistentNotifications, markAsRead (success + error propagation), markAllAsRead, dismiss (success + persistent-rejection error propagation); `NotificationCleanupService` (4) — runExclusive key/ttl/onLocked debug log, happy-path cleanup logging "expired/dismissed/old" counts, error swallowing on cleanup failure, no-op when locked. Mocks `@ever-works/agent/{notifications,cache,entities}` plus stubs the `../auth` barrel so transitive `@ever-works/agent/database` is not pulled in. |
| 2026-05-07 | api auth (social-auth.service)    | [#488](https://github.com/ever-works/ever-works/pull/488) | Adds 37 unit tests for `SocialAuthService` covering all four OAuth providers (GitHub/Google/Facebook/LinkedIn). `getAuthorizationUrl` (7) — default callback, override callback+state, Google offline+consent, Facebook comma scope separator, LinkedIn space separator, unknown provider, missing client id; `getProviderDisplayName` (5); `getConfiguredProviders` (4) — full env, missing client id/secret, empty; `authenticate` (21) — GitHub full flow (token exchange w/o `grant_type`, `/user` + `/user/emails` resolution via `resolveGitHubAccountEmail`, displayName fallback chain login→email-local-part), Google (email_verified default-true vs explicit false, expires_in→expiresAt computation w/ `Date.now` mock), Facebook (always-false emailVerified, picture nesting, params/fields), LinkedIn (OIDC userinfo, name vs given+family fallback, locale metadata), error paths (missing access_token, missing email per provider, missing client id/secret, unknown provider), and edge cases (`readNumber` rejects string expires_in, `readOptionalString` rejects non-string token_type/scope/empty refresh_token). HttpService mocked with rxjs `of()`. |
| 2026-05-07 | api onboarding adapters + well-known | [#494](https://github.com/ever-works/ever-works/pull/494) | Adds 43 unit tests across `apps/api/src/onboarding/`: `OnboardingAccountAdapter` (18) — covers the full GitHub-app onboarding chain `findByGithubUserId → findProviderAccountByAccountId → findByEmail → users.create`, the username sanitization pipeline (strip non `[a-zA-Z0-9_-]`, 32-char truncate, `agent` fallback), uniqueness suffix `-2…-50` then UUID-suffix fallback, provider-account upsert field shape (id/username/email/Bearer/metadata.onboardingChannel), email=null when input.email omitted, github link upsert, error swallowing on `upsertProviderAccount` and `upsertLink` (logs `account_link_failed` / `gh_link_failed` via `describeError` non-Error fallback), success log (`account_created` vs `account_linked`); `OnboardingWorkAdapter` (18) — covers manifest→CreateWorkDto translation: owner extraction (URL parse, `.git` strip, malformed URL → `''`), slug pipeline (`metadata.slug` override, slugify, lowercase + `[^a-z0-9]+→-` collapse, leading/trailing `-` strip, 63-char truncate, empty fallback to `work`), description fallback (`Auto-generated by Ever Works zero-friction onboarding (<id-prefix>)`), deployProvider default `vercel`, missing user → throw, missing work id → throw `createWork returned no work id`, rethrow + warn log on lifecycle failure, `describeError` non-Error path; `WellKnownController` (7) — agent card defaults plus all four env-var overrides (`PUBLIC_API_URL`/`PUBLIC_MCP_URL`/`PUBLIC_DOCS_URL`/`PUBLIC_CONTACT_EMAIL`), and a no-shared-state assertion. Mocks `@ever-works/agent/{database,services,onboarding}` to avoid the agent runtime tree. |
| 2026-05-07 | api subscriptions + trigger        | [#496](https://github.com/ever-works/ever-works/pull/496) | Adds 22 unit tests across `apps/api/src/`: `SubscriptionsController` (9) — `getPlan` enabled=false envelope, enabled mapping (`code/displayName` → `code/name + allowances`), AuthService.getUser + summarizePlan error propagation; `updatePlan` BadRequest when subscriptions disabled (no getUser/assignPlanToUser side effects), happy-path mapping, plan envelope uses `assignPlanToUser` response (not `summarizePlan`), error propagation; `TriggerInternalController` (13) — `getWorkContext` secret + userId guards (Forbidden / BadRequest / "secret not configured"), `gitToken=undefined` when GitFacade returns null, `user.password` + `work.user` relation stripped, non-user relations preserved; `callRemote` superjson serialize/deserialize round-trip incl. Date, BadRequest unknown target / unknown method, Forbidden short-circuits before invocation, all 10 expected remote targets registered after `onModuleInit`, no shared state across instances. Mocks `@ever-works/agent/{database,entities,cache,work-operations,tasks,services,notifications,facades,plugins,config,subscriptions}` plus the `../auth` barrel. |
| 2026-05-07 | api integrations/twenty-crm        | [#498](https://github.com/ever-works/ever-works/pull/498) | Adds 107 unit tests across `apps/api/src/integrations/twenty-crm/` covering the entire module surface: `RetryUtils` (16) — `withRetry` exponential backoff, `lastError` propagation, default args, no-sleep on `maxAttempts=1`; `isRetryableError` ECONNRESET/ETIMEDOUT/ENOTFOUND, 5xx + 429 retryable, 2xx/non-429 4xx not retryable; `calculateRetryDelay` exponential w/ jitter cap at `maxDelayMs`; `MappingUtils` (19) — multi-word vs single-token name split, empty-name fallback, `mapCompanyToOrganization` URL/`startsWith('http')` host extraction + unparseable→undefined, `mapItemToProduct`/`mapItemToDeal` USD default + supplied-currency override + 50%-prob NEW-stage deal, `validateContactData`/`validateOrganizationData`/`validateProductData`/`validateDealData` happy + missing-field paths; `CrmConfigService` (10) — env reads + 3 numeric defaults (timeout 30000, retries 3, delay 1000), explicit override values, `isEnabled` triple-AND across apiUrl/apiKey/workspaceId (incl. empty-string falsy coercion), `validateConfig` lists each missing key in error message; `CrmSyncGuard` (3) — disabled→false+warn (no validateConfig call), enabled+valid→true, enabled+throw→false+error log; `CrmSync` decorator (4) — default-true metadata, explicit true/false, stable `crm_sync` key constant; `CrmTenantService` (10) — `work_<id>` prefix, globalTenantId fallback, `global_everworks` ultimate fallback, workId-over-globalTenantId precedence, `/tenants/<id>` endpoint prefix, validateTenantContext truthy/empty/undefined, getTenantConfig optional-field preservation; `TwentyCrmService.makeRequest` (8) — `/rest<endpoint>` URL composition, `/rest/metadata<endpoint>` when `schema=true`, default `X-Workspace-Id: default` fallback, body forwarding, HttpException pass-through with upstream message + status + details, "Twenty CRM API error" fallback message, INTERNAL_SERVER_ERROR when status missing, SERVICE_UNAVAILABLE on no-response network error; `ClientService` (24) — table-driven coverage across all 4 entities (companies/contacts/deals/products) × 5 operations (create/get/update/delete/list) verifying exact `(method, endpoint[, body])` tuples + error propagation; `CompaniesController` (5) + `PeopleController` (6) — thin-controller delegation incl. PeopleController explicit field-mapping that strips extraneous body keys and forwards undefined optional fields. Mocks `@src/auth/guards/auth-session.guard` to avoid the `@ever-works/agent/database` runtime tree. |
| 2026-05-07 | api config + events                | [#500](https://github.com/ever-works/ever-works/pull/500) | Adds 76 unit tests across `apps/api/src/`: `config/constants.spec.ts` (49) covers `authConstants`, `AuthProvider` enum, and the full `config` object surface (debug, webAppUrl, auth.secret throw-on-missing, branding fallback chains, mail.provider switch incl. faker/none/resend/smtp catch-all, mail.from EMAIL_FROM verbatim vs `<appName> <email>` fallback w/ default `ever@ever.works`, SMTP host/port/user/pwd/secure/ignoreTLS w/ NaN documented, Resend apiKey + emailFrom override, OAuth providers Google/GitHub/Facebook/LinkedIn clientId/secret/callbackUrl env mapping incl. Google `connectCallbackUrl` alias semantics, GitHub-App appId/clientId/secret/webhookSecret + privateKey `\n` unescape + slug default + setupUrl/callbackUrl webApp fallback, work.staleTimeoutHours default 2 + override + NaN, features.zeroFrictionOnboarding case-insensitive `false` gate); `config/throttler.config.spec.ts` (8) narrows `ThrottlerModuleOptions` union to the object form, asserts the three named tiers (short/medium/long) with exact `{ttl,limit}` records, monotonic ttl + limit ordering, all positive numerics, no global storage/skipIf/errorMessage/ignoreUserAgents; `events/index.spec.ts` (19) pins `EVENT_NAME` strings (wire-format stability) for all 7 event classes, asserts every event's positional argument capture in order, optional-arg defaulting to undefined, BaseUserEvent inheritance for user-scoped events, confirms MemberInvitedEvent does NOT extend BaseUserEvent (uses invitee/inviter instead of user). |
| 2026-05-07 | api github-app controllers         | [#502](https://github.com/ever-works/ever-works/pull/502) | Adds 22 unit tests across `apps/api/src/integrations/github-app/`: `GitHubAppController` (15) covers all 5 endpoints — `GET /setup` field forwarding + propagated errors, `GET /callback` runs `completeUserAuth` → `issueSession` and merges `installationId`+`redirectTo` into the session payload (skipping `issueSession` on auth failure), `GET /installations` userId forwarding, `POST /installations/:id/sync` returns the installation when present and throws `UnauthorizedException` on null/undefined, `POST .../repositories/:rid/onboard` runs `getUser` → `onboardInstallationRepository` and throws `NotFoundException` on falsy result / `BadRequestException` with the message when `result.status === 'error'`; `GitHubAppWebhookController` (7) covers `POST /webhooks` — missing-event-header & missing-rawBody (incl. empty string) `BadRequestException` w/ early exit (no signature verification or dispatch), `UnauthorizedException("Invalid GitHub webhook signature")` on verifyWebhookSignature=false, signature header may be undefined, happy path returns `{ ok: true }`, propagates handler errors, `@Public` smoke check. Mocks `@ever-works/agent/{database,entities,import,services}` plus the `@src/auth` barrel and the `@Public` decorator to avoid the auth+agent runtime tree. |
| 2026-05-07 | api works/tasks schedulers         | [#504](https://github.com/ever-works/ever-works/pull/504) | Adds 59 unit tests across `apps/api/src/works/tasks/` — full schedulers surface. `CommunityPrSchedulerService` (6) — `works:community-pr-scheduler` lock + 1h ttl + onLocked debug, processed/errors log, Error.stack vs String(error) outer error, locked-branch no-op. `ComparisonSchedulerService` (7) — `works:comparison-scheduler` lock, per-work `respectCadence:true` forward, generated/skipped/errors counters, unknown-status not counted, per-work String(error) on non-Error reject, outer error variants. `ItemSourceValidationCronService` (5) — `works:item-source-validation-scheduler` lock, four cache prefixes (items/config/count/categories-tags) deleted in parallel via `CacheEntryRepository.typeormAdapter.deleteUnscopedEntriesLike`, outer error variants, locked-branch skip. `WebsiteTemplateSchedulerService` (10) — `works:website-template-scheduler` lock, `config.websiteTemplate.autoUpdateEnabled()` gate, no-eligible early return, per-work `lastChecked` update, `updateCheck.error` records `websiteTemplateLastError`, missing-`work.user` skip, full update path with `websiteTemplateLastCommit`/`websiteTemplateLastUpdatedAt`, fallback `latestCommit` when `result.commitSha` missing, "Unknown error during template update" fallback for non-Error throws. `WorkCacheWarmupService` (11) — `works:cache-warmup` lock 9-min ttl, `totalEligible=0` early return, single-work warm sets all 4 keys with `WORK_CACHE_TTL_MS`, GENERATING/`!user.id` skip, per-work warn on Error or non-Error, cursor advance + wrap-around batch when `totalEligible > BATCH_SIZE` (25), invalid cursor → 0, zero-window resets cursor to 0, outer Error.stack vs String(error). `WorkCleanupService` (11) — `works:cleanup` lock 9-min ttl, `staleTimeoutHours()`-derived staleThreshold, GENERATING stalled → ERROR + `recordGenerationFinishTime` + refetch + `eventEmitter.emit(WorkGenerationCompletedEvent)`, non-GENERATING stalled keeps status, null-refetch no-emit, `findOrphanedGenerating` → ERROR with `Generation stalled — automatically recovered`, outer Error.stack vs String(error); `clearWorkCache` `@OnEvent(WorkGenerationCompletedEvent.EVENT_NAME)` deletes by `data.work.id` and swallows on cache failure with `logger.error`. `WorkScheduleDispatcherCronService` (9) — `works:schedule-dispatcher` lock, `scheduledUpdatesEnabled` + `!shouldUseTrigger` gates, `isDispatchMinute` (epochMinute % interval === 0) skip when not aligned, `ttlMs = max(intervalMinutes * 60_000, 60_000)` clamp incl. interval=0 → 60_000, `dueCount=0 + failed=0` silence, only-failed log path, outer Error.stack vs String(error). Mocks `@ever-works/agent/{cache,community-pr,comparison-generator,config,database,entities,events,generators,services}` plus `@src/config/constants` so the agent runtime tree is not pulled in. |

## Pending — High Priority

These zero-coverage areas yield the biggest coverage % per PR.

### Search-plugin unit tests (per plugin)

The pattern is established by `groq` / `screenshotone` / `urlbox`: vitest +
fetch-or-SDK mock, ~10–20 tests asserting metadata, settingsSchema shape,
search/extract success + error paths, lifecycle, healthCheck, manifest.

- [x] `brave` (fetch-based, search only) — 25 tests, 2026-05-07
- [x] `linkup` (fetch-based, search + content-extractor) — 27 tests, 2026-05-07
- [x] `tavily` (SDK `@tavily/core`, search + content-extractor) — 26 tests, 2026-05-07
- [x] `valyu` (SDK `valyu-js`, search + content-extractor) — 29 tests, 2026-05-07
- [x] `exa` (SDK `exa-js`, search + content-extractor) — 30 tests, 2026-05-07
- [x] `perplexity` (SDK `@perplexity-ai/perplexity_ai`, search) — 22 tests, 2026-05-07
- [x] `serpapi` (fetch-based, search) — 22 tests, 2026-05-07
- [x] `firecrawl` (SDK `@mendable/firecrawl-js`, search + content-extractor) — 28 tests, 2026-05-07
- [x] `jina` (fetch-based, search + content-extractor) — 25 tests, 2026-05-07
- [x] `scrapfly` (SDK `scrapfly-sdk`, content-extractor + screenshot) — 26 tests, 2026-05-07
- [x] `brightdata` (SDK `@brightdata/sdk`, search + content-extractor) — 28 tests, 2026-05-07

### Other zero-coverage plugins

- [x] `comparison-generator` (utility category) — 12 tests, 2026-05-07
- [x] `github` (git-provider + OAuth) — 20 tests, 2026-05-07
- [x] `local-content-extractor` (content-extractor — default) — 20 tests, 2026-05-07

### Internal-package coverage

- [x] `packages/contracts` — vitest scaffolded; 57 tests including
      a 35-assertion type-level fixture via `expectTypeOf` plus runtime
      tests for `parseGitHubRepositoryUrl`, `isTerminalOnboardingStatus`,
      and the `DomainType` enum (2026-05-07).
- [x] `packages/monitoring` — Sentry + PostHog SDKs mocked, 72 tests across config, services, interceptors (2026-05-07).
- [x] `packages/cli-shared` — utils + prompt services fully covered (116 tests across slug, validation, config-check, generator-steps, base-prompt.service, work-prompt.service).
- [x] `packages/tasks` — vitest scaffolded; 61 tests across `LocalPluginStore`,
      `TriggerLogger`, `TriggerService`, and `collectPluginDependencies`
      (`@trigger.dev/sdk` and `@ever-works/agent/config` mocked).
      Follow-ups: `TriggerInternalApiClient` (HTTP retry), `worker-context` /
      `task-context` utilities, and the four task entrypoints
      (`work-generation` / `work-import` / `work-onboarding` /
      `work-schedule-dispatcher`) — these need NestFactory mocked and are
      best done as a dedicated follow-up.

### API module unit tests

`apps/api/src/` modules currently rely heavily on e2e for coverage. Add
service-level unit tests (Jest + `@nestjs/testing`) for:

- [x] `account` (14 tests, 2026-05-07) — `AccountController` thin-controller delegation tests for export/import/sync surfaces; mocks `@ever-works/agent/account-transfer`.
- [x] `ai-conversation` (56 tests, 2026-05-07) — `ConversationController` (16), `ConversationTitleService` (15), `OpenAiCompatController` (4), `OpenAiCompatService` (21); covers OpenAI-compat DTO mapping, SSE streaming + tool-call delta passthrough, error sanitization (sk-/Bearer redaction), and AI-title generation gating.
- [x] `activity-log` — `JitsuService` (9 tests, mocks `@jitsu/js`,
      env-driven enable/disable + payload mapping) and
      `ActivityLogListener` (25 tests covering all 9 `@OnEvent`
      handlers, both happy + error paths) — [#482](https://github.com/ever-works/ever-works/pull/482).
- [x] `auth/services/api-key.service` (15 tests, 2026-05-07) — `ApiKeyService` covering create (10-key cap, expiresAt-in-past rejection, ew_live_ prefix + sha256 hashing, future expiresAt, unique-key generation), list/revoke, and validate (sha256 lookup, null-when-missing, null-when-expired, null-expiresAt = never-expiring, fire-and-forget updateLastUsed swallowing failure).
- [x] `auth/services/auth.service` (45 tests, 2026-05-07) — `AuthService` covering assertCanRegister, validateSocialUser (new user creation with trusted-email emit, unverified-email gating, suspended-account rejection, provider-link bypass, upsertProviderAccount field mapping), sendVerificationEmail (24h expiry, callback URL token-append vs default), verifyEmail, forgotPassword (1h expiry, callback URL handling, generic-message safety), getUserByPasswordResetToken, consumePasswordResetToken, getUser, getUserProfile (sensitive-field stripping, github repo-scope gating, expired-token filtering), updateUserProfile (selective field updates, committer-field clearing semantics), validateEmailVerificationToken, validatePasswordResetToken.
- [x] `auth/services/social-auth.service` (37 tests, 2026-05-07) — `SocialAuthService` covering all four OAuth providers (GitHub/Google/Facebook/LinkedIn): `getAuthorizationUrl` (default vs override callback+state, Google access_type=offline+prompt=consent, Facebook comma scope separator, LinkedIn default space separator, unknown provider + missing client id rejection); `getProviderDisplayName` for all four + unknown; `getConfiguredProviders` (full env, missing client id/secret, empty); `authenticate` (GitHub full flow w/o `grant_type` + `/user` + `/user/emails` resolution via `resolveGitHubAccountEmail`, displayName fallback chain login→email-local-part; Google emailVerified default-true vs explicit false, expires_in→expiresAt computation; Facebook always-false emailVerified, picture nesting; LinkedIn OIDC userinfo + given/family fallback + locale metadata; missing access_token, missing email per provider, missing client id/secret, unknown provider; readNumber/readOptionalString edge cases). HttpService mocked with rxjs `of()`.
- [x] `integrations/twenty-crm` — 107 tests, 2026-05-07 (utils retry+mapping, config+guard+decorator, services twenty-crm+crm-tenant+client, controllers companies+people) — [#498](https://github.com/ever-works/ever-works/pull/498).
- [x] `config` — 57 tests, 2026-05-07 (`constants.spec.ts` 49 + `throttler.config.spec.ts` 8). Covers the full `config` object surface (auth/branding/mail/OAuth/githubApp/work/features), `authConstants`, `AuthProvider` enum, and the throttler module config tiers — [#500](https://github.com/ever-works/ever-works/pull/500).
- [x] `events` — 19 tests, 2026-05-07 (`events/index.spec.ts`). Pins `EVENT_NAME` strings for all 7 event classes + asserts positional-arg capture and `BaseUserEvent` inheritance — [#500](https://github.com/ever-works/ever-works/pull/500).
- [x] `integrations/github-app` controllers — 22 tests, 2026-05-07 (`GitHubAppController` 15 + `GitHubAppWebhookController` 7). All 5 controller endpoints + the webhook endpoint covered (setup/callback/listInstallations/syncInstallation/onboardRepository + handleWebhook). Mocks `@ever-works/agent/{database,entities,import,services}` plus the `@src/auth` barrel — [#502](https://github.com/ever-works/ever-works/pull/502). _Service-level coverage previously shipped: `github-app.service.spec.ts`, `github-app-onboarding.service.spec.ts`, `github-app-sync.service.spec.ts`._ Follow-up: a `github-app.module.spec.ts` (Nest module wiring) is the only remaining gap in this folder; defer until `apps/api` has a precedent for module-level wiring tests.
- [x] `mail/providers/*` — 16 tests, 2026-05-07 (`FakerMailerService` 2 + `MailerService` 14: SMTP/Resend/faker provider switch, Buffer/template/html/text body resolution, Handlebars template read path, recipient log formatting, constructor provider log)
- [x] `notifications` — 14 tests, 2026-05-07 (`NotificationsController` 10 + `NotificationCleanupService` 4)
- [x] `onboarding` — adapters + well-known controller, 43 tests, 2026-05-07 (`OnboardingAccountAdapter` 18 + `OnboardingWorkAdapter` 18 + `WellKnownController` 7). Covers GitHub-app login → user resolution chain (link → provider account → email → create), username sanitization/uniqueness/UUID-fallback, provider account + github link upsert with fields and metadata, error swallowing on upsert paths; Work-adapter manifest → CreateWorkDto translation incl. slug truncation/fallback/sanitization, deployProvider default, owner extraction (`.git` strip, malformed URL → `''`), description fallback, missing-id rethrow, describeError fallback; agent-card env overrides (`PUBLIC_API_URL`/`MCP_URL`/`DOCS_URL`/`CONTACT_EMAIL`).
- [x] `subscriptions` (9 tests, 2026-05-07) — `SubscriptionsController` `getPlan` (enabled-false envelope, plan mapping, error propagation) + `updatePlan` (BadRequest when disabled, mapping, response source = `assignPlanToUser`, error propagation) — [#496](https://github.com/ever-works/ever-works/pull/496).
- [x] `trigger` (13 tests, 2026-05-07) — `TriggerInternalController` `getWorkContext` (secret + userId guards, gitToken null → undefined, password/user-relation stripping) + `callRemote` (superjson Date round-trip, unknown target/method, secret short-circuit, 10 remote targets, no shared state) — [#496](https://github.com/ever-works/ever-works/pull/496).
- [ ] `templates` — currently only Handlebars views (`*.hbs`); no controller/service to unit-test directly. Coverage flows through `MailerService.sendMail` template-resolution path (already covered in #492). Could add a snapshot test for compiled-template output if regression risk emerges.
- [ ] `works/*` (largest surface — split by sub-module)
  - [x] `works/tasks/*` — 59 tests, 2026-05-07 — full schedulers surface: `CommunityPrSchedulerService` (6), `ComparisonSchedulerService` (7), `ItemSourceValidationCronService` (5), `WebsiteTemplateSchedulerService` (10), `WorkCacheWarmupService` (11), `WorkCleanupService` (11), `WorkScheduleDispatcherCronService` (9) — [#504](https://github.com/ever-works/ever-works/pull/504).
  - [ ] `works/works.controller.ts` (1716 lines — split by endpoint group: CRUD, generation, items, categories/tags, collections, import, scheduled updates, community PR, cancellation).
  - [ ] `works/members.controller.ts` (173 lines — invite/list/update-role/remove).
  - [ ] `works/dto/*` — class-validator decorators (BatchDeploy, Deploy, GenerateDetail, GenerateManualComparison, InviteMember, UpdateMemberRole) — small surface, defer until controllers are covered to test via DTO instantiation/validation.

## Pending — Medium Priority

### Spec Kit features that need a spec

Cross-check `docs/specs/features/` against actual capabilities. Candidates
known to lack a Spec Kit feature folder:

- [ ] `auth-jwt-oauth` (JWT issuance, OAuth GitHub/Google flow)
- [ ] `notifications` (in-app + email delivery, channels)
- [ ] `subscriptions` (plan/feature gating)
- [ ] `activity-log` (event taxonomy + persistence)
- [ ] `mail-providers` (provider abstraction + templates)
- [ ] `templates-catalog` (PR #459 just landed — needs spec backfill)
- [ ] `ai-conversation` (chat-style conversations against works)
- [ ] `integrations-twenty-crm`, `integrations-github-app`
- [ ] `plugins-capabilities` (AI/Search/Deploy/Screenshot/Content-Extractor
      facades)
- [ ] `community-pr-processing` already exists — verify it is still accurate
      after #460/#462/#464 (k8s + activity-log changes).

### Docs gaps to audit

- [ ] `docs/packages/*` — every plugin now has a README (PR landed); audit
      that each one mentions: settings, env vars, capabilities, example
      configuration, troubleshooting.
- [ ] `docs/api/*` — endpoint reference; cross-check against
      `apps/api/src/**/controllers/*.controller.ts`.
- [ ] `docs/architecture/*` — confirm diagrams are current after
      Directory→Work rename (PR #436) and works.yml standardization
      (PR #456).
- [ ] `docs/devops/*` — kind-cluster e2e CI just landed (#464); add runbook.

## Pending — Low Priority

- [ ] CLI (`apps/cli`) — add command-level snapshot tests via esbuild + node.
- [ ] Internal CLI (`apps/internal-cli`) — `nest-commander` testing module.
- [ ] Admin app (`apps/admin`) — once routes stabilize.
- [ ] MCP server (`apps/mcp`) — already has 7 spec files; audit edge cases.
- [ ] Performance / load tests for the standard pipeline (15 steps).
- [ ] Visual-regression for marketing pages once those settle.

## Conventions for new tests added by this task

- **Per-plugin spec lives in** `packages/plugins/<id>/src/__tests__/<id>.plugin.spec.ts`.
- **Mocking style**: prefer mocking the upstream SDK or `global.fetch`
  over network round-trips. No `nock`, no live calls.
- **Assert at minimum**: id/name/version/category/capabilities, settings
  schema (required keys, secret/envVar markers), happy-path search/extract,
  error path (missing API key, non-OK HTTP), lifecycle (`onLoad`/`onUnload`),
  `healthCheck`, `getManifest`.
- **Run locally** with `pnpm --filter @ever-works/<id>-plugin test` before
  committing.
- **Branch naming**: `tests/<area>-<short-slug>` (e.g.
  `tests/search-plugins-zero-coverage`).
- **PR title**: conventional `test(<scope>): <summary>`. Body: list of
  plugins/modules covered + a one-line summary of mocked surfaces.
- **Always merge to `develop`** without waiting for human review (the
  scheduled-task spec authorizes this).

## Follow-ups discovered

- **API test suite has 2 pre-existing failures on `develop` from a stale
  `@ever-works/agent` `dist/`.** As of 2026-05-07, running `pnpm --filter
  ever-works-api test` fails 2 suites (`template-catalog/template-catalog.controller.spec.ts`
  and `plugins-capabilities/deploy/deploy.service.spec.ts`) with TS2339/TS2305
  errors against `packages/agent/dist/entities/activity-log.types.d.ts`
  (missing `TEMPLATE_ADDED`/`TEMPLATE_UPDATED`/`TEMPLATE_ARCHIVED`/`TEMPLATE_DEFAULT_SET`/`TEMPLATE_FORKED`)
  and `packages/agent/dist/generators` (missing
  `WebsiteTemplateResolverService` export). The 350 other tests pass. Likely
  fix: rebuild the agent package (`turbo build --filter=@ever-works/agent`)
  in CI / locally — but a real fix probably means adjusting `apps/api`'s
  Jest config or the agent `package.json` `exports` so source is preferred
  over stale `dist`. Not a regression — observed before #496.
- **`MailerService.sendMail` Resend branch crashes when `to` is omitted.**
  At `apps/api/src/mail/providers/mailer.service.ts:48`, `to: this.getDestination(data.to)` is unguarded — when callers omit `to`, the log line correctly says `to=unknown` but `getDestination(undefined)` then throws `TypeError: Cannot use 'in' operator to search for 'address' in undefined`. The SMTP and faker paths handle missing `to` cleanly by passing `data` through. A fix would short-circuit Resend the same way (e.g. `to: data.to ? this.getDestination(data.to) : []`). The current behavior is pinned by a test in `mailer.service.spec.ts` so a fix must update the assertion. Discovered while writing #PR-mail-providers (2026-05-07).
