# AW-25 — Help centre in product · Task List

**Epic:** `AW-25-help-center` · **Program:** [Agent Workspace](../README.md)
**Spec:** [spec.md](./spec.md) · **Plan:** [plan.md](./plan.md)
**Status:** Draft v1 · **Date:** 2026-09-06

Execute top to bottom. Every task names the exact files to create or modify and what "done" means.
Phases are independently shippable; each ends with `develop` green.

**Repo commands used below** (from `CLAUDE.md`): `pnpm lint`, `pnpm type-check`,
`cd apps/api && pnpm test`, `cd packages/agent && pnpm test`, `cd apps/web && pnpm test`,
`cd apps/web && pnpm test:e2e`, and from `apps/api/`
`pnpm typeorm migration:run -d typeorm.config.ts`.

---

## Phase 1 — The manual exists, is reachable, and is deep-linkable

Ships the content pipeline, the panel, the full page, and the link type that every empty state and
error message uses. No database, no API, no background job, no palette dependency. Search in P1
matches titles, summaries and keywords from the eager catalogue.

---

### T-01 · Contracts: section and block-kind enums

**Phase:** P1
**Create:** `packages/contracts/src/api/help/help.enum.ts`

Export `HELP_SECTIONS` (`as const` tuple of exactly `start-here`, `running-the-loop`,
`your-agents`, `setup-and-connections`, `money-and-limits`, `when-something-goes-wrong`) with
derived type `HelpSection`, and `HELP_BLOCK_KINDS` (`paragraph`, `heading`, `orderedList`,
`unorderedList`, `note`, `shortcut`, `code`, `link`) with derived type `HelpBlockKind`. Also
export `HELP_LINK_TARGET_TYPES` (`article`, `screen`, `external`), the `HelpLinkTarget`
discriminated union and `HelpLinkBlock` exactly as in [plan §3.3](./plan.md). Doc-comment each
citing spec FR-4, FR-27 and FR-27a and stating that the sets are closed — adding a seventh
section or a ninth block kind is a spec change.

**Done when:** both tuples are `as const`, both derived types are unions of string literals, and
the tuple order matches the reading order in spec FR-4.

---

### T-02 · Contracts: barrel exports

**Phase:** P1
**Create:** `packages/contracts/src/api/help/index.ts`
**Modify:** `packages/contracts/src/api/index.ts`

Re-export `help.enum.ts` from the folder index and add one `export * from './help/index.js';` line
to the API barrel, following the existing one-line comment style naming the epic.

**Done when:** `import { HELP_SECTIONS } from '@ever-works/contracts/api'` type-checks from
`apps/web` and `apps/api`, and `pnpm type-check` passes.

---

### T-03 · Content folder and authoring rules

**Phase:** P1
**Create:**

- `apps/web/src/content/help/README.md`
- `apps/web/src/content/help/{start-here,running-the-loop,your-agents,setup-and-connections,money-and-limits,when-something-goes-wrong}/.gitkeep`

The README is the authoring contract. It must state: the frontmatter fields and their limits (spec
FR-2, FR-3); that `documents` holds **keys of `ROUTES`**, never literal paths; the closed block
grammar (spec FR-27) and that raw HTML, images, tables and block quotes are build errors; the three
link-block forms — `[label](help:<article>#<heading>)`, `[label](route:<ROUTES key>)` and
`[label](https://…)` — each on its own line, and that inline links, literal in-product paths and
non-`https` schemes are build errors (spec FR-27a); the rule
that an article may only be added alongside the screen it documents (spec FR-6); that a plugin
count or list must link to `docs/plugin-system/built-in-plugins.md` rather than restate it
(Constitution VIII); and the two approved help-link phrases (spec FR-24).

**Done when:** a new contributor can write a valid article from the README alone, and the six
section folders exist.

---

### T-04 · The generator

**Phase:** P1
**Create:** `apps/web/scripts/build-help-catalog.mjs`

Plain ESM, no build step, header comment in the style of the three scripts already in that folder.
Implements plan §3.5 steps 1–6:

- read every `.md` under `apps/web/src/content/help/`;
- validate every limit in spec FR-3 and fail with the article path and the violated rule;
- parse bodies into the closed block grammar, erroring with a line number on anything outside it;
- parse **link blocks** per plan §3.5 step 3: a line that is exactly one Markdown link becomes
  `{ kind: 'link', label, target }` with `help:` → `article`, `route:` → `screen`, `https:` →
  `external`; reject inline links, empty or > 80-character labels, literal in-product paths,
  every other scheme (`http:`, `javascript:`, `data:`, `mailto:`, `//host`) and userinfo URLs;
  after headings are slugified, resolve every `article` target's article id and heading id;
- export the pure `parseArticleBody(source, articlePath)` (no file I/O) so the grammar, including
  link blocks, is unit-testable from `apps/web/src/lib/help/help-link-blocks.unit.spec.ts` (T-23);
