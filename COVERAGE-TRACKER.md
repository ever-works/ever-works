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
| 2026-05-07 | cli-shared utils extended         | (this PR)                                                 | Adds 25 more unit tests in `cli-shared`: config-check (10) covers maskSecret edge cases (incl. <8 char short-circuit and boundary at exactly 8) plus displayConfigurationError/Warnings; generator-steps (15) covers getStepText, getStepProgress, getDynamicStepText, getDynamicStepProgress, getItemsProcessedText. |

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

- [ ] `packages/contracts` — pure types; add type-test fixtures via
      `expectTypeOf` so breaking changes are caught.
- [ ] `packages/monitoring` — mock Sentry + PostHog SDKs and assert wiring.
- [~] `packages/cli-shared` — utils fully covered (52 tests across slug, validation, config-check, generator-steps). Prompt services (`base-prompt.service.ts`, `work-prompt.service.ts`) still pending.
- [ ] `packages/tasks` — Trigger.dev jobs; mock `@trigger.dev/sdk` v3.

### API module unit tests

`apps/api/src/` modules currently rely heavily on e2e for coverage. Add
service-level unit tests (Jest + `@nestjs/testing`) for:

- [ ] `account`, `activity-log`, `ai-conversation`
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
