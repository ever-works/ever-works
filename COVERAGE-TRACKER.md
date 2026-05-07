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
| 2026-05-07 | api account + ai-conversation     | (this PR) | Adds 70 unit tests across `apps/api/src/account/` (14 — `AccountController` covering all 9 endpoints: export with includeSecrets parsing, import preview/apply with default-`[]` resolutions, sync status/configure/push/pull/applyPull/remove) and `apps/api/src/ai-conversation/` (56 — `ConversationController` 16, `ConversationTitleService` 15, `OpenAiCompatController` 4, `OpenAiCompatService` 21). Highlights: title auto-generation gating (msg count, aiTitle metadata, fallback when work lookup fails), summary windowing (last 4 user/assistant only, 200-char cap per message), OpenAI-compat DTO→internal mapping (model="auto"→undefined, tool_calls, tool_call_id, name passthrough, null content), SSE streaming + tool_call delta passthrough (id/type/name only on first chunk), and the sanitizeErrorMessage redaction path (sk-/Bearer tokens stripped, 300-char truncation, non-Error fallback). |

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
- [ ] `auth/services/*` (jwt, password, oauth)
- [ ] `config`, `events`, `integrations/*`
- [ ] `mail/providers/*`
- [ ] `notifications`, `onboarding`
- [ ] `subscriptions`, `templates`, `trigger`
- [ ] `works/*` (largest surface — split by sub-module)

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

(Empty — populated as the task surfaces them.)