- slugify `##` headings into anchor ids, erroring on duplicates within an article;
- emit `apps/web/src/lib/help/help-catalog.generated.ts` (metadata, `HELP_ARTICLES`,
  `HELP_SECTION_ORDER`, and `export type HelpTarget` as the union of every `id` and every
  `` `${id}#${headingId}` ``);
- emit `apps/web/src/lib/help/help-content.generated.json` with `{ bodies }` in P1 (the `postings`
  key is added in T-26);
- support `--check`, which regenerates into memory and exits non-zero with a diff summary when the
  committed outputs differ.

**Done when:** running it on the T-22 articles produces both files deterministically (byte-identical
across two runs), and every failure path prints the article path plus the rule.

---

### T-05 · Wire the generator into the build

**Phase:** P1
**Modify:** `apps/web/package.json`

Add `"help:build": "node scripts/build-help-catalog.mjs"` and
`"prebuild": "node scripts/build-help-catalog.mjs --check"`. Confirm `turbo.json`'s `build` task
inputs cover `src/content/help/**` and `scripts/build-help-catalog.mjs` so a content-only change
invalidates the cache.

**Done when:** `pnpm build` fails with a clear message when a generated file is stale, and passes
after `pnpm --filter ever-works-web help:build`.

---

### T-06 · Help target parsing and resolution

**Phase:** P1
**Create:** `apps/web/src/lib/help/help-target.ts`

`parseHelpTarget(value)` → `{ articleId, headingId | null }`; `formatHelpTarget(a, h?)`;
`resolveHelpTarget(target)` → `{ article, heading | null, headingMissing: boolean } | null`,
reading `HELP_ARTICLES` from the generated catalogue. An unknown article resolves to `null`
(spec FR-22); a known article with an unknown heading resolves to the article with
`headingMissing: true` (spec S-15).

**Done when:** the three functions are pure, import nothing from React, and are exported for reuse
by the page, the panel and the palette source.

---

### T-07 · Search ranking

**Phase:** P1
**Create:** `apps/web/src/lib/help/help-search.ts`

A pure `rankHelpArticles({ query, articles, postings?, currentRouteKey })` implementing spec FR-18:
diacritic-folding and case-folding, the score table, the `+5` current-screen boost capped at 100,
the tie-break order, the 20-total and 6-per-section caps, section promotion on a score-100 hit, and
the 2-character floor. In P1 `postings` is absent and only title, summary, keywords and heading
text are scored; the function must already accept `postings` so T-28 is an argument, not a rewrite.

**Done when:** the function is deterministic, has no I/O, and returns results grouped by section in
`HELP_SECTION_ORDER`.

---

### T-08 · Current-screen mapping

**Phase:** P1
**Create:** `apps/web/src/lib/help/help-screen-map.ts`

Given the current pathname, return the `ROUTES` key it corresponds to and the ids of the articles
whose `documents` list contains that key. Longest-prefix wins, so `/works/:id/kb` maps to the KB
key rather than the Works key.

**Done when:** it resolves the home screen, a list screen, a detail screen, a Work sub-screen and a
settings sub-screen correctly, and returns an empty list rather than throwing for an unmapped path.

---

### T-09 · The provider

**Phase:** P1
**Create:** `apps/web/src/components/help/HelpCenterProvider.tsx`

Context exposing `{ open, close, openHelpAt(target), isOpen, target, view }` where `view` is
`browse | results | article`. `openHelpAt` accepts a `HelpTarget`, sets the article view, and opens
the drawer on its manual tab. Opening while open is a no-op that preserves query, scroll and the
current article (spec FR-15, S-22).

**Done when:** a component anywhere under the shell can call `openHelpAt('missions#writing-a-brief')`
and the panel opens there, with no navigation.

---

### T-10 · Article primitives

**Phase:** P1
**Create:**

- `apps/web/src/components/help/HelpArticleBlocks.tsx`
- `apps/web/src/components/help/HelpOnThisPage.tsx`
- `apps/web/src/components/help/HelpRelated.tsx`
- `apps/web/src/components/help/HelpBuildStamp.tsx`

`HelpArticleBlocks` renders exactly the eight block kinds from T-01 and **must not** use
`dangerouslySetInnerHTML` anywhere (spec FR-28). The `link` case switches on `target.type`
(spec FR-27a): `article` → `openHelpAt(formatHelpTarget(articleId, headingId))` inside the panel
and a same-origin link on `/help/[slug]`, both via `resolveHelpTarget` from T-06; `screen` →
the `ROUTES[routeKey]` href through the locale-aware link, disabled with `Needs owner access`
under the same reachability check as "Open the screen" (spec FR-29); `external` →
`<a target="_blank" rel="noopener noreferrer">` with the leaving-the-app icon and the
`dashboard.helpCenter.externalLink` accessible text. The renderer re-checks the target at
render time — an `href` that is not `https:`, or an article or route that does not resolve —
and renders the label as plain text with no anchor. The `switch` has no `default`, so a future
block kind is a compile error.
`HelpOnThisPage` renders the heading list and collapses to a single expandable control below 768 px
(spec FR-43). `HelpBuildStamp` reads the version already fetched for the footer and renders
**nothing** when it is unknown (spec FR-8).

