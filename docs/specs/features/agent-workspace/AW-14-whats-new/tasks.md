# AW-14 — What's new · in-product changelog · Task List

**Epic:** `AW-14-whats-new` · **Program:** [Agent Workspace](../README.md)
**Spec:** [spec.md](./spec.md) · **Plan:** [plan.md](./plan.md)
**Status:** Draft v1 · **Date:** 2026-09-06

Execute top to bottom. Every task names the exact files to create or modify and what "done"
means. Phases are independently shippable; each ends with `develop` green.

**Repo commands used below** (from `CLAUDE.md`): `pnpm lint`, `pnpm type-check`,
`cd apps/api && pnpm test`, `cd packages/agent && pnpm test`, `cd apps/web && pnpm test`,
`cd apps/web && pnpm test:e2e`.

---

## Phase 1 — The count and the panel

Ships: a top-bar control with an honest unread count, a panel that lists updates, per-entry
read tracking, and mark-all-read. No filters, no calls-to-action, no full page yet.

---

### T-01 · Contracts: category and kind enums

**Phase:** P1
**Create:** `packages/contracts/src/api/changelog/changelog.enum.ts`

Export `CHANGELOG_CATEGORIES` (`as const` tuple of exactly `agents`, `decisions`, `knowledge`,
`connections`, `costs`, `platform`) with derived type `ChangelogCategory`, and
`CHANGELOG_KINDS` (`new`, `improved`, `fixed`, `security`) with derived type `ChangelogKind`.
Doc-comment each referencing spec FR-9 / FR-10 and stating that kind is a badge, never a filter.

**Done when:** both tuples are `as const`, both derived types are unions of literals, and
`tsc` resolves them from `@ever-works/contracts/api` after T-03.

---

### T-02 · Contracts: wire DTOs

**Phase:** P1
**Create:** `packages/contracts/src/api/changelog/changelog.dto.ts`