**Test:** `apps/web/src/components/help/HelpArticleBlocks.unit.spec.tsx` — all three link
target types, the disabled screen link, `rel`/`target` and the accessible text on external
links, and plain-text fallback for `javascript:`, `http:`, `data:` and unresolvable targets.

**Done when:** every block kind renders in both themes, and grepping these files for
`dangerouslySetInnerHTML` returns nothing.

---

### T-11 · The article reader

**Phase:** P1
**Create:** `apps/web/src/components/help/HelpArticleReader.tsx`

Section label, title, `Reviewed {date}`, `HelpOnThisPage` (only when the article has more than one
heading), the body, the optional "Open {screen}" action, `HelpRelated`, and — from P3 —
`HelpFeedback`. The screen action resolves through `ROUTES` and renders disabled with
`Needs owner access` when the reader cannot reach it, and is skipped by keyboard navigation (spec
FR-29). Renders the `englishOnly` notice above the body when the active locale is not `en` (spec
FR-39). Handles `headingMissing` by scrolling to the top and showing the dismissible
`headingMoved` line (spec S-15).

**Done when:** an article opens at a heading when one is given, at the top otherwise, and the
disabled screen action announces its reason to screen readers.

---

### T-12 · Browse, search input and results

**Phase:** P1
**Create:**

- `apps/web/src/components/help/HelpBrowse.tsx`
- `apps/web/src/components/help/HelpSearchInput.tsx`
- `apps/web/src/components/help/HelpSearchResults.tsx`

`HelpBrowse` renders "On this screen" (omitted when empty), "Recently opened" (empty in P1, added
in T-30) and "Browse" with per-section counts, omitting any section with zero articles (spec S-23).
`HelpSearchResults` is a listbox: grouped by section, arrow keys skip section headings, `Home`/`End`
jump, `Enter` opens, and the settled result count is announced politely once per result set (spec
FR-41).

**Done when:** keyboard navigation matches the spec §6.12 table exactly and section headings are
never selectable.

---

### T-13 · The panel

**Phase:** P1
**Create:** `apps/web/src/components/help/HelpCenterPanel.tsx`

Owns the query and the `browse | results | article` view. `/` focuses the search box from anywhere
inside the panel; `Esc` walks article → results → browse → close and restores focus to the element
that opened it (spec FR-40). 480 px wide at ≥ 768 px, full-screen below (spec FR-43, FR-44).
Footer carries `HelpBuildStamp` and the `Open full page` link.

**Done when:** the panel is visible within 150 ms of activation with the catalogue already
rendered, and `Esc` precedence is exactly as specified.

---

### T-14 · The new first drawer tab

**Phase:** P1
**Modify:** `apps/web/src/components/dashboard/HelpDrawer.tsx`

Add `manual` as the **first** tab, rendering `<HelpCenterPanel/>`. Accept an optional
`initialTarget?: HelpTarget` prop that selects that tab and opens the article. Do not touch the
`tips`, `shortcuts`, `faq` or `resources` tabs, their copy, their `DOCS_URL` / `GITHUB_URL` /
`ISSUES_URL` / `DISCUSSIONS_URL` constants, or the environment chip (spec FR-13).

**Done when:** a `git diff` of this file shows only additions plus the one-position shift of the
existing tab list, and all four existing tabs still render identically.

---

### T-15 · Mount the provider in the shell

**Phase:** P1
**Modify:** `apps/web/src/app/[locale]/(dashboard)/layout-client.tsx`

Wrap the shell body in `<HelpCenterProvider>` and pass its `target` into `<HelpDrawer/>` as
`initialTarget`. Do **not** modify `useKeyboardShortcuts` — `?` already calls `onOpenHelp`, which
now lands on the manual tab.

**Done when:** `?` from four different screens opens the panel on the manual tab, and the existing
chat panel, sidebar persistence and toast behaviour are unchanged.

---

### T-16 · Header tooltip and sidebar entry

**Phase:** P1
**Modify:**

- `apps/web/src/components/dashboard/DashboardHeader.tsx` — the Help button tooltip uses
  `dashboard.helpCenter.openTooltip` (`Help — press ?`).
- `apps/web/src/components/dashboard/DashboardSidebar.tsx` — `profileMenu.helpDocs` opens the
  manual; add one adjacent row that keeps the external documentation link. Remove nothing.

**Done when:** the sidebar user menu has one more row than before, `Keyboard Shortcuts` still opens
the drawer on its Shortcuts tab, and no existing entry changed target except `helpDocs`.

---

### T-17 · Routes and the full page

**Phase:** P1
**Modify:** `apps/web/src/lib/constants.ts` — add `DASHBOARD_HELP = '/help'` and
`DASHBOARD_HELP_ARTICLE = (slug: string) => '/help/' + slug` to `ROUTES`.
**Create:**

- `apps/web/src/app/[locale]/(dashboard)/help/page.tsx`
- `apps/web/src/app/[locale]/(dashboard)/help/[slug]/page.tsx`
- `apps/web/src/components/help/HelpArticleNotInBuild.tsx`

Both pages are server components inside the dashboard group (so they inherit its auth gate),
reading the build identity from the same cached version call the layout already makes. The index
renders spec §6.7; `[slug]` renders the article, honouring the URL fragment, and renders
`HelpArticleNotInBuild` (spec §6.8) for an unknown slug — with the running version, up to three
nearest-title suggestions, and a `Browse all articles` action. It must **not** call `notFound()`
and must **never** redirect to a different article.

**Done when:** an unknown slug returns HTTP 200 with the not-in-this-build page, a known slug with
an unknown fragment opens at the top with the moved line, and both pages require a session.

---

### T-18 · The help link

**Phase:** P1
**Create:** `apps/web/src/components/help/HelpLink.tsx`

Props: `target: HelpTarget`, `variant: 'emptyState' | 'error'`. Renders
`dashboard.helpCenter.link.howThisWorks` or `link.whyAmISeeingThis` (spec FR-24), calls
`openHelpAt(target)` rather than navigating (spec FR-21), and renders **nothing at all** when
`resolveHelpTarget` returns `null` — logging one `console.warn` naming the target in development
only (spec FR-22, S-16). It is always secondary styling: text weight, never a filled button.

**Done when:** an unresolvable target renders no DOM node, and a resolvable one opens the panel in
place without a navigation event.

---

### T-19 · Wire the empty states

**Phase:** P1
**Modify:**

- `apps/web/src/components/common/EmptyState.tsx` — add an optional `helpTarget?: HelpTarget` prop
  that renders `<HelpLink variant="emptyState"/>` after the existing action. Existing call sites
  must be unaffected.
- The empty states on the Missions, Tasks, Agents, Works, Ideas, Skills, Teams, Memory, Knowledge
  Base, Plugins and Schedules list screens — pass one `helpTarget` each.

**Done when:** 11 list screens carry a help link, each opens the right article, and no empty state's
title, description or primary action changed.

---

### T-20 · Wire the error surfaces

**Phase:** P1
**Modify:**

- `apps/web/src/components/dashboard/JobRuntimeDegradedBanner.tsx` — one
  `<HelpLink variant="error"/>` in the existing action row.
- `apps/web/src/components/dashboard/AttentionSection.tsx` — one `<HelpLink variant="error"/>` per
  attention kind, from a map covering the four kinds emitted today (`agent-error`,
  `generation-failed`, `task-blocked`, `budget-exceeded`).

**Done when:** spec FR-23's floor of 14 wired surfaces is met (11 from T-19 + 1 banner + 4 attention
kinds = 16), the banner's dismissal and persistence behaviour is unchanged, and attention-item
severity ordering is unchanged.

---

### T-21 · i18n

**Phase:** P1
**Modify:** `apps/web/messages/en.json` and the 20 sibling locale files.