Declare `ChangelogEntryDto`, `ChangelogListResponseDto`, `ChangelogUnreadCountResponseDto`,
`ChangelogMarkReadResponseDto` exactly as shaped in [plan.md §3.6](./plan.md#36-dtos--wire-contracts).
`cta` is `{ label, href } | null`; `unreadCount` on the list response is documented as always
unfiltered (spec FR-38).

**Done when:** the four interfaces compile and carry doc comments citing the FRs they encode.

---

### T-03 · Contracts: barrel exports

**Phase:** P1
**Create:** `packages/contracts/src/api/changelog/index.ts`
**Modify:** `packages/contracts/src/api/index.ts`

Re-export both files from the folder index; add one `export * from './changelog/index.js';`
line to the API barrel, following the existing comment style (a one-line note naming the epic).

**Done when:** `import { CHANGELOG_CATEGORIES } from '@ever-works/contracts/api'` type-checks
from `apps/api` and `apps/web`, and `pnpm type-check` passes.

---

### T-04 · Entity: `ProductChangelogRead`

**Phase:** P1
**Create:** `packages/agent/src/entities/product-changelog-read.entity.ts`

Implement exactly as in [plan.md §3.2](./plan.md#32-new-entity): `@Entity('product_changelog_reads')`,
uuid PK `id`, `userId` (uuid), `entrySlug` (varchar 64), `readAt` (`@CreateDateColumn`,
timestamptz), unique `uq_product_changelog_read_user_entry` on `(userId, entrySlug)`, index
`idx_product_changelog_read_user` on `(userId)`. **No** `tenantId` / `organizationId` columns and
**no** entity-level `@ManyToOne` — both absences are requirements (spec FR-13) and must be stated
in the doc comment so a later scope sweep does not "fix" them.

**Done when:** the file compiles and its doc comment names spec FR-12, FR-13, FR-21 and FR-22.

---

### T-05 · Entity registration (four files — a drift spec fails CI if any is missed)

**Phase:** P1
**Modify:**
- `packages/agent/src/entities/index.ts` — add `export * from './product-changelog-read.entity';`
- `packages/agent/src/database/_entity-names.ts` — add `'ProductChangelogRead'` to
  `AGENT_ENTITY_NAMES` in alphabetical position
- `packages/agent/src/database/_entities-inventory.ts` — add the import and the class to the
  `ENTITIES` array (consumed by `database.config.ts:52` / `:113`)

**Done when:** `cd packages/agent && pnpm test` passes, specifically
`database.module.spec.ts`'s drift checks and `database.config.spec.ts`.

---

### T-06 · Repository

**Phase:** P1
**Create:** `packages/agent/src/database/repositories/product-changelog-read.repository.ts`
**Modify:** `packages/agent/src/database/_repository-inventory.ts` (import + entry in
`REPOSITORY_PROVIDERS`, alphabetical), `packages/agent/src/database/index.ts` (barrel line)

Model on `packages/agent/src/database/repositories/notification-event-type.repository.ts`.
Methods:

- `findReadSlugs(userId: string, slugs: string[]): Promise<Set<string>>`
- `markRead(userId: string, slugs: string[]): Promise<void>` — a single insert with
  `orIgnore()` so concurrent tabs cannot conflict (spec FR-18, S-17)
- `countUnread(userId: string, candidateSlugs: string[]): Promise<number>` — the
  `NOT EXISTS` count from [plan.md §4](./plan.md#4-api-surface)
- `deleteBySlugsNotIn(slugs: string[], olderThan: Date): Promise<number>` — used only by the
  P3 prune; ship it now so the prune is a wiring change later, not a schema change

**Done when:** `REPOSITORY_PROVIDERS.length` assertions in `database.module.spec.ts` pass and
the repository is importable from `@ever-works/agent/database`.

---

### T-07 · Migration (same PR as T-04 — Constitution V)

**Phase:** P1
**Create:** `apps/api/src/migrations/1791140000000-CreateProductChangelogReads.ts`

Copy the body from [plan.md §3.4](./plan.md#34-migration-constitution-v--ships-in-the-same-pr-as-the-entity).
Create-only with `ifNotExists`; unique constraint; index; FK on `userId` → `users(id)`
`ON DELETE CASCADE`; `down()` drops only `product_changelog_reads`.

**Before merge:** the timestamp is AW-14's reserved slot 00 ([README §5 rule 10](../README.md#5-rules-every-epic-spec-in-this-program-must-follow)). Rebase on
`develop`; if a migration with a higher timestamp has landed, re-stamp the filename and class name.

**Done when:** `cd apps/api && pnpm typeorm migration:run -d typeorm.config.ts` applies cleanly
against a fresh database, a second run is a no-op, and `migration:revert` drops the table
without touching anything else.

---

### T-08 · The catalogue

**Phase:** P1
**Create:** `apps/api/src/changelog/changelog.catalog.ts`

Declare `ChangelogCatalogEntry` and the frozen `CHANGELOG_ENTRIES` array per
[plan.md §3.5](./plan.md#35-the-catalogue). Seed it with the genuine entries for what has
already shipped in the last two releases — a minimum of **5** real entries spanning at least
**3** categories and at least **2** kinds, so every surface has something honest to render.
Set `cta` on the entries that have an obvious destination; leave the field absent otherwise
(the CTA is not rendered until P2 regardless).

The file header states, in one paragraph: entries ship with the build, adding one is a code
change, and the constraints are enforced by `changelog.catalog.spec.ts`.

**Done when:** the array is `as const`, every entry satisfies the FR-5/6/8 limits by
inspection, and `pnpm type-check` passes.

---

### T-09 · Changelog service

**Phase:** P1
**Create:** `apps/api/src/changelog/changelog.service.ts`

Implement against `ProductChangelogReadRepository` and `CHANGELOG_ENTRIES`:

- `visibleEntries(now: Date)` — drops `publishedAt > now` (spec FR-7); sorts pinned first, then
  `publishedAt` desc, ties by slug asc (spec FR-8). Memoise per process; the array is frozen.
- `list(userId, accountCreatedAt, { category?, limit = 20, cursor? })` — clamp `limit` to 50;
  cursor is the slug of the last returned entry; returns `ChangelogListResponseDto` including
  `total`, always-unfiltered `unreadCount`, and `categoriesWithEntries`.
- `getBySlug(userId, accountCreatedAt, slug)` — `null` for absent **and** scheduled (spec S-15).
- `unreadCount(userId, accountCreatedAt)` — newest 50 visible entries, drop those with
  `publishedAt <= accountCreatedAt` (spec FR-14), count the rest without a read row (spec FR-15).
- `markRead(userId, slugs)` — ignore slugs absent from the catalogue; return the fresh count.
- `markAllRead(userId, accountCreatedAt)` — every visible unread entry regardless of any
  filter (spec FR-19); returns `{ unreadCount: 0 }`.

**Done when:** every bullet above has a matching case in T-13 and `cd apps/api && pnpm test`
passes.

---

### T-10 · Request DTO

**Phase:** P1
**Create:** `apps/api/src/changelog/dto/mark-changelog-read.dto.ts`

`MarkChangelogReadDto` with `@IsArray`, `@ArrayNotEmpty`, `@ArrayMaxSize(25)`,
`@IsString({ each: true })`, `@Matches(/^[a-z0-9-]{3,64}$/, { each: true })` (spec FR-6, FR-17).

**Done when:** the global `ValidationPipe` rejects an empty array, 26 slugs, and a slug with an
uppercase letter or a `/`.

---

### T-11 · Controller

**Phase:** P1
**Create:** `apps/api/src/changelog/changelog.controller.ts`

`@ApiTags('Changelog')`, `@ApiBearerAuth('JWT-auth')`, `@Controller('api/changelog')`,
`@UseGuards(AuthSessionGuard)`, `@CurrentUser()` for the account, and
`@Header('Cache-Control', 'private, no-store')` on every handler. Routes and throttles exactly
as [plan.md §4](./plan.md#4-api-surface):

| Handler | Route | Throttle |
| --- | --- | --- |
| `list` | `GET /` | `{ long: { limit: 120, ttl: 60_000 } }` |
| `unreadCount` | `GET /unread-count` | `{ long: { limit: 120, ttl: 60_000 } }` |
| `getOne` | `GET /:slug` | `{ long: { limit: 120, ttl: 60_000 } }` |
| `markRead` | `POST /read` | `{ long: { limit: 60, ttl: 60_000 } }` |
| `markAllRead` | `POST /read-all` | `{ long: { limit: 10, ttl: 60_000 } }` |

`GET /unread-count` **must** be declared before `GET /:slug`. `getOne` returns `404` with an
identical body for absent and scheduled entries. Full `@ApiOperation` / `@ApiQuery` /
`@ApiParam` / `@ApiResponse` annotations so the MCP server and OpenAPI doc pick the routes up.
A doc comment states that this controller is deliberately **not** workspace-scoped (spec FR-13).

**Done when:** the routes respond as specified against a running API and T-14 passes.

---

### T-12 · Module registration

**Phase:** P1
**Create:** `apps/api/src/changelog/changelog.module.ts`
**Modify:** `apps/api/src/api.module.ts`

The module imports whatever `DatabaseModule` wiring exposes `ProductChangelogReadRepository`,
provides `ChangelogService`, declares `ChangelogController`, and exports `ChangelogService`.
Register `ChangelogModule` in `api.module.ts`'s `imports` array next to `NotificationsModule`
(line ~136), with a one-line comment naming this epic.

**Done when:** the API boots with `pnpm dev:api` and `GET /api/changelog/unread-count` returns
`401` unauthenticated and `{ "count": … }` authenticated.

---

### T-13 · Service spec

**Phase:** P1
**Create:** `apps/api/src/changelog/changelog.service.spec.ts`

Cases, one `it` each: scheduled entries excluded; pinned sorts first; `publishedAt desc` with
slug-asc tie-break; cursor paging returns disjoint pages and `nextCursor: null` on the last
page; `limit` clamps at 50; category filter narrows entries but never `unreadCount`;
`categoriesWithEntries` lists only categories with visible entries; signup baseline — an entry
older than the account is read with zero rows written; unread capped at 50 candidates; unknown
slugs in `markRead` are ignored; `markRead` twice is a no-op; `markAllRead` twice is a no-op;
`markAllRead` ignores an active category filter.

**Done when:** all cases pass and each references its FR number in the `it` title.

---

### T-14 · Controller spec

**Phase:** P1
**Create:** `apps/api/src/changelog/changelog.controller.spec.ts`

Model on `apps/api/src/notifications/notifications.controller.spec.ts`. Assert: `AuthSessionGuard`
is applied to the controller; every response sets `Cache-Control: private, no-store`;
`GET /unread-count` resolves to the count handler and not to `getOne`; `getOne` 404s identically
for an absent slug and a scheduled slug; `MarkChangelogReadDto` rejects `[]`, 26 slugs and a
malformed slug; the five `@Throttle` configurations match spec FR-44.

**Done when:** `cd apps/api && pnpm test` is green.

---

### T-15 · Web API client

**Phase:** P1
**Create:** `apps/web/src/lib/api/changelog.ts`

`import 'server-only'`, built on `serverFetch` / `serverMutation` from
`apps/web/src/lib/api/server-api.ts`, mirroring `apps/web/src/lib/api/notifications.ts`.
Export `changelogAPI` with `list`, `get`, `unreadCount`, `markRead`, `markAllRead`.
`unreadCount` is wrapped in `cache()` with `next: { revalidate: 300 }` and returns `null` on
any failure — copy the shape and the doc comment style of `apps/web/src/lib/api/version.ts`
(spec FR-31, FR-47).

**Done when:** the module type-checks, re-uses the contracts types from T-02 rather than
redeclaring them, and never throws out of `unreadCount`.

---

### T-16 · Server actions

**Phase:** P1
**Create:** `apps/web/src/app/actions/changelog.ts`

`'use server'`. Export `getChangelog(params)`, `getChangelogUnreadCount()`,
`markChangelogRead(slugs)`, `markAllChangelogRead()`. Each returns a
`{ success, …, error }` result object and never throws, mirroring
`apps/web/src/app/actions/notifications.ts`.

**Done when:** every action returns `{ success: false, error }` for a failing API call and the
panel can be driven entirely through these four.

---

### T-17 · Top-bar control

**Phase:** P1
**Create:** `apps/web/src/components/dashboard/WhatsNewButton.tsx`

Props: `{ unreadCount: number | null; onOpen: () => void; isOpen: boolean }`. Sparkle icon from
`lucide-react`, wrapped in `Tooltip` from `apps/web/src/components/ui/tooltip.tsx`. Badge is
rendered only when `unreadCount >= 1`; renders `9+` above 9 (spec FR-24). Accessible name comes
from `dashboard.whatsNew.controlLabel` / `controlLabelUnread`; `aria-expanded` reflects
`isOpen`; `aria-haspopup="dialog"`. Styling mirrors the badge treatment in
`apps/web/src/components/dashboard/NotificationDropdown.tsx`. **No polling.**

**Done when:** T-24 passes and the control renders identically at 375 px and 1440 px.

---

### T-18 · Panel shell

**Phase:** P1
**Create:** `apps/web/src/components/whats-new/WhatsNewPanel.tsx`

Headless UI `Dialog` + `Transition` right slide-over, `w-full sm:w-[420px]`, built by copying
the structure of `apps/web/src/components/dashboard/HelpDrawer.tsx` (same imports, same
`open`/`onClose` prop contract, same close-button treatment). Heading
`dashboard.whatsNew.title`; subheading switches between `subtitleUnread`, `subtitleUnreadOne`
and `subtitleCaughtUp`. Close button's accessible name is `dashboard.whatsNew.close`.
Initial focus lands on the heading; focus is trapped while open and restored to the opener on
close (spec FR-51). Fetches page 1 **on open**, not on mount.

**Done when:** `Escape` closes and returns focus to the control, and the dialog is announced
with its heading by a screen reader.

---

### T-19 · Entry card

**Phase:** P1
**Create:** `apps/web/src/components/whats-new/ChangelogEntryCard.tsx`

Renders: unread dot plus an `sr-only` `dashboard.whatsNew.unread` (spec FR-53); kind badge from
`dashboard.whatsNew.kinds.*`; category label from `dashboard.whatsNew.filters.*`; date formatted
for the active locale; title; body as plain text with `white-space: pre-line` and **no markup
interpretation** (spec FR-5). Read state changes only the dot and the title weight — never the
card's position, size or presence (spec FR-20). CTA and permalink slots exist but render
nothing in P1.

**Done when:** a body containing `<b>x</b>` renders literally, and a read card occupies exactly
the same box as an unread one.

---

### T-20 · Shared list body

**Phase:** P1
**Create:** `apps/web/src/components/whats-new/ChangelogList.tsx`

One implementation used by both the panel and (in P2) the page. Renders four states: skeletons
(3 cards, no spinner, no text), the list, the global empty state, and the error state with a
retry button. Empty states use `apps/web/src/components/common/EmptyState.tsx` — do not write
a new empty-state component.

**Done when:** each of the four states is reachable from props alone and matches the wireframes
in [spec.md §6.3–§6.6](./spec.md#6-ux).

---

### T-21 · Read tracker hook

**Phase:** P1
**Create:** `apps/web/src/components/whats-new/use-changelog-read-tracker.ts`

`IntersectionObserver` at `threshold: 0.5`; a per-entry 1000 ms dwell timer; a 2000 ms batching
window flushing at most 25 slugs per call (spec FR-16, FR-17). Also flushes on unmount and on
`document.visibilitychange → hidden`. Retries a failed flush at most twice, then drops silently
and surfaces nothing to the reader (spec FR-48). Calls back with the server's fresh
`unreadCount` so the badge updates without re-fetching the list.

**Done when:** T-27 passes, including the "< 1000 ms visibility does not mark" case.

---

### T-22 · Shell wiring

**Phase:** P1
**Modify:**
- `apps/web/src/app/[locale]/(dashboard)/layout.tsx` — add
  `changelogAPI.unreadCount().catch(() => null)` as an 8th entry in the existing `Promise.all`
  and pass `changelogUnreadCount` down
- `apps/web/src/app/[locale]/(dashboard)/layout-client.tsx` — add `whatsNewOpen` state
  (mirroring the existing `helpOpen`), a `unreadCount` state seeded from the prop, and mount
  `<WhatsNewPanel />` beside `<HelpDrawer />`
- `apps/web/src/components/dashboard/DashboardHeader.tsx` — new **optional** prop
  `whatsNew?: { unreadCount: number | null; onOpen: () => void }`; render `<WhatsNewButton />`
  immediately before `<NotificationDropdown />`

**Done when:** every existing `DashboardHeader` call site still compiles with the prop omitted,
the shell still renders when the count fetch fails (no badge, no error), and no new
`setInterval` exists anywhere in the diff.

---

### T-23 · i18n — English

**Phase:** P1
**Modify:** `apps/web/messages/en.json`

Add the full `dashboard.whatsNew` namespace from [plan.md §8](./plan.md#8-i18n), inserted
alphabetically within the `dashboard` object. Every leaf name is camelCase; **no leaf name
contains a literal `.`** — a dot in a leaf key is a runtime next-intl failure that reds five or
more e2e shards at once.

**Done when:** the JSON parses, no leaf key contains `.`, and the panel renders with no
`MISSING_MESSAGE` console errors.

---

### T-24 · i18n — the other 20 locales

**Phase:** P1
**Modify:** `apps/web/messages/{ar,bg,de,es,fr,he,hi,id,it,ja,ko,nl,pl,pt,ru,th,tr,uk,vi,zh}.json`

Mirror the same key structure with translated values. Keys are identical to `en.json` in every
file.

**Done when:** a script or manual diff confirms all 21 files carry the identical
`dashboard.whatsNew` key set, and the hydration/console-error e2e sweep is green.

---

### T-25 · Web unit spec — control

**Phase:** P1
**Create:** `apps/web/src/components/dashboard/WhatsNewButton.unit.spec.tsx`

No badge at `0`; no badge at `null`; `3` renders `3`; `27` renders `9+`; the accessible name
switches between `controlLabel` and `controlLabelUnread`; `aria-expanded` follows `isOpen`.

---

### T-26 · Web unit spec — panel

**Phase:** P1
**Create:** `apps/web/src/components/whats-new/WhatsNewPanel.unit.spec.tsx`

Skeletons render while loading; the global empty state renders its own copy; the error state
offers a working retry; `Escape` closes and restores focus to the opener.

---

### T-27 · Web unit spec — read tracker

**Phase:** P1
**Create:** `apps/web/src/components/whats-new/use-changelog-read-tracker.unit.spec.ts`

50 % visible for 999 ms → no mark; for 1000 ms → mark; two entries within one 2000 ms window →
a single batched call; 30 entries → two calls, the first with exactly 25 slugs; unmount flushes
pending slugs; tab hide flushes; a failing flush retries twice then stops silently.

---

### T-28 · E2E — the golden path

**Phase:** P1
**Create:** `apps/web/e2e/whats-new-panel.spec.ts`

Sign in as an account created before the seeded entries → the badge shows the expected count →
open the panel → scroll the first entry into view → the badge decrements and the entry does not
move → "Mark all as read" → the badge disappears → reload → still no badge.

---

### T-29 · E2E — degradation

**Phase:** P1
**Create:** `apps/web/e2e/whats-new-degraded.spec.ts`

Route-intercept `**/api/changelog/unread-count` → 500: the shell renders, the control is
present, **no badge** and no error toast. Intercept `**/api/changelog` → 500: the panel shows
the error state and the retry works once the intercept is removed. Intercept
`**/api/changelog/read` → 500: reading is unaffected and nothing is surfaced to the reader.

---

### T-30 · Phase 1 gate

**Phase:** P1

Run `pnpm lint`, `pnpm type-check`, `cd packages/agent && pnpm test`,
`cd apps/api && pnpm test`, `cd apps/web && pnpm test`, and the two new Playwright specs.

**Done when:** all green, and a manual pass confirms the [spec.md §8](./spec.md#8-acceptance-criteria)
checklist items under *Count and read state* and *Failure and degradation*.

---

## Phase 2 — Filters, calls-to-action, and the page

Ships: category chips, CTAs with a build-time safety gate, pinning, and the full-page archive
with permalinks.

---

### T-31 · Safe in-app path helper

**Phase:** P2
**Create:** `apps/web/src/lib/utils/safe-nav-target.ts`
**Create:** `apps/web/src/lib/utils/safe-nav-target.unit.spec.ts`

`isSafeInAppPath(raw: string): boolean` — exactly one leading `/`, rejects `//`, `/\`, any
scheme, and any string containing a backslash (spec FR-39). The doc comment notes that
`apps/web/src/components/dashboard/NotificationDropdown.tsx` carries an equivalent private
guard, that this epic deliberately does **not** touch it, and that consolidating them is a
follow-up.

Spec cases: accepts `/works/1`, `/settings/usage?tab=costs`; rejects `//evil.example`,
`/\evil`, `https://evil.example`, `javascript:alert(1)`, `mailto:a@b.c`, `''`, `'   '`,
`/a\b`.

---

### T-32 · Catalogue spec — the CI authoring gate

**Phase:** P2
**Create:** `apps/api/src/changelog/changelog.catalog.spec.ts`

This is the guard spec FR-41 requires; it is a product requirement, not test hygiene. For every
entry in `CHANGELOG_ENTRIES`: slug matches `^[a-z0-9-]{3,64}$`; slugs are unique across the
array; title ≤ 80; body ≤ 600 and ≤ 3 paragraphs; `category` ∈ `CHANGELOG_CATEGORIES`;
`kind` ∈ `CHANGELOG_KINDS`; `publishedAt` parses as ISO-8601; CTA label ≤ 32; CTA href passes
the same predicate as `isSafeInAppPath` **and** resolves to a route the build serves (compare
against the string values and builder outputs of `ROUTES` in
`apps/web/src/lib/constants.ts`, or a shared route list extracted for the purpose). Exactly one
entry at most has `pinned: true`.

**Done when:** deliberately corrupting one entry in each of those ways fails the spec with a
message naming the offending slug.

---

### T-33 · Pinning

**Phase:** P2
**Modify:** `apps/api/src/changelog/changelog.service.ts`,
`apps/web/src/components/whats-new/ChangelogEntryCard.tsx`

Sorting already places pinned first (T-09); render the `dashboard.whatsNew.pinned` marker on the
card. A pinned entry is still subject to read state and still counts toward the unread total.

**Done when:** the wireframe in [spec.md §6.2](./spec.md#62-panel--loaded-with-unread-entries)
is reproduced with a pinned entry, and T-32 fails if a second entry is pinned.

---

### T-34 · Filter chips

**Phase:** P2
**Create:** `apps/web/src/components/whats-new/ChangelogFilterChips.tsx`
**Create:** `apps/web/src/components/whats-new/ChangelogFilterChips.unit.spec.tsx`
**Modify:** `apps/web/src/components/whats-new/ChangelogList.tsx` (filtered empty state),
`apps/web/src/components/whats-new/WhatsNewPanel.tsx` (chip row + reset-to-`All` on open)

7 chips (`All` + the 6 categories). Roving tabindex: the row is one tab stop, `←`/`→` move
between chips, selection follows focus, `Enter`/`Space` also select (spec FR-52). A category
absent from `categoriesWithEntries` renders **disabled**, not hidden, with the
`dashboard.whatsNew.filters.emptyTooltip` tooltip (spec FR-37). The filtered empty state uses
`emptyFiltered.*` copy and its "Show all updates" action clears the filter (spec S-12). The
panel's filter resets to `All` on every open (spec FR-35), and the badge never changes with the
filter (spec FR-38).

---

### T-35 · Call-to-action rendering

**Phase:** P2
**Modify:** `apps/web/src/components/whats-new/ChangelogEntryCard.tsx`
**Create:** `apps/web/src/components/whats-new/ChangelogEntryCard.unit.spec.tsx`

Render the CTA button when `cta` is present **and** `isSafeInAppPath(cta.href)`; otherwise
render nothing and keep the rest of the card intact (spec FR-40). Activating it closes the
panel, navigates client-side via `router.push` (no full reload, no new tab), and marks the entry
read immediately (spec FR-42). The changelog never inspects the reader's plan or connections to
decide whether to show the button (spec FR-43).

Spec cases: safe href renders the button; each unsafe form from T-31 renders no button while the
title and body still render; activating the button fires exactly one read call for that slug.

---

### T-36 · Route constant and page metadata

**Phase:** P2
**Modify:** `apps/web/src/lib/constants.ts` (add `DASHBOARD_WHATS_NEW: '/whats-new'` with a
comment naming this epic), `apps/web/messages/en.json` + the 20 locales (add
`metadata.pages.whatsNew`)

**Done when:** no component hardcodes `'/whats-new'`; every reference goes through `ROUTES`.

---

### T-37 · Full page

**Phase:** P2
**Create:** `apps/web/src/app/[locale]/(dashboard)/whats-new/page.tsx`,
`apps/web/src/app/[locale]/(dashboard)/whats-new/whats-new-client.tsx`

Server component reads `?category=` and `?entry=`, fetches page 1 and passes it down; the client
renders the shared `ChangelogList` with month headings derived from entry dates (never
authored), `Load more` paging to the 200 cap with the `capReached` message at the end, a
per-entry permalink copy button with the `linkCopied` toast (`sonner`, already mounted app-wide),
scroll-to-and-highlight for `?entry=` lasting 2000 ms, the `notFound.*` state for an unknown
slug, and `?category=` reflected in the address so a filtered view is shareable (spec FR-36).

**Done when:** the wireframes in [spec.md §6.7](./spec.md#67-full-page--see-all-updates) and
[§6.8](./spec.md#68-full-page--permalink-to-an-entry-this-build-doesnt-have) are reproduced and
an unknown slug renders the version message rather than a 500 or a blank page.

---

### T-38 · Discovery links

**Phase:** P2
**Modify:** `apps/web/src/components/whats-new/WhatsNewPanel.tsx` (footer "See all updates" →
`ROUTES.DASHBOARD_WHATS_NEW`), `apps/web/src/components/dashboard/HelpDrawer.tsx` (one entry in
the Resources tab that opens the panel)

If the command palette from AW-01 is present on `develop` at the time, also register a
"What's new" command that opens the panel. If it is not, skip it — this epic must not depend on
it.

**Done when:** the panel is reachable from the top bar, the Help drawer and (when available) the
palette, and no existing Help-drawer content was removed or reordered.

---

### T-39 · E2E — the page

**Phase:** P2
**Create:** `apps/web/e2e/whats-new-page.spec.ts`

`/whats-new` renders month groups → a filter chip narrows the list and appears in the address →
`Load more` appends without duplicating → copying a permalink and opening it in a fresh context
scrolls to and highlights the entry → a bogus slug renders the version-message state.

---

### T-40 · Accessibility sweep

**Phase:** P2
**Modify:** `apps/web/e2e/accessibility.spec.ts`, `apps/web/e2e/accessibility-axe-deep.spec.ts`

Add `/whats-new` to the swept route list, and add an assertion pass over the open panel.

**Done when:** both sweeps are green with zero new violations, and every keyboard affordance in
[spec.md §6.10](./spec.md#610-keyboard-affordances) is verified by hand.

---

### T-41 · Phase 2 gate

**Phase:** P2

Full command sweep as T-30, plus a manual pass over the [spec.md §8](./spec.md#8-acceptance-criteria)
checklist items under *Catalogue and publishing*, *Surfaces* and *Filters*.

---

## Phase 3 — Polish and hygiene

---

### T-42 · Telemetry

**Phase:** P3
**Modify:** `apps/web/src/components/whats-new/WhatsNewPanel.tsx`,
`ChangelogEntryCard.tsx`, `use-changelog-read-tracker.ts`,
`apps/web/src/app/[locale]/(dashboard)/whats-new/whats-new-client.tsx`

Capture the four events from [plan.md §9.1](./plan.md#91-telemetry) through the PostHog provider
already mounted at `apps/web/src/components/posthog/PostHogProvider.tsx`:
`changelog_opened`, `changelog_entry_read`, `changelog_cta_followed`,
`changelog_mark_all_read`. Properties are limited to slug, category, surface, trigger and
counts — **no title, no body text, no dwell time, no referrer** (spec FR-49, FR-50).

**Done when:** the four events appear in the project's event list with the specified properties
and nothing else.

---

### T-43 · Focus-refresh of the unread count

**Phase:** P3
**Modify:** `apps/web/src/app/[locale]/(dashboard)/layout-client.tsx`

On window `focus`, refetch the count **only** when ≥ 900 000 ms have passed since the last
fetch (spec FR-31, S-16). Track the timestamp in a ref; do not add an interval.

**Done when:** a grep of the whole feature diff finds no `setInterval`, and two tabs reconcile
their badges after a refocus.

---

### T-44 · Authoring guide and the release habit

**Phase:** P3
**Create:** `apps/api/src/changelog/README.md`
**Modify:** the repository pull-request template

The README covers, in under a page: what earns an entry and what does not; the 6 categories and
which one to pick; the 4 kinds; the character limits; how to write a body a non-technical owner
understands; when to set a CTA and when not to; how to schedule an entry with a future
`publishedAt`; and the fact that `changelog.catalog.spec.ts` will fail the build before a
reviewer has to.

The PR template gains one line: *"Does this change need a What's-new entry? (see
`apps/api/src/changelog/README.md`)"*.

**Done when:** a contributor who has never seen this epic can add a correct entry using the
README alone.

---

### T-45 · Orphan-read prune — only if row counts warrant it

**Phase:** P3 (conditional)

Skip unless `product_changelog_reads` growth justifies it. If it does: declare
`PRODUCT_CHANGELOG_PRUNE_DISPATCHER` in `packages/agent/src/tasks/`, bind it through the
factory in `packages/agent/src/tasks/job-runtime.providers.ts`, and have the job call
`ProductChangelogReadRepository.deleteBySlugsNotIn(currentSlugs, thirtyDaysAgo)` (spec FR-22).

**Constraints:** call sites depend only on the `*_DISPATCHER` DI symbol; no `@Cron` on the API
process; no vendor SDK import anywhere outside the binding factory (Constitution IV).

**Done when:** the job runs under the configured runtime, is idempotent, and deletes nothing
whose slug is still in the running build.

---

### T-46 · Phase 3 gate and epic close-out

**Phase:** P3

Full command sweep. Walk the entire [spec.md §8](./spec.md#8-acceptance-criteria) checklist.
Then update [`../TRACKER.md`](../TRACKER.md) with this epic's implementation status and settle
the open questions in [spec.md §9](./spec.md#9-open-questions) that Phase 3 answered — at
minimum Q-2 (the destination of the 200-entry cap message) and Q-5 (the mobile placement of the
control).

---

## Task index

| # | Task | Phase |
| --- | --- | --- |
| T-01 | Contracts: category and kind enums | P1 |
| T-02 | Contracts: wire DTOs | P1 |
| T-03 | Contracts: barrel exports | P1 |
| T-04 | Entity: `ProductChangelogRead` | P1 |
| T-05 | Entity registration (4 files) | P1 |
| T-06 | Repository + inventory + barrel | P1 |
| T-07 | Migration `1791140000000-CreateProductChangelogReads.ts` | P1 |
| T-08 | The catalogue | P1 |
| T-09 | Changelog service | P1 |
| T-10 | `MarkChangelogReadDto` | P1 |
| T-11 | Controller | P1 |
| T-12 | Module registration | P1 |
| T-13 | Service spec | P1 |
| T-14 | Controller spec | P1 |
| T-15 | Web API client | P1 |
| T-16 | Server actions | P1 |
| T-17 | Top-bar control | P1 |
| T-18 | Panel shell | P1 |
| T-19 | Entry card | P1 |
| T-20 | Shared list body | P1 |
| T-21 | Read tracker hook | P1 |
| T-22 | Shell wiring | P1 |
| T-23 | i18n — English | P1 |
| T-24 | i18n — 20 locales | P1 |
| T-25 | Unit spec — control | P1 |
| T-26 | Unit spec — panel | P1 |
| T-27 | Unit spec — read tracker | P1 |
| T-28 | E2E — golden path | P1 |
| T-29 | E2E — degradation | P1 |
| T-30 | Phase 1 gate | P1 |
| T-31 | Safe in-app path helper | P2 |
| T-32 | Catalogue spec — CI authoring gate | P2 |
| T-33 | Pinning | P2 |
| T-34 | Filter chips | P2 |
| T-35 | Call-to-action rendering | P2 |
| T-36 | Route constant + page metadata | P2 |
| T-37 | Full page | P2 |
| T-38 | Discovery links | P2 |
| T-39 | E2E — the page | P2 |
| T-40 | Accessibility sweep | P2 |
| T-41 | Phase 2 gate | P2 |
| T-42 | Telemetry | P3 |
| T-43 | Focus-refresh of the count | P3 |
| T-44 | Authoring guide + PR-template line | P3 |
| T-45 | Orphan-read prune (conditional) | P3 |
| T-46 | Phase 3 gate and close-out | P3 |
</content>