Add the complete `dashboard.helpCenter` namespace from [plan.md §8](./plan.md#8-i18n), plus
`metadata.pages.help`, plus the one new sibling key in `dashboard.sidebar.profileMenu` for the
preserved external documentation link. Seed the other locales with
`node apps/web/scripts/sync-locale-parity.mjs` (it seeds **full paths** — a missing parent object
collapses the subtree into a runtime error, not an English fallback), then translate with
`node apps/web/scripts/translate-messages.mjs --mode missing`.

**Done when:** every leaf name is camelCase with **no literal dot**, all 21 files contain the full
`dashboard.helpCenter` subtree, and no string in spec §6.11 is hardcoded in a component.

---

### T-22 · Write the articles

**Phase:** P1
**Create:** at least 18 `.md` files under `apps/web/src/content/help/`, at least 2 per section,
covering the 12 most-visited dashboard screens (spec FR-9).

Suggested opening set, one file each:

| Section                     | Articles                                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------------------- |
| `start-here`                | what this product does for you · your first hour · how to brief an agent so it lands                  |
| `running-the-loop`          | missions · tasks · my decisions · the live feed                                                       |
| `your-agents`               | agents · skills · memory and the knowledge base · runs and what they cost · schedules and triggers    |
| `setup-and-connections`     | connecting accounts and what an agent may touch · organizations, workspaces and teams · notifications |
| `money-and-limits`          | what it costs and how to cap it · credits, plans and invoices                                         |
| `when-something-goes-wrong` | when an agent is stuck · when background work isn't running · reading a failure                       |

Every article must document only screens that exist in this build (spec FR-6) and set a
`reviewedAt` of the day it was written.

**Done when:** `pnpm --filter ever-works-web help:build` succeeds, the catalogue spec (T-23) passes,
and every `helpTarget` used in T-19 and T-20 resolves.

---

### T-23 · Unit tests — P1

**Phase:** P1
**Create:**

- `apps/web/src/lib/help/help-catalog.unit.spec.ts`
- `apps/web/src/lib/help/help-target.unit.spec.ts`
- `apps/web/src/lib/help/help-search.unit.spec.ts`
- `apps/web/src/components/help/HelpCenterPanel.unit.spec.tsx`
- `apps/web/src/components/help/HelpArticleReader.unit.spec.tsx`
- `apps/web/src/components/help/HelpLink.unit.spec.tsx`

`help-catalog.unit.spec.ts` is the build gate for spec FR-5: it imports the generated catalogue and
`ROUTES` from `apps/web/src/lib/constants.ts` and asserts every FR-3 limit, unique ids, unique
anchors per article, exactly six sections, every `documents` key present in `ROUTES`, that none is
`DASHBOARD_NOTIFICATIONS` (the documented dead route), every `related` id resolving, the FR-9
floor, and for every `link` block: each `screen` `routeKey` present in `ROUTES`, not
`DASHBOARD_NOTIFICATIONS` and free of `:param` segments, and each `external` `href` still
`https:` with no userinfo (spec FR-5.7, FR-27a).

Also create `apps/web/src/lib/help/help-link-blocks.unit.spec.ts` (it lives under `src/` because
the Vitest glob is `src/**/*.unit.spec.*`): import the pure `parseArticleBody` that
`scripts/build-help-catalog.mjs` exports and run it over fixture articles — the three authored
forms produce the exact `HelpLinkBlock`, and every rejected form listed in T-04 fails with the
article path and line number.

**Done when:** `cd apps/web && pnpm test` passes and deliberately breaking any one invariant fails
the suite with a message naming the article.

---

### T-24 · E2E — P1

**Phase:** P1
**Create:**

- `apps/web/e2e/help-center.spec.ts` — `?` from four screens and ignored inside a text field; header
  control; sidebar entry; browse → article → `Esc`; the build stamp matches the footer's version;
  `/help` and `/help/[slug]` render inside the shell and require a session.
- `apps/web/e2e/help-deep-links.spec.ts` — each wired empty state and the degraded-background-work
  banner opens the panel in place at the right article and heading with **no** navigation; unknown
  fragment shows the moved line; unknown slug shows the not-in-this-build page carrying the running
  version.
- `apps/web/e2e/help-a11y.spec.ts` — focus trap and restoration; arrow keys skip section headings;
  the polite result-count announcement; a 375 px viewport is full-screen with no horizontal page
  scroll; a right-to-left locale mirrors without overlap.

**Modify:** `apps/web/e2e/COVERAGE.md` — add the rows for the two new web routes and the three new
specs.

**Done when:** `cd apps/web && pnpm test:e2e` passes locally and `COVERAGE.md` has no new `[ ]` rows
for this epic.

---

### T-25 · Telemetry — P1 events

**Phase:** P1
**Modify:** the components from T-09, T-13 and T-18.

Capture `help_opened`, `help_article_opened` and `help_deep_link_followed` through the already
mounted PostHog provider, with exactly the properties in [plan.md §9.1](./plan.md#91-telemetry).
Assert in a unit test that no event payload carries article body text, note text or a query string.

**Done when:** the three events fire once per action and a grep of the capture call sites shows no
free-text property.

---

## Phase 2 — Full-text search and the palette

---

### T-26 · Generator emits search postings

**Phase:** P2
**Modify:** `apps/web/scripts/build-help-catalog.mjs`

Add the `postings` map to `help-content.generated.json`: token → `[articleIndex, field,
headingIndex]` triples, where `field` distinguishes body from heading so T-28 can score them
differently. Fold diacritics and case at build time so the runtime does not have to. Assert the
generated file stays within the spec FR-17 budget of 250 KB compressed and fail the build if it
does not.

**Done when:** the file regenerates deterministically, stays under budget for the T-22 corpus, and
the size assertion has a test that fails when the budget is exceeded.

---

### T-27 · Lazy content loading

**Phase:** P2
**Create:** `apps/web/src/components/help/hooks/use-help-content.ts`

One module-level promise so a second open does not re-import. On rejection, set `degraded: true`
and never throw into render (spec S-20). Expose `{ bodies, postings, status }` where `status` is
`idle | loading | ready | degraded`.

**Done when:** blocking the chunk in devtools leaves the panel usable with title-and-summary search
and the `searchDegraded` footer line, and reading an article shows its summary plus a retry rather
than a crash.

---

### T-28 · Full ranking

**Phase:** P2
**Modify:** `apps/web/src/lib/help/help-search.ts`
**Create:** `apps/web/src/components/help/hooks/use-help-search.ts`

Pass `postings` into the ranking function so heading and body matches score per the spec FR-18
table; apply the `+5` current-screen boost from T-08. The hook debounces 120 ms and floors at 2
characters. A result whose best match was a heading opens the article at that heading (spec
FR-18.7).

**Done when:** the full score table is exercised by unit tests, and a body-only match ranks below
every title match.

---

### T-29 · No-results state

**Phase:** P2
**Create:** `apps/web/src/components/help/HelpNoResults.tsx`

Spec §6.5 minus the report control (which needs the P3 endpoint): the title and exactly three
actions — `Browse all articles`, `Ask the assistant about this` (hands the query to the existing
assistant panel; no model call of its own), `Contact support` (the external destination the
Resources tab already uses).

**Done when:** all three actions work and the raw query text is not captured by any telemetry
event (spec FR-19).

---

### T-30 · Recents and "On this screen"

**Phase:** P2
**Create:**

- `apps/web/src/lib/help/help-recents.ts`
- `apps/web/src/components/help/hooks/use-help-recents.ts`

`localStorage['help-recents']`, 5-entry cap, move-to-top on repeat, 90-day expiry, **every** access
wrapped in `try/catch` following the precedent in `apps/web/src/lib/hooks/use-theme.ts` and
`JobRuntimeDegradedBanner.tsx`. A throwing storage API degrades to "no recents", never to an error
boundary. Wire both groups into `HelpBrowse`.

**Done when:** with storage disabled the group is simply absent and nothing throws, and the "On this
screen" group is omitted when no article documents the current screen.

---

### T-31 · Copy link

**Phase:** P2
**Modify:** `apps/web/src/components/help/HelpArticleReader.tsx`

Copies the absolute `/help/<article>#<heading>` URL and toasts `Link copied` through the existing
toast mechanism.

**Done when:** pasting the copied URL into a fresh tab opens the same article at the same heading.

---

### T-32 · Palette Help group

**Phase:** P2
**Create:** `apps/web/src/components/command-palette/registry/help.source.ts` (path per
[AW-01 plan §5.3](../AW-01-command-palette/plan.md#53-components))
**Modify:** the palette's source registry.

A **client-side** source that ranks with `help-search.ts` and returns up to 5 rows in a `Help`
group. It must issue no request, so the group keeps working in the palette's offline state.
Activating a row closes the palette and calls `openHelpAt`; `Esc` from the panel returns focus to
the screen beneath, not to the palette (spec S-21).

**Done when:** typing a word from an article title in the palette shows a Help group with the
network disabled, and AW-01's existing `Open Help` command still works.

---

### T-33 · Tests — P2

**Phase:** P2
**Create:**

- `apps/web/src/lib/help/help-recents.unit.spec.ts`
- `apps/web/src/components/help/hooks/use-help-content.unit.spec.ts`
- `apps/web/e2e/help-search.spec.ts`

**Modify:** `apps/web/src/lib/help/help-search.unit.spec.ts` (heading and body scoring, the boost,
the caps), `apps/web/e2e/COVERAGE.md`.

`help-search.spec.ts` must assert **zero network requests** during search, the 1-vs-2 character
floor, the 20-total and 6-per-section caps, the no-results state, and the degraded footer line when
the content chunk is blocked.

**Done when:** `cd apps/web && pnpm test` and `pnpm test:e2e` both pass.

---

## Phase 3 — Feedback, content health, and the mirror

---

### T-34 · Entity: `HelpArticleFeedback`

**Phase:** P3
**Create:** `packages/agent/src/entities/help-article-feedback.entity.ts`

Implement exactly as in [plan.md §3.2](./plan.md#32-new-entity--the-only-one): uuid PK, `userId`
(uuid), nullable `articleId` (varchar 64), nullable `helpful` (boolean), nullable `note` (varchar
500), nullable `buildRef` (varchar 40), nullable `locale` (varchar 8), `createdAt` / `updatedAt`
timestamptz, unique `uq_help_article_feedback_user_article` on `(userId, articleId)`, indices on
`articleId` and `createdAt`. **No** `tenantId` / `organizationId` and **no** entity-level
`@ManyToOne` — both absences are requirements and must be stated in the doc comment, together with
the note that `articleId = NULL` rows are deliberately not collapsed by the unique index.

**Done when:** the file compiles and its doc comment cites spec FR-32, FR-35 and FR-36.

---

### T-35 · Entity registration (four files — a drift spec fails CI if any is missed)

**Phase:** P3
**Modify:**

- `packages/agent/src/entities/index.ts` — `export * from './help-article-feedback.entity';`
- `packages/agent/src/database/_entity-names.ts` — add `'HelpArticleFeedback'` in alphabetical
  position
- `packages/agent/src/database/_entities-inventory.ts` — add the import and the class to `ENTITIES`
- `packages/agent/src/database/_repository-inventory.ts` — add the repository only if the feature
  module does not own it; this epic's repository is owned by the new API module, so follow that
  file's stated rule and leave it alone if so

**Done when:** `cd packages/agent && pnpm test` passes, specifically the `database.module.spec.ts`
and `database.config.spec.ts` drift checks.

---

### T-36 · Migration (Constitution V — same PR as T-34)

**Phase:** P3
**Create:** `apps/api/src/migrations/1791250000000-CreateHelpArticleFeedback.ts`

Exactly as in [plan.md §3.4](./plan.md#34-migration--ships-in-the-same-pr-as-the-entity-constitution-v):
`createTable` with `ifNotExists`, the unique constraint, both indices, and the `userId` foreign key
to `users(id)` `ON DELETE CASCADE`. `down()` drops only this table. The timestamp is AW-25's
reserved slot 00 ([README §5 rule 10](../README.md#5-rules-every-epic-spec-in-this-program-must-follow)). Before merge, rebase on `develop`
and re-stamp the filename and class name if a newer migration has landed.

**Done when:** from `apps/api/`, `pnpm typeorm migration:run -d typeorm.config.ts` applies cleanly
on a fresh database **and** is a no-op on a database that already has the table, and `revert`
removes only this table.

---

### T-37 · Contracts: feedback DTOs

**Phase:** P3
**Create:** `packages/contracts/src/api/help/help.dto.ts`
**Modify:** `packages/contracts/src/api/help/index.ts`

`SubmitHelpFeedbackDto`, `HelpFeedbackAckDto`, `HelpArticleHealthDto` exactly as shaped in
[plan.md §3.3](./plan.md#33-new-shared-types-contracts-not-database). Additive only
(Constitution X).

**Done when:** all three compile and are importable from `@ever-works/contracts/api`.

---

### T-38 · API module

**Phase:** P3
**Create:**

- `apps/api/src/help/help.module.ts`
- `apps/api/src/help/help.controller.ts`
- `apps/api/src/help/help-feedback.service.ts`
- `apps/api/src/help/credential-shape.ts`
- `apps/api/src/help/dto/help-feedback.dto.ts`
  **Modify:** `apps/api/src/api.module.ts` — register `HelpModule` alongside the other feature
  modules.

Follow `apps/api/src/agent-approvals/agent-approvals.controller.ts` for shape: `@ApiTags('help')`,
`@Controller('api/help')`, `@CurrentUser()`, a header comment listing the routes, and `@Throttle` on
the write. Implement `POST /api/help/feedback` (upsert on the unique constraint; `422` when
`credential-shape.ts` matches; `400` on a bad article id, an over-length note, or a body with
neither a verdict nor a note; `20` per `3 600 s` per user) and
`GET /api/help/health-summary` (platform-admin only, counts per article, never a `userId`, never a
note to a non-admin). Every response carries `Cache-Control: private, no-store`.

**Done when:** `cd apps/api && pnpm test` passes and the OpenAPI document lists both routes.

---

### T-39 · BFF route

**Phase:** P3
**Create:** `apps/web/src/app/api/help/feedback/route.ts`

`POST`, wrapped in `bffProxy(handler)` from `apps/web/src/lib/api/bff-proxy.ts`. Validates the
article-id pattern and the note length cheaply, forwards with `cache: 'no-store'`, and maps
upstream `422` and `429` onto the two copy keys without leaking the upstream body.

**Done when:** the route returns the mapped errors and never echoes an upstream message.

---

### T-40 · The feedback control

**Phase:** P3
**Create:**

- `apps/web/src/components/help/HelpFeedback.tsx`
- `apps/web/src/components/help/hooks/use-help-feedback.ts`
  **Modify:** `apps/web/src/components/help/HelpArticleReader.tsx` — render it beneath the related
  list.

All six states in spec §6.10. The note field appears only after **No** and caps at 500 characters.
Disabled while in flight. Never retries and never queues. Sends `buildRef` and `locale`.

**Done when:** choosing Yes then No leaves exactly one stored response, and the offline, rate-limit,
credential and signed-out states each render their exact copy.

---

### T-41 · The no-results report control

**Phase:** P3
**Modify:** `apps/web/src/components/help/HelpNoResults.tsx`

Add `Tell us what you were looking for` → a 200-character field → `Send` / `Skip` → the
`reportSent` line, posting through the same endpoint with `articleId: null` and `helpful: null`
(spec S-13). This is the **only** path by which a query string is ever stored (spec FR-37).

**Done when:** the note reaches the API with a null article id, the credential rejection applies,
and dismissing the control records nothing.

---

### T-42 · Content-health service

**Phase:** P3
**Create:**

- `packages/agent/src/help/help-content-health.service.ts`
- `packages/agent/src/help/index.ts`

Aggregate the last 7 days per article; flag `responses >= 10 && negativeShare >= 0.4` (spec FR-48);
flag articles whose `reviewedAt` is older than 180 days, omitting that half of the summary with a
stated reason when the catalogue is not resolvable from the worker; delete rows older than 400 days
(spec FR-36); write one activity-log entry summarising the pass.

**Done when:** the service is pure of any job-runtime SDK import and is unit-testable with a mocked
repository.

---

### T-43 · Scheduled job (Constitution IV)

**Phase:** P3
**Create:** `packages/tasks/src/tasks/trigger/help-content-health.task.ts`
**Modify:** `packages/tasks/src/tasks/trigger/index.ts`

Copy the shape of `packages/tasks/src/tasks/trigger/anonymous-user-cleanup.task.ts`: a
`schedules.task()` registered through the configured job-runtime provider's native cron mechanism,
weekly on Mondays at `07:41 UTC` (deliberately staggered off the round hours the other jobs use), a
Nest context built from `TriggerInternalModule`, and the T-42 service doing the work. There must be
**no** `@Cron` decorator on the API process and **no** `@trigger.dev/sdk` import outside
`packages/tasks`.

**Done when:** the task appears in the runtime provider's schedule list, `cd packages/agent &&
pnpm test` still passes, and grepping the API app for `@Cron` returns no new hit.

---

### T-44 · Print styles

**Phase:** P3
**Modify:** `apps/web/src/app/[locale]/(dashboard)/help/[slug]/page.tsx` and its stylesheet.

Printing keeps the title, body, headings and build stamp; hides the sidebar, top bar, drawer, "On
this page" list and the feedback control (spec FR-45).

**Done when:** a print preview of an article shows the article alone on a clean page.

---

### T-45 · Documentation-site mirror (optional)

**Phase:** P3
**Create:** `apps/web/scripts/export-help-docs.mjs`
**Modify:** `apps/docs/sidebarsPlatform.ts` — one new category entry.

Generates a `docs/help/` mirror of the manual for the published site, each page carrying a banner
stating that the in-product manual for the reader's own build is the authoritative copy. Run as a
release step, not on every build.

**Done when:** the generated pages appear under the new sidebar category and the banner is present
on every one.

---

### T-46 · Tests — P3

**Phase:** P3
**Create:**

- `apps/api/src/help/help.controller.spec.ts`
- `apps/api/src/help/help-feedback.service.spec.ts`
- `apps/api/src/help/credential-shape.spec.ts`
- `packages/agent/src/help/__tests__/help-content-health.service.spec.ts`
- `apps/web/src/components/help/HelpFeedback.unit.spec.tsx`
- `apps/web/src/app/api/help/feedback/route.unit.spec.ts`
- `apps/web/e2e/help-feedback.spec.ts`
  **Modify:** `apps/web/e2e/COVERAGE.md`

Cover exactly the rows in [plan.md §10.2–10.4](./plan.md#102-unit--api-jest-appsapijestconfigjs-rootdir-src-spects). The
boundary cases are load-bearing: 9 responses must not flag, exactly 40% negative must flag, exactly
180 days must count as stale, and a rejected credential note must appear in no log line.

**Done when:** `cd apps/api && pnpm test`, `cd packages/agent && pnpm test`, `cd apps/web &&
pnpm test` and `pnpm test:e2e` all pass, and `COVERAGE.md` carries a row for the new controller.

---

### T-47 · Telemetry — P3 events

**Phase:** P3
**Modify:** `HelpFeedback.tsx`, `HelpNoResults.tsx`, `use-help-content.ts`.

Add `help_feedback_submitted`, `help_search` (including `zero_results`) and
`help_content_load_failed` with exactly the properties in
[plan.md §9.1](./plan.md#91-telemetry). Assert in a unit test that no payload carries query text or
note text.

**Done when:** the events fire once per action and the assertion test passes.

---

## Definition of done for the epic

- [ ] Every acceptance-criteria box in [spec.md §8](./spec.md#8-acceptance-criteria) is ticked.
- [ ] `pnpm lint`, `pnpm type-check` and `pnpm test` are green from the repository root.
- [ ] `cd apps/web && pnpm test:e2e` is green.
- [ ] The migration applies and reverts cleanly, and shipped in the same PR as the entity.
- [ ] Deliberately pointing an article at a removed screen fails the build; deliberately pointing a
      help link at a removed article fails `pnpm type-check`.
- [ ] `apps/web/e2e/COVERAGE.md` has no unchecked row introduced by this epic.
- [ ] [TRACKER.md](../TRACKER.md)'s AW-25 row is updated.
