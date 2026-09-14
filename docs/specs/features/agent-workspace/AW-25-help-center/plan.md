# AW-25 — Help centre in product · Implementation Plan

**Epic:** `AW-25-help-center` · **Program:** [Agent Workspace](../README.md)
**Spec:** [spec.md](./spec.md) · **Tasks:** [tasks.md](./tasks.md)
**Status:** Draft v1 · **Date:** 2026-09-06
**Constitution:** [`.specify/memory/constitution.md`](../../../../../.specify/memory/constitution.md)

Every path below was opened before it was cited.

---

## 1. Current state in the codebase

### 1.1 The one help surface that exists

| File                                                                                                                                  | What it is today                                                                                                                                                                                                                                                                                                                                                      | What this epic does to it                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`apps/web/src/components/dashboard/HelpDrawer.tsx`](../../../../../apps/web/src/components/dashboard/HelpDrawer.tsx)                 | 601 lines. A Headless UI `Dialog` + `Transition` slide-over with four tabs (`tips`, `shortcuts`, `faq`, `resources`), module-level constants `DOCS_URL`, `GITHUB_URL`, `ISSUES_URL`, `DISCUSSIONS_URL`, plus `APP_ENV` / `STATUS_URL` env chips, and local `CARD` / `DIVIDE` / `ROW` style tokens. Translations come from `useTranslations('dashboard.header.help')`. | Gains a **new first tab** whose panel is `<HelpCenterPanel/>`. The four existing tabs, their copy, their constants and their external links are untouched (spec FR-13).    |
| [`apps/web/src/components/dashboard/DashboardHeader.tsx`](../../../../../apps/web/src/components/dashboard/DashboardHeader.tsx)       | 124 lines. Mobile hamburger, `WorkSwitcher`, optional onboarding pill, then `NotificationDropdown` / `ThemeToggle` / a Help button that calls the layout's `onOpenHelp`.                                                                                                                                                                                              | Unchanged wiring; the Help button's tooltip string changes to `Help — press ?`.                                                                                            |
| [`apps/web/src/lib/hooks/use-keyboard-shortcuts.ts`](../../../../../apps/web/src/lib/hooks/use-keyboard-shortcuts.ts)                 | Three global bindings on one `document.keydown` listener: `Ctrl/Cmd+K` → `router.push('/works?focus=search')`, `C` → `ROUTES.DASHBOARD_WORKS_NEW`, `?` → `onOpenHelp()` (guarded against `input` / `textarea` / `select` / `contentEditable`).                                                                                                                        | **Not modified by this epic.** [AW-01](../AW-01-command-palette/plan.md) already repoints `Ctrl/Cmd+K`; `?` keeps calling `onOpenHelp`, which now lands on the manual tab. |
| [`apps/web/src/app/[locale]/(dashboard)/layout-client.tsx`](<../../../../../apps/web/src/app/[locale]/(dashboard)/layout-client.tsx>) | 540-line client shell. Mounts `DashboardSidebar`, `ChatPanel`, `DashboardHeader`, `<main id="main-content">`, `Footer`, `HelpDrawer`, and calls `useKeyboardShortcuts({ onOpenHelp })`. Already owns the drawer's open/close state.                                                                                                                                   | Wraps its body in `<HelpCenterProvider>` so any component can call `openHelpAt(target)`, and passes the provider's requested target into `HelpDrawer`.                     |
| [`apps/web/src/components/dashboard/DashboardSidebar.tsx`](../../../../../apps/web/src/components/dashboard/DashboardSidebar.tsx)     | 628 lines. The user menu at the bottom carries `profileMenu.helpDocs` (external docs link), `profileMenu.support`, `profileMenu.keyboardShortcuts` (opens the drawer).                                                                                                                                                                                                | `helpDocs` opens the manual; a new adjacent row keeps the external documentation link (spec FR-10.4). No entry is removed.                                                 |

### 1.2 What the manual has to bind to

| File                                                                                                                                                                                                                      | Why it matters here                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`apps/api/src/health/build-info.ts`](../../../../../apps/api/src/health/build-info.ts)                                                                                                                                   | `getBuildInfo()` returns `{ name, version, gitSha, shortSha, gitRef, buildRun, buildTime, commitUrl }`, every field degrading to a safe default. This is the build stamp in spec FR-8 — already built, already published, already safe.                      |
| [`apps/web/src/lib/api/version.ts`](../../../../../apps/web/src/lib/api/version.ts)                                                                                                                                       | `versionAPI` — the client the dashboard footer already uses. The server layout fetches it once, cached 5 minutes. The manual reads the same value the footer shows, so the two can never disagree.                                                           |
| [`apps/web/src/components/footer/index.tsx`](../../../../../apps/web/src/components/footer/index.tsx)                                                                                                                     | Where that version chip renders today; the visual precedent for the manual's stamp.                                                                                                                                                                          |
| [`apps/web/src/lib/constants.ts`](../../../../../apps/web/src/lib/constants.ts)                                                                                                                                           | `ROUTES` (from line 107) is the single source of truth for every path. It also carries the documented dead constant `DASHBOARD_NOTIFICATIONS` (`/notifications` soft-404s). Both facts are load-bearing for spec FR-5.2.                                     |
| [`apps/web/src/components/common/EmptyState.tsx`](../../../../../apps/web/src/components/common/EmptyState.tsx)                                                                                                           | The genuinely shared empty-state primitive (title / description / action / icon). Adding one optional prop here wires most of spec FR-23 in a single edit.                                                                                                   |
| [`apps/web/src/components/dashboard/JobRuntimeDegradedBanner.tsx`](../../../../../apps/web/src/components/dashboard/JobRuntimeDegradedBanner.tsx)                                                                         | 79 lines, amber, dismissible, `localStorage`-persisted. The canonical "error message that explains nothing" from spec §2.2.                                                                                                                                  |
| [`apps/web/src/components/dashboard/AttentionSection.tsx`](../../../../../apps/web/src/components/dashboard/AttentionSection.tsx)                                                                                         | Renders the home attention items; the kinds actually emitted today are `agent-error`, `generation-failed`, `task-blocked`, `budget-exceeded`.                                                                                                                |
| [`apps/web/src/components/posthog/PostHogProvider.tsx`](../../../../../apps/web/src/components/posthog/PostHogProvider.tsx) + [`PostHogIdentify.tsx`](../../../../../apps/web/src/components/posthog/PostHogIdentify.tsx) | Already mounted in the shell; the only analytics path this epic uses.                                                                                                                                                                                        |
| [`apps/web/src/lib/api/bff-proxy.ts`](../../../../../apps/web/src/lib/api/bff-proxy.ts)                                                                                                                                   | `bffProxy(handler, { scope })` — resolves the auth cookie and forwards the workspace selector. Mandatory for the one browser-facing route this epic adds.                                                                                                    |
| [`apps/web/scripts/sync-locale-parity.mjs`](../../../../../apps/web/scripts/sync-locale-parity.mjs)                                                                                                                       | The existing tool for seeding a new namespace into all 20 non-English locale files. Its own comment records why full paths must be seeded: a missing **parent** object collapses the whole subtree into a runtime error rather than falling back to English. |

### 1.3 The plumbing this epic copies rather than invents

- **Entity + registration + migration**, exactly the shape [AW-14](../AW-14-whats-new/plan.md#32-new-entity) uses:
  [`packages/agent/src/entities/index.ts`](../../../../../packages/agent/src/entities/index.ts),
  [`packages/agent/src/database/_entity-names.ts`](../../../../../packages/agent/src/database/_entity-names.ts),
  [`packages/agent/src/database/_entities-inventory.ts`](../../../../../packages/agent/src/database/_entities-inventory.ts),
  [`packages/agent/src/database/_repository-inventory.ts`](../../../../../packages/agent/src/database/_repository-inventory.ts).
  Each has a drift spec that fails CI if one of the four is missed.
- **A throttled, session-guarded controller**:
  [`apps/api/src/agent-approvals/agent-approvals.controller.ts`](../../../../../apps/api/src/agent-approvals/agent-approvals.controller.ts)
  is the reference — `@ApiTags`, `@Controller('api/…')`, `@CurrentUser()`, `@Throttle` on writes,
  auth from the global `AuthSessionGuard`, and a header comment that lists the routes.
- **A weekly scheduled job**:
  [`packages/tasks/src/tasks/trigger/anonymous-user-cleanup.task.ts`](../../../../../packages/tasks/src/tasks/trigger/anonymous-user-cleanup.task.ts)
  is the reference shape — `schedules.task()` from the runtime provider, a Nest context built from
  `TriggerInternalModule`, a service that lives in `packages/agent`, an explicitly staggered cron
  minute, and graceful degradation when a dependency is unavailable.
- **A build-time script that writes into the repo**: the three existing
  [`apps/web/scripts/*.mjs`](../../../../../apps/web/scripts) files establish the convention —
  plain ESM, no build step, committed outputs, documented in their own header.

### 1.4 What does not exist today

- No article content of any kind, anywhere in the repository, aimed at product users.
- No content pipeline: nothing turns Markdown into anything the web app renders.
- No `/help` route. `apps/web/src/app/[locale]/(dashboard)/` has no `help` segment.
- No link type that points at documentation; every help destination in the product is a hardcoded
  external URL inside `HelpDrawer.tsx`.
- No `apps/api/src/help/` module, no help-related entity, no help-related message namespace.

---

## 2. Architecture and the seam it plugs into

```
   AUTHORING (a human, in the same PR as the feature)
   apps/web/src/content/help/<section>/<article>.md          Markdown + frontmatter
            │
            │  pnpm --filter ever-works-web help:build     (and --check in prebuild)
            ▼
   GENERATED, COMMITTED, TYPE-CHECKED
   ┌──────────────────────────────────────────────────────────────────────┐
   │ help-catalog.generated.ts     metadata only, eager  (~15 KB)         │
   │   · HELP_ARTICLES[]  · HELP_SECTIONS  · type HelpTarget = union      │
   │ help-content.generated.json   bodies + search postings, LAZY (≤250KB)│
   └──────────────────────────────────────────────────────────────────────┘
            │                                    │
            │ eager import                       │ dynamic import() on first open
            ▼                                    ▼
   ┌───────────────────────┐          ┌────────────────────────┐
   │ HelpLink (FR-20..25)  │          │ use-help-search        │
   │  target: HelpTarget   │          │  ranking · FR-18       │
   │  ← tsc proves it      │          │  degrades to metadata  │
   │    resolves           │          └────────────────────────┘
   └───────────┬───────────┘                     │
               │ openHelpAt(target)              │
               ▼                                 ▼
   ┌──────────────────────────────────────────────────────────────────────┐
   │ HelpCenterProvider  (mounted in layout-client.tsx)                   │
   │   open · close · openHelpAt(target) · currentTarget                  │
   └──────────────┬──────────────────────────────────┬────────────────────┘
                  │                                  │
                  ▼                                  ▼
   ┌──────────────────────────┐        ┌──────────────────────────────────┐
   │ HelpDrawer               │        │ /help  ·  /help/[slug]           │
   │  ┌ Manual  ← NEW TAB ─┐  │        │  same catalogue, full page,      │
   │  │ HelpCenterPanel    │  │        │  printable, shareable            │
   │  └────────────────────┘  │        └──────────────────────────────────┘
   │   Tips · Shortcuts ·     │
   │   FAQ · Resources        │        ┌──────────────────────────────────┐
   │   (untouched)            │        │ Command palette (AW-01)          │
   └──────────────────────────┘        │  registers a Help result source, │
                                       │  client-side, offline-capable    │
                                       └──────────────────────────────────┘

   THE ONLY SERVER HOP
   POST /api/help/feedback  ──bffProxy──▶  apps/api/src/help  ──▶ help_article_feedback
                                                    │
                                       weekly schedules.task() ──▶ content-health summary
```

**The seam.** Everything a reader consumes is a build artefact. The only runtime dependencies are
(a) the existing version endpoint for the stamp and (b) one write endpoint for feedback. That is
what makes spec FR-1 and FR-5 true by construction rather than by discipline: there is no place
for the manual and the running build to disagree, because they are the same artefact.

**Why the help target is a TypeScript union.** Spec FR-5.3 requires the release to fail when a
help link does not resolve. Generating

```ts
export type HelpTarget = 'missions' | 'missions#writing-a-brief' | 'tasks' | …;
```

turns that requirement into a `tsc` error at the call site, in the editor, before CI. `pnpm
type-check` already runs on every PR, so the gate costs nothing new. The runtime guard in
`HelpLink` (spec FR-22) exists only for the case a generated file is stale in a working tree.

---

## 3. Data model

### 3.1 The decision: content in the build, feedback in the database

|                                                   | **A — articles in a table + an admin editor**          | **B — articles in the build, only feedback in a table** ✅ |
| ------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------- |
| Tables added                                      | 3+ (articles, sections, feedback)                      | **1** (`help_article_feedback`)                            |
| Publishing an article                             | write a row, remember to deploy nothing                | a PR alongside the feature                                 |
| Can the manual describe a screen the build lacks? | Yes — a row outlives the rollback and lies             | **No, structurally** (spec FR-1, FR-5.2, FR-6)             |
| Air-gapped / self-hosted                          | Needs seeding, then drifts per install                 | Correct on every install, always                           |
| Search                                            | server round trip, index maintenance, a new read model | zero I/O, offline, ~26 documents                           |
| Review                                            | invisible to code review                               | the same reviewer as the feature                           |
| Localisation                                      | a translation table and a fallback policy per row      | a build artefact the existing pipeline can see             |

**B is chosen.** The requirement is "never disagrees with the running build"; B satisfies it by
construction. The corpus is capped at 200 articles (spec FR-3) and identical for every reader, so
it has none of the properties that would justify a table.

### 3.2 New entity — the only one

`packages/agent/src/entities/help-article-feedback.entity.ts`

```ts
import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

/**
 * AW-25 — one row per (person, help article): "was this article helpful?".
 *
 * `articleId` is a SOFT reference into the generated help catalogue
 * (apps/web/src/lib/help/help-catalog.generated.ts). The catalogue ships with
 * the web build, so there is deliberately no FK and deliberately no table of
 * articles. Rows whose article is absent from the running build are ignored
 * by the content-health summary and pruned with everything else at 400 days
 * (spec FR-36).
 *
 * NOT workspace-scoped: a manual is identical for every reader, so feedback
 * follows the person, never the active Organization. No tenantId /
 * organizationId columns — this is the rare table where their absence is the
 * requirement, not an oversight.
 *
 * `note` is free text a person typed. It is rejected before it reaches this
 * table when it matches a credential shape (spec FR-35, Constitution VII) and
 * is never returned to any non-platform-admin caller (spec FR-36).
 */
@Entity({ name: 'help_article_feedback' })
@Unique('uq_help_article_feedback_user_article', ['userId', 'articleId'])
@Index('idx_help_article_feedback_article', ['articleId'])
@Index('idx_help_article_feedback_created', ['createdAt'])
export class HelpArticleFeedback {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'uuid' })
	userId: string;

	/**
	 * Article identifier, or NULL for a "tell us what you were looking for"
	 * note submitted from the no-results state (spec S-13).
	 * Matches [a-z0-9-]{3,64} when present.
	 */
	@Column({ type: 'varchar', length: 64, nullable: true })
	articleId: string | null;

	/** NULL only for the S-13 no-results note, which carries no verdict. */
	@Column({ type: 'boolean', nullable: true })
	helpful: boolean | null;

	/** ≤ 500 chars for an article note, ≤ 200 for an S-13 note. */
	@Column({ type: 'varchar', length: 500, nullable: true })
	note: string | null;

	/** Build the feedback was given against — `shortSha` from build identity. */
	@Column({ type: 'varchar', length: 40, nullable: true })
	buildRef: string | null;

	/** Interface locale at the time, so we can see which locales struggle. */
	@Column({ type: 'varchar', length: 8, nullable: true })
	locale: string | null;

	@CreateDateColumn({ type: 'timestamptz' })
	createdAt: Date;

	@UpdateDateColumn({ type: 'timestamptz' })
	updatedAt: Date;
}
```

The FK on `userId` → `users(id)` `ON DELETE CASCADE` is declared at the database level in the
migration only — no entity-level `@ManyToOne`, matching the cycle-avoidance convention already
used by the other person-scoped tables.

**No new database enum.** `helpful` is a nullable boolean; sections and block kinds never reach the
database.

### 3.3 New shared types (contracts, not database)

`packages/contracts/src/api/help/help.enum.ts`

```ts
/** Spec FR-4 — closed set of 6, in reading order. */
export const HELP_SECTIONS = [
	'start-here',
	'running-the-loop',
	'your-agents',
	'setup-and-connections',
	'money-and-limits',
	'when-something-goes-wrong'
] as const;
export type HelpSection = (typeof HELP_SECTIONS)[number];

/** Spec FR-27 — the closed block grammar an article body may use. */
export const HELP_BLOCK_KINDS = [
	'paragraph',
	'heading',
	'orderedList',
	'unorderedList',
	'note',
	'shortcut',
	'code',
	'link'
] as const;
export type HelpBlockKind = (typeof HELP_BLOCK_KINDS)[number];

/** Spec FR-27a — what a `link` block may point at. Closed. */
export const HELP_LINK_TARGET_TYPES = ['article', 'screen', 'external'] as const;
export type HelpLinkTargetType = (typeof HELP_LINK_TARGET_TYPES)[number];

export type HelpLinkTarget =
	/** Another article, optionally at a heading. Resolved like a help link (spec FR-22). */
	| { type: 'article'; articleId: string; headingId: string | null }
	/** A KEY of `ROUTES` — never a literal path, the same rule as `documents` (spec FR-5.2). */
	| { type: 'screen'; routeKey: string }
	/** Absolute `https:` URL, no userinfo, <= 2048 chars (spec FR-27a). */
	| { type: 'external'; href: string };

export interface HelpLinkBlock {
	kind: 'link';
	/** Plain text, 1-80 chars, no inline markup. */
	label: string;
	target: HelpLinkTarget;
}
```

`packages/contracts/src/api/help/help.dto.ts`

```ts
export interface SubmitHelpFeedbackDto {
	/** null for the no-results note (spec S-13). */
	articleId: string | null;
	/** null for the no-results note. */
	helpful: boolean | null;
	note?: string;
	buildRef?: string;
	locale?: string;
}

export interface HelpFeedbackAckDto {
	accepted: true;
}

/** Platform-admin only (spec FR-47). */
export interface HelpArticleHealthDto {
	articleId: string;
	responses: number;
	negative: number;
	negativeShare: number; // 0..1
	flagged: boolean; // spec FR-48
	lastResponseAt: string | null;
}
```

Both files are re-exported from `packages/contracts/src/api/help/index.ts` and from
[`packages/contracts/src/api/index.ts`](../../../../../packages/contracts/src/api/index.ts),
which already re-exports several such folders. Additive only (Constitution X).

### 3.4 Migration — ships in the SAME PR as the entity (Constitution V)

`apps/api/src/migrations/1791250000000-CreateHelpArticleFeedback.ts`

`1791250000000` is AW-25 slot 00 of the program's reserved migration blocks ([README §5 rule 10](../README.md#5-rules-every-epic-spec-in-this-program-must-follow)).
It sits above the newest migration on `develop` at time of writing (`1790100000000-AddReleaseVerification.ts`) and
cannot collide with another epic's plan. Before merge, rebase on `develop`; if a newer migration
has landed, re-stamp the filename and class name to exceed it.

```ts
import { MigrationInterface, QueryRunner, Table, TableForeignKey } from 'typeorm';

/**
 * AW-25 — Help centre in product.
 *
 * Creates ONE table: per-person feedback on a help article. The articles
 * themselves are NOT stored — they ship with the web build. See
 * docs/specs/features/agent-workspace/AW-25-help-center/plan.md §3.1.
 *
 * Forward-only. `ifNotExists` on create; `down()` drops only the table this
 * migration created and touches no pre-existing object.
 */
export class CreateHelpArticleFeedback1791250000000 implements MigrationInterface {
	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.createTable(
			new Table({
				name: 'help_article_feedback',
				columns: [
					{
						name: 'id',
						type: 'uuid',
						isPrimary: true,
						generationStrategy: 'uuid',
						default: 'uuid_generate_v4()'
					},
					{ name: 'userId', type: 'uuid', isNullable: false },
					{ name: 'articleId', type: 'varchar', length: '64', isNullable: true },
					{ name: 'helpful', type: 'boolean', isNullable: true },
					{ name: 'note', type: 'varchar', length: '500', isNullable: true },
					{ name: 'buildRef', type: 'varchar', length: '40', isNullable: true },
					{ name: 'locale', type: 'varchar', length: '8', isNullable: true },
					{ name: 'createdAt', type: 'timestamptz', default: 'now()', isNullable: false },
					{ name: 'updatedAt', type: 'timestamptz', default: 'now()', isNullable: false }
				],
				uniques: [
					{
						name: 'uq_help_article_feedback_user_article',
						columnNames: ['userId', 'articleId']
					}
				],
				indices: [
					{ name: 'idx_help_article_feedback_article', columnNames: ['articleId'] },
					{ name: 'idx_help_article_feedback_created', columnNames: ['createdAt'] }
				]
			}),
			true
		);

		await queryRunner.createForeignKey(
			'help_article_feedback',
			new TableForeignKey({
				name: 'fk_help_article_feedback_user',
				columnNames: ['userId'],
				referencedTableName: 'users',
				referencedColumnNames: ['id'],
				onDelete: 'CASCADE'
			})
		);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.dropTable('help_article_feedback', true);
	}
}
```

**Note on the unique constraint and `articleId = NULL`.** PostgreSQL treats NULLs as distinct in a
unique index, so the S-13 no-results notes (which carry `articleId = NULL`) are _not_ collapsed to
one row per person — which is the behaviour we want: a person may report several missing topics,
but may hold only one verdict per article (spec FR-32). This is stated in the entity doc comment
so a later "fix" does not add a partial index that breaks it.

**No backfill.** Nothing pre-exists.

### 3.5 The content pipeline

**Authored source** — `apps/web/src/content/help/<section>/<article>.md`:

```markdown
---
id: missions
section: running-the-loop
title: 'Missions: hand out work and watch it land'
summary: One piece of delegated work, from brief to done.
keywords: [mission, delegate, brief, outcome, assign]
documents: [DASHBOARD_MISSIONS, DASHBOARD_MISSIONS_NEW]
related: [tasks, my-decisions]
reviewedAt: 2026-08-12
order: 10
---

A mission is one piece of delegated work. …

## What a mission is

…
```

`documents` holds **keys of `ROUTES`**, never literal paths — so a renamed path cannot silently
orphan an article, and spec FR-5.2 becomes a lookup rather than a string comparison.

**Generator** — `apps/web/scripts/build-help-catalog.mjs` (plain ESM, no build step, matching the
three scripts already in that folder):

1. Read every `.md` under `apps/web/src/content/help/`.
2. Parse frontmatter; validate every limit in spec FR-3; fail with the article path and the rule.
3. Parse the body into the closed block grammar (spec FR-27). Anything outside the grammar —
   raw HTML, images, tables, block quotes — is a hard error naming the line. Nothing becomes raw
   markup (spec FR-28).
   **Link blocks** (spec FR-27a). A line whose entire content is one Markdown link becomes
   `{ kind: 'link', label, target }`; the target's scheme picks the type:

    | Authored                                         | Parsed target                                                              | Generator validation (hard error naming the line)                                                                                             |
    | ------------------------------------------------ | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
    | `[Write a brief](help:missions#writing-a-brief)` | `{ type: 'article', articleId: 'missions', headingId: 'writing-a-brief' }` | the article id exists in the corpus; the heading id, when given, exists in that article (checked after step 4 for every article)              |
    | `[Open Missions](route:DASHBOARD_MISSIONS)`      | `{ type: 'screen', routeKey: 'DASHBOARD_MISSIONS' }`                       | the key matches `^[A-Z][A-Z0-9_]*$`; existence in `ROUTES` is checked by the unit spec below, because the generator does not parse TypeScript |
    | `[Status page](https://status.example.org)`      | `{ type: 'external', href }`                                               | `new URL(href)` succeeds; `protocol === 'https:'`; no `username` / `password`; length <= 2048                                                 |

    Everything else is a hard error: a link inside paragraph or list text (inline links are not in
    the grammar); an empty or > 80-character label, or a label containing markup; a relative or
    literal in-product path such as `/missions` (the message points the author at `route:`); any
    other scheme — `http:`, `javascript:`, `data:`, `mailto:`, protocol-relative `//host`. The
    `help:` targets are also collected into the `HelpTarget` union check, so an article link that
    rots fails `tsc` exactly like a help link does (spec FR-5.3, FR-5.7).

4. Slugify every `##` heading into an anchor id; duplicates inside one article are a hard error.
5. Emit: - `apps/web/src/lib/help/help-catalog.generated.ts` — `HELP_ARTICLES` (metadata only:
   `id`, `section`, `title`, `summary`, `keywords`, `documents`, `related`, `reviewedAt`,
   `order`, `headings: {id,text}[]`), `HELP_SECTION_ORDER`, and
   `export type HelpTarget = …` (the union of every `id` and every `` `${id}#${headingId}` ``). - `apps/web/src/lib/help/help-content.generated.json` — `{ bodies: Record<id, Block[]>,
postings: Record<token, Array<[articleIndex, field, headingIndex]>> }`.
6. `--check` mode regenerates into memory and exits non-zero with a diff summary when the
   committed outputs differ. Wired as `apps/web`'s `prebuild`, so `pnpm build` cannot ship a
   stale catalogue.

**Why the split.** The metadata file is eager (spec FR-12: the panel must be useful in 150 ms, and
spec S-20: search must degrade to titles and summaries when the big file fails). The content file
is a dynamic `import()` so bundlers emit it as its own chunk, loaded on first open and cached for
the life of the page (spec FR-17).

**Route validation is a unit spec, not a regex.** The generator does not parse TypeScript. The
`documents` keys are validated by `apps/web/src/lib/help/help-catalog.unit.spec.ts`, which
imports both the generated catalogue and `ROUTES` from
[`apps/web/src/lib/constants.ts`](../../../../../apps/web/src/lib/constants.ts) and asserts that
every key exists and that none is `DASHBOARD_NOTIFICATIONS` (the documented dead route). The same
spec walks every `link` block in `help-content.generated.json`: each `screen` `routeKey` exists in
`ROUTES`, is not `DASHBOARD_NOTIFICATIONS`, and has no dynamic `:param` segment (a help article
cannot know which record to open); each `external` `href` is re-parsed and must still be
`https:` with no userinfo. Both
`pnpm type-check` and `pnpm test` already gate every PR, so this is a real build gate.

---

## 4. API surface

One new module, `apps/api/src/help/`, base path `api/help`. Authentication comes from the global
`AuthSessionGuard`; `@CurrentUser()` threads the user id; `@ApiTags('help')` +
`@ApiBearerAuth('JWT-auth')` so the OpenAPI document picks it up. Every response carries
`Cache-Control: private, no-store`.

| Method | Path                       | Body / query            | Response                       | Auth & limits                                                                                                                                                                                                                          |
| ------ | -------------------------- | ----------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/api/help/feedback`       | `SubmitHelpFeedbackDto` | `201` `HelpFeedbackAckDto`     | Session. `@Throttle` 20 per 3 600 s per user (spec FR-34). `422` when the note matches a credential shape (spec FR-35). `400` on an `articleId` that fails `[a-z0-9-]{3,64}`, a note over its cap, or `helpful === null` with no note. |
| `GET`  | `/api/help/health-summary` | `?since=<ISO date>`     | `200` `HelpArticleHealthDto[]` | Session **plus** the existing platform-admin check used by the other operator endpoints. `403` otherwise. Default throttle.                                                                                                            |

Notes:

- **Upsert semantics** (spec FR-32) are a single `INSERT … ON CONFLICT (userId, articleId) DO
UPDATE` on the unique constraint, so two rapid submissions from two tabs cannot produce two rows.
- **The `GET` never returns notes to anyone but a platform administrator**, and never returns a
  `userId` at all — the summary is counts per article (spec FR-36).
- **No read endpoint for articles.** The manual is not served by the API in this epic (spec §7.7).
  If Q-4 is answered "yes" later, it becomes a second, separate module fed by the same generator.

**Browser-facing route** — `apps/web/src/app/api/help/feedback/route.ts`, a `POST` handler wrapped
in `bffProxy(handler)` from
[`apps/web/src/lib/api/bff-proxy.ts`](../../../../../apps/web/src/lib/api/bff-proxy.ts). It
validates the shape client-side-cheap (article id pattern, note length), forwards with
`cache: 'no-store'`, and maps upstream `422` / `429` onto the two copy strings in spec §6.10
without leaking the upstream body.

---

## 5. Web

### 5.1 New files

```
apps/web/src/content/help/
  start-here/*.md                       authored articles
  running-the-loop/*.md
  your-agents/*.md
  setup-and-connections/*.md
  money-and-limits/*.md
  when-something-goes-wrong/*.md
  README.md                             authoring rules, the six sections, the block grammar

apps/web/scripts/
  build-help-catalog.mjs                generator + --check drift mode
  export-help-docs.mjs                  P3: mirror the manual into docs/help/

apps/web/src/lib/help/
  help-catalog.generated.ts             GENERATED — metadata + HelpTarget union (eager)
  help-content.generated.json           GENERATED — bodies + postings (lazy chunk)
  help-target.ts                        parse/format `<article>#<heading>`, runtime resolve
  help-search.ts                        pure ranking (spec FR-18), no React, no I/O
  help-recents.ts                       localStorage list, every access in try/catch
  help-screen-map.ts                    current pathname → article ids that document it

apps/web/src/components/help/
  HelpCenterProvider.tsx                open / close / openHelpAt(target) / currentTarget
  HelpCenterPanel.tsx                   the new first drawer tab: browse | results | article
  HelpBrowse.tsx                        On this screen · Recently opened · Browse
  HelpSearchInput.tsx
  HelpSearchResults.tsx                 grouped, keyboard-navigable listbox
  HelpNoResults.tsx                     three actions + the S-13 report control
  HelpArticleReader.tsx                 section · title · reviewed · On this page · body
  HelpArticleBlocks.tsx                 renderer for the closed block grammar
  HelpOnThisPage.tsx                    collapses to one control below 768 px
  HelpRelated.tsx
  HelpFeedback.tsx                      every state in spec §6.10
  HelpBuildStamp.tsx                    reads the value the footer already shows
  HelpLink.tsx                          the two-phrase secondary link (spec FR-24, FR-22)
  HelpArticleNotInBuild.tsx             spec §6.8
  hooks/
    use-help-content.ts                 dynamic import + degraded fallback (spec S-20)
    use-help-search.ts                  120 ms debounce, 2-char floor, ranking, caps
    use-help-recents.ts
    use-help-feedback.ts

apps/web/src/app/[locale]/(dashboard)/help/
  page.tsx                              the full index (spec §6.7)
  [slug]/page.tsx                       one article, printable, anchor-aware (spec §6.8, FR-45)

apps/web/src/app/api/help/feedback/route.ts        POST, bffProxy
```

### 5.2 Modified files — all additive

| File                                                                                                                                              | Change                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`apps/web/src/app/[locale]/(dashboard)/layout-client.tsx`](<../../../../../apps/web/src/app/[locale]/(dashboard)/layout-client.tsx>)             | Wrap the shell body in `<HelpCenterProvider>`; pass its `currentTarget` into `HelpDrawer`. No change to `useKeyboardShortcuts`, the chat panel, or the existing drawer state.                                                                   |
| [`apps/web/src/components/dashboard/HelpDrawer.tsx`](../../../../../apps/web/src/components/dashboard/HelpDrawer.tsx)                             | Add `manual` as the first tab id and render `<HelpCenterPanel/>` for it; accept an optional `initialTarget` prop that selects that tab and opens the article. The four existing tabs are moved by exactly one position and otherwise untouched. |
| [`apps/web/src/components/dashboard/DashboardHeader.tsx`](../../../../../apps/web/src/components/dashboard/DashboardHeader.tsx)                   | Tooltip key only.                                                                                                                                                                                                                               |
| [`apps/web/src/components/dashboard/DashboardSidebar.tsx`](../../../../../apps/web/src/components/dashboard/DashboardSidebar.tsx)                 | `profileMenu.helpDocs` opens the manual; a new adjacent row keeps the external documentation link. Nothing removed.                                                                                                                             |
| [`apps/web/src/components/common/EmptyState.tsx`](../../../../../apps/web/src/components/common/EmptyState.tsx)                                   | One optional `helpTarget?: HelpTarget` prop; when present, renders `<HelpLink/>` after the existing action. Existing call sites are unaffected.                                                                                                 |
| [`apps/web/src/components/dashboard/JobRuntimeDegradedBanner.tsx`](../../../../../apps/web/src/components/dashboard/JobRuntimeDegradedBanner.tsx) | One `<HelpLink variant="error"/>` in the existing action row.                                                                                                                                                                                   |
| [`apps/web/src/components/dashboard/AttentionSection.tsx`](../../../../../apps/web/src/components/dashboard/AttentionSection.tsx)                 | One `<HelpLink variant="error"/>` per attention kind, from a map of the four kinds actually emitted today.                                                                                                                                      |
| [`apps/web/src/lib/constants.ts`](../../../../../apps/web/src/lib/constants.ts)                                                                   | Two additions: `DASHBOARD_HELP = '/help'` and `DASHBOARD_HELP_ARTICLE = (slug: string) => '/help/' + slug`.                                                                                                                                     |
| [`apps/web/messages/en.json`](../../../../../apps/web/messages/en.json) + the 20 sibling locale files                                             | The new `dashboard.helpCenter` namespace and `metadata.pages.help` (§8).                                                                                                                                                                        |
| The list screens' empty states (Missions, Tasks, Agents, Works, Ideas, Skills, Teams, Memory, Knowledge Base, Plugins, Schedules)                 | One `helpTarget` prop each.                                                                                                                                                                                                                     |
| The command-palette registry from [AW-01](../AW-01-command-palette/plan.md#53-components)                                                         | One new client-side source registering the **Help** group.                                                                                                                                                                                      |

### 5.3 State and data fetching

- **Server components:** the two `/help` pages are server components that read the build identity
  from the same cached `versionAPI` call the layout already makes, then render a client child. The
  catalogue is a static import, so the index page needs no data fetching at all.
- **Client state:** `HelpCenterProvider` owns `{ open, target, view }` where `view` is
  `browse | results | article`. Nothing else is global.
- **Search:** `use-help-search` debounces 120 ms, floors at 2 characters, and calls the pure
  ranking function in `help-search.ts`. There is no request to abort, no timeout, and no
  out-of-order response — the whole class of bugs AW-01 has to handle does not exist here.
- **Content loading:** `use-help-content` performs the dynamic `import()` once per page, keeps the
  resolved module in a module-level promise so a second open does not re-import, and on rejection
  sets `degraded: true` (spec S-20) rather than throwing into render.
- **Recents:** `help-recents.ts` reads and writes `localStorage['help-recents']` with **every**
  access wrapped in `try/catch`, following the precedent set by
  [`use-theme.ts`](../../../../../apps/web/src/lib/hooks/use-theme.ts) and
  `JobRuntimeDegradedBanner.tsx`, both of which document real browsers that throw on storage
  access. A throwing storage API must degrade to "no recents", never to an error boundary.
- **Feedback:** `use-help-feedback` posts once, is disabled while in flight, and renders the six
  states in spec §6.10 from the response status alone. It never retries and never queues.

### 5.4 The full page and printing

`/help/[slug]` renders the same `HelpArticleReader` in a wider column. Print styles live beside it
and hide the sidebar, the top bar, the drawer, the feedback control and the "On this page" list,
keeping the title, body, headings and build stamp (spec FR-45). No print-specific route.

---

## 6. Background work

One scheduled job (spec FR-47, FR-49). It follows Constitution IV exactly.

**Shape** — copied from
[`packages/tasks/src/tasks/trigger/anonymous-user-cleanup.task.ts`](../../../../../packages/tasks/src/tasks/trigger/anonymous-user-cleanup.task.ts):

```
packages/agent/src/help/help-content-health.service.ts     the logic, testable, no SDK import
packages/tasks/src/tasks/trigger/help-content-health.task.ts   schedules.task(), cron only
packages/tasks/src/tasks/trigger/index.ts                  one registration line
```

- **Cadence:** weekly, Mondays at `07:41 UTC` — deliberately staggered off the round hours the
  other scheduled jobs use, matching the existing convention of avoiding a coincident burst.
- **What it does, in one transaction-free pass:**
    1. Aggregate `help_article_feedback` for the last 7 days into per-article counts.
    2. Flag every article with ≥ 10 responses and ≥ 40% negative (spec FR-48).
    3. Read the article ids and `reviewedAt` dates from the catalogue **as shipped in this build**
       and flag anything older than 180 days (spec FR-7). When the catalogue is not resolvable from
       the worker (a self-hosted split deployment), that half of the summary is omitted with a
       stated reason rather than failing the job.
    4. Delete rows older than 400 days (spec FR-36).
    5. Write one activity-log entry summarising the pass.
- **Constitution IV compliance:** the cron is registered through the configured job-runtime
  provider's native cron mechanism. There is **no** `@Cron` decorator on the API process and **no**
  `import '@trigger.dev/sdk'` outside `packages/tasks`. This job is a pure schedule, so it needs no
  `*_DISPATCHER` symbol; if a future variant fans out per organisation it must declare
  `HELP_CONTENT_HEALTH_DISPATCHER` in
  [`packages/agent/src/tasks/`](../../../../../packages/agent/src/tasks) and register it in
  [`_tasks-symbols.ts`](../../../../../packages/agent/src/tasks/_tasks-symbols.ts) and
  [`job-runtime.providers.ts`](../../../../../packages/agent/src/tasks/job-runtime.providers.ts),
  because the barrel spec pins that list and fails CI otherwise.

**No other background work.** Search, rendering and deep links are entirely synchronous and
entirely client-side. The generator runs at build time, in CI, not on a schedule.

---

## 7. Plugin boundaries

**No new plugin, no facade change, no plugin id anywhere in this epic.**

- **Constitution I** is about external integrations. This epic has none: the manual is a local
  build artefact, and the only network hop is web → our own API. Nothing calls a third party,
  holds a credential, or needs a settings schema.
- **Constitution II**: no plugin id appears in any file this epic adds. Section identifiers
  (`start-here`, `running-the-loop`, …) are content taxonomy, defined once in
  `packages/contracts/src/api/help/help.enum.ts`, and are not plugin ids.
- An article **may** describe a plugin-backed capability and **may** carry an "Open the screen"
  action pointing at, for example, the connections list. That is a `ROUTES` key validated by the
  §3.5 unit spec, not a plugin reference. Articles must not hardcode a provider's name in a way
  that implies it is the only option; the authoring rules in `apps/web/src/content/help/README.md`
  state this and the review checklist enforces it.
- The no-results action "Ask the assistant about this" hands the query to the **existing**
  assistant panel, which already resolves its model through the platform's capability resolution.
  This epic adds no model call, no provider selection and no prompt of its own.

---

## 8. i18n

New namespace `dashboard.helpCenter` in
[`apps/web/messages/en.json`](../../../../../apps/web/messages/en.json), then seeded into all 20
sibling locale files with
[`apps/web/scripts/sync-locale-parity.mjs`](../../../../../apps/web/scripts/sync-locale-parity.mjs)
(which seeds full paths — a missing **parent** object collapses the whole subtree into a runtime
error, not an English fallback) and translated with
[`translate-messages.mjs`](../../../../../apps/web/scripts/translate-messages.mjs).

**Every leaf name below is camelCase and contains no literal dot.** A dotted leaf name is a
next-intl runtime error that the hydration e2e specs catch as a console error, reddening several
shards at once.

```
dashboard.helpCenter.title                       "Help"
dashboard.helpCenter.tabLabel                    "Manual"
dashboard.helpCenter.openTooltip                 "Help — press ?"
dashboard.helpCenter.close                       "Close help"
dashboard.helpCenter.searchPlaceholder           "Search the manual…"
dashboard.helpCenter.clearSearch                 "Clear search"
dashboard.helpCenter.onThisScreen                "On this screen"
dashboard.helpCenter.recentlyOpened              "Recently opened"
dashboard.helpCenter.browse                      "Browse"
dashboard.helpCenter.articleCount                "{count, plural, one {1 article} other {# articles}}"
dashboard.helpCenter.resultCount                 "{count, plural, one {1 result} other {# results}}"
dashboard.helpCenter.back                        "Back to Help"
dashboard.helpCenter.reviewedOn                  "Reviewed {date}"
dashboard.helpCenter.onThisPage                  "On this page"
dashboard.helpCenter.related                     "Related"
dashboard.helpCenter.openScreen                  "Open {screen}"
dashboard.helpCenter.needsOwnerAccess            "Needs owner access"
dashboard.helpCenter.copyLink                    "Copy link"
dashboard.helpCenter.linkCopied                  "Link copied"
dashboard.helpCenter.buildStamp                  "Manual for build {version} · {commit}"
dashboard.helpCenter.openFullPage                "Open full page"
dashboard.helpCenter.pageSubtitle                "The manual for the build you're running."
dashboard.helpCenter.englishOnly                 "This article is available in English only."
dashboard.helpCenter.headingMoved                "That section has moved. Here's the whole article."
dashboard.helpCenter.indexLoading                "preparing search…"
dashboard.helpCenter.searchDegraded              "Search is limited right now — matching titles only."
dashboard.helpCenter.externalLink                "Opens outside the app"

dashboard.helpCenter.sections.startHere          "Start here"
dashboard.helpCenter.sections.runningTheLoop     "Running the loop"
dashboard.helpCenter.sections.yourAgents         "Your agents"
dashboard.helpCenter.sections.setupAndConnections "Set-up and connections"
dashboard.helpCenter.sections.moneyAndLimits     "Money and limits"
dashboard.helpCenter.sections.whenSomethingGoesWrong "When something goes wrong"

dashboard.helpCenter.noResults.title             "No results for “{query}”."
dashboard.helpCenter.noResults.browseAll         "Browse all articles"
dashboard.helpCenter.noResults.askAssistant      "Ask the assistant about this"
dashboard.helpCenter.noResults.contactSupport    "Contact support"
dashboard.helpCenter.noResults.reportPrompt      "Tell us what you were looking for"
dashboard.helpCenter.noResults.reportPlaceholder "What were you trying to do?"
dashboard.helpCenter.noResults.reportSent        "Thanks — we'll use this to fill the gap."

dashboard.helpCenter.feedback.prompt             "Was this helpful?"
dashboard.helpCenter.feedback.yes                "Yes"
dashboard.helpCenter.feedback.no                 "No"
dashboard.helpCenter.feedback.notePrompt         "What was missing? (optional)"
dashboard.helpCenter.feedback.send               "Send"
dashboard.helpCenter.feedback.skip               "Skip"
dashboard.helpCenter.feedback.thanks             "Thanks — that helps."
dashboard.helpCenter.feedback.offline            "Sending feedback needs a connection."
dashboard.helpCenter.feedback.rateLimited        "That's a lot of feedback in one go. Try again in a few minutes."
dashboard.helpCenter.feedback.credential         "Please remove any keys or tokens from your note before sending."
dashboard.helpCenter.feedback.signedOut          "Sign in to send feedback."

dashboard.helpCenter.notInBuild.title            "That article isn't in this build."
dashboard.helpCenter.notInBuild.body             "This deployment is running {version}. The article you followed may have been added later, or removed."
dashboard.helpCenter.notInBuild.suggestions      "Did you mean?"
dashboard.helpCenter.notInBuild.browseAll        "Browse all articles"

dashboard.helpCenter.link.howThisWorks           "How this works"
dashboard.helpCenter.link.whyAmISeeingThis       "Why am I seeing this?"
```

Plus one key in the existing metadata namespace: `metadata.pages.help` → `"Help"`.

**Article titles, summaries and bodies are not translated** (spec FR-39). They are build content,
never passed through next-intl, and are rendered beneath the `englishOnly` notice when the reader's
locale is not `en`. Section names _are_ translated, because they are chrome.

One string in the existing `dashboard.sidebar.profileMenu` tree gains a sibling for the preserved
external link; `helpDocs` keeps its key and its position.

---

## 9. Telemetry and failure modes

### 9.1 Telemetry

Client-side, through the already-mounted
[`PostHogProvider.tsx`](../../../../../apps/web/src/components/posthog/PostHogProvider.tsx).

| Event                      | Properties                                                                                         | Answers                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `help_opened`              | `source` (`shortcut` \| `header` \| `sidebar` \| `palette` \| `deep_link` \| `url`), `route_group` | Is the manual reachable where people actually get stuck? |
| `help_search`              | `query_length`, `result_count`, `zero_results`, `sections_matched[]`, `degraded`                   | Is search finding things? Which sections carry the load? |
| `help_article_opened`      | `article_id`, `section`, `source`, `via_heading`                                                   | Which articles earn their place.                         |
| `help_deep_link_followed`  | `target`, `surface` (`empty_state` \| `error_banner` \| `attention_item`)                          | **The number this epic exists to move.**                 |
| `help_feedback_submitted`  | `article_id`, `helpful`, `has_note`                                                                | Which articles fail their readers.                       |
| `help_content_load_failed` | `reason`                                                                                           | How often S-20 fires in the wild.                        |

**Never captured:** the query text (spec FR-19, FR-37), the note text, dwell time, scroll depth,
the article body, or any workspace identifier. No server-side activity-log entry is written when a
person reads an article — reading a manual is not workspace activity and must not appear in an
audit trail.

### 9.2 Failure modes

| Failure                                              | Blast radius                         | Behaviour                                                                                                                                                                                                                                  |
| ---------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The lazy content chunk 404s or times out             | Search quality only                  | Degrade to title + summary matching over the eager catalogue; footer line; browsing and reading titles unaffected (spec S-20). Reading an article body is unavailable until the chunk resolves — the reader sees the summary plus a retry. |
| `localStorage` throws                                | "Recently opened" only               | Group omitted. Every access is in `try/catch`.                                                                                                                                                                                             |
| The version endpoint fails                           | The stamp only                       | Stamp omitted entirely; no placeholder, no `undefined` (spec FR-8).                                                                                                                                                                        |
| The feedback endpoint is down or the session expired | Feedback only                        | Six explicit states (spec §6.10). Reading is never blocked.                                                                                                                                                                                |
| A generated file is stale in a working tree          | Development only                     | `prebuild --check` fails; `tsc` fails on any `HelpTarget` that changed; the unit spec fails on route drift. Never reaches a release.                                                                                                       |
| An article names a removed screen                    | Build                                | Hard failure with the article path and the key (spec FR-5.2).                                                                                                                                                                              |
| A help link points at a removed article              | Build (`tsc`) and, as a net, runtime | Type error at the call site; at runtime `HelpLink` renders nothing (spec FR-22, S-16).                                                                                                                                                     |
| The weekly job fails                                 | The summary only                     | Retried by the job runtime; no reader-facing effect; the next run recomputes from the same rows.                                                                                                                                           |
| A credential is pasted into a note                   | None                                 | Rejected before storage; the text stays in the field; nothing is logged (spec FR-35).                                                                                                                                                      |

---

## 10. Test plan

### 10.1 Unit — web (Vitest, `apps/web/vitest.config.ts`, glob `src/**/*.unit.spec.{ts,tsx}`)

| File                                                           | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/lib/help/help-catalog.unit.spec.ts`              | Every FR-3 limit; unique ids; unique anchors per article; exactly 6 sections; every `documents` key exists in `ROUTES`; none is `DASHBOARD_NOTIFICATIONS`; every `related` id resolves; every article belongs to a rendered section; the FR-9 floor (≥ 18 articles, ≥ 2 per section)                                                                                                                                                                                                                           |
| `apps/web/src/lib/help/help-target.unit.spec.ts`               | Parse and format of `<article>` and `<article>#<heading>`; an unknown article resolves to `null`; a known article with an unknown heading resolves to the article plus a `headingMissing` flag (spec S-15)                                                                                                                                                                                                                                                                                                     |
| `apps/web/src/lib/help/help-search.unit.spec.ts`               | The whole FR-18 score table; the +5 current-screen boost and the 100 cap; tie-breaks; the 20-total / 6-per-section caps; the 2-character floor; diacritic folding; degraded mode returns title and summary matches only                                                                                                                                                                                                                                                                                        |
| `apps/web/src/lib/help/help-recents.unit.spec.ts`              | 5-entry cap; move-to-top on repeat; 90-day expiry; a throwing storage API does not throw into render                                                                                                                                                                                                                                                                                                                                                                                                           |
| `apps/web/src/components/help/HelpCenterPanel.unit.spec.tsx`   | browse / results / article / no-results / degraded / index-loading views; `Esc` precedence (article → results → browse → close); re-opening preserves query and scroll (spec S-22)                                                                                                                                                                                                                                                                                                                             |
| `apps/web/src/components/help/HelpArticleReader.unit.spec.tsx` | Every block kind renders; no block kind produces raw markup; the "Open the screen" action disables with `Needs owner access`; the English-only notice appears only for non-`en` locales                                                                                                                                                                                                                                                                                                                        |
| `apps/web/src/components/help/HelpArticleBlocks.unit.spec.tsx` | **`link` blocks**: an `article` target calls `openHelpAt` in the panel and renders a same-origin link on `/help/[slug]`; a `screen` target renders the `ROUTES` href and disables with `Needs owner access` when unreachable; an `external` target renders `target="_blank"`, `rel="noopener noreferrer"`, the leaving-the-app icon and the `externalLink` accessible text; a stale block with `javascript:`, `http:`, `data:` or an unresolvable article/route renders its label as plain text with no anchor |
| `apps/web/src/lib/help/help-link-blocks.unit.spec.ts`          | Imports the pure `parseArticleBody` the generator exports (the Vitest glob is `src/**/*.unit.spec.*`, so the spec lives beside the catalogue) and runs it over fixture articles: each of the three authored forms produces the exact `HelpLinkBlock`; an inline link, an empty or 81-character label, `/missions`, `http:`, `javascript:`, `data:`, `mailto:`, `//host`, a userinfo URL, a missing article and a missing heading each fail with the article path and line number                               |
| `apps/web/src/components/help/HelpLink.unit.spec.tsx`          | Renders the empty-state phrase and the error phrase; renders **nothing** for an unresolvable target; never renders as a primary button; calls `openHelpAt` rather than navigating                                                                                                                                                                                                                                                                                                                              |
| `apps/web/src/components/help/HelpFeedback.unit.spec.tsx`      | All six states in spec §6.10; the note field appears only after **No**; the 500-character cap; disabled while in flight; a second submission replaces rather than adds                                                                                                                                                                                                                                                                                                                                         |
| `apps/web/src/app/api/help/feedback/route.unit.spec.ts`        | `bffProxy` wiring; article-id pattern rejection; note-length rejection; `422` and `429` mapped to the two copy strings without leaking the upstream body                                                                                                                                                                                                                                                                                                                                                       |

### 10.2 Unit — API (Jest, `apps/api/jest.config.js`, `rootDir: 'src'`, `*.spec.ts`)

| File                                              | Covers                                                                                                                                                                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/help/help.controller.spec.ts`       | `201` on a valid submission; `400` on a bad article id, an over-length note, and a verdict-less, note-less body; `403` on the health summary for a non-platform-admin; throttle metadata present on the write route |
| `apps/api/src/help/help-feedback.service.spec.ts` | Upsert replaces rather than inserts for the same `(userId, articleId)`; two S-13 notes from one person both persist (`articleId` NULL); 400-day pruning selects the right rows                                      |
| `apps/api/src/help/credential-shape.spec.ts`      | Rejects the credential shapes we actually issue and the common third-party prefixes; accepts ordinary prose containing the words "key" and "token"; the rejected note appears in no log line                        |

### 10.3 Unit — agent package (Jest)

| File                                                                    | Covers                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/agent/src/help/__tests__/help-content-health.service.spec.ts` | Per-article aggregation; the ≥ 10 responses / ≥ 40% negative flag boundary (9 responses does not flag; exactly 40% does); staleness at exactly 180 days; the pass still completes with a stated reason when the catalogue is unavailable |

### 10.4 E2E (Playwright, `apps/web/e2e/`)

| File                                   | Covers                                                                                                                                                                                                                                                                                                   |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/e2e/help-center.spec.ts`     | `?` opens the panel from four different screens and is ignored inside a text field; the header control and the sidebar entry open it; browse → article → `Esc` returns to browse; the build stamp matches the footer's version; `/help` and `/help/[slug]` render inside the shell and require a session |
| `apps/web/e2e/help-search.spec.ts`     | 1 character does not search, 2 do; zero network requests are issued during search; result caps; the no-results state and its three actions; blocking the content chunk yields the degraded footer line and title matches                                                                                 |
| `apps/web/e2e/help-deep-links.spec.ts` | Each wired empty state and the degraded-background-work banner opens the panel in place at the right article and heading with no navigation; a URL with an unknown heading shows the "moved" line; a URL with an unknown article shows the not-in-this-build page carrying the running version           |
| `apps/web/e2e/help-feedback.spec.ts`   | Yes then No leaves exactly one response; the note field cap; a credential-shaped note is rejected with the text preserved; the rate-limit copy after the cap                                                                                                                                             |
| `apps/web/e2e/help-a11y.spec.ts`       | Focus trap and focus restoration; arrow-key navigation skipping section headings; the polite result-count announcement; a 375 px viewport renders full-screen with no horizontal page scroll; a right-to-left locale mirrors without overlap                                                             |

Register every row in [`apps/web/e2e/COVERAGE.md`](../../../../../apps/web/e2e/COVERAGE.md),
which is hand-maintained per controller and per web route.

### 10.5 Gates that come for free

- `pnpm type-check` fails on any `HelpTarget` that stops resolving — this is spec FR-5.3.
- `apps/web` `prebuild` runs `build-help-catalog.mjs --check` and fails on a stale generated file.
- The existing locale-parity e2e keeps the new namespace from being missing in a locale file
  beyond the catastrophic-gap floor.
- The existing hydration e2e specs catch a dotted i18n leaf name as a console error.
- The four entity-registration drift specs fail if the new entity is registered in fewer than all
  four places.

---

## 11. Phasing

Each phase is independently shippable and leaves `develop` green.

### P1 — The manual exists, is reachable, and is deep-linkable

Ships: the authoring folder and the generator; the eager catalogue and the `HelpTarget` union; the
new drawer tab with browse and article reading; the build stamp; `/help` and `/help/[slug]`
including the not-in-this-build state; `HelpLink` wired into ≥ 14 surfaces; the full i18n
namespace; at least 18 articles across all six sections.

Search in P1 matches **titles, summaries and keywords** from the eager catalogue — honest, useful
at this corpus size, and it means P1 has no lazy chunk to fail. No database, no API, no background
job, no palette dependency.

**Done when:** every acceptance-criteria box under _Reaching it_, _Not disagreeing with the build_,
_Deep links_, _Reading_ and _Language, accessibility, layout_ is ticked, minus the search rows.

### P2 — Full-text search and the palette

Ships: the lazy content chunk with body postings; the full FR-18 ranking including heading matches
and the current-screen boost; the degraded fallback (S-20); the no-results state with its three
actions; "Recently opened"; "On this screen"; "Copy link"; the **Help** result group registered
into the command palette.

**Depends on:** [AW-01](../AW-01-command-palette/plan.md) for the palette group only. Every other
part of P2 ships without it.

**Done when:** the _Searching_ acceptance rows are ticked and the palette shows a Help group with
the network disabled.

### P3 — Feedback, content health, and the mirror

Ships: the entity, the migration, the API module, the BFF route, the feedback control, the S-13
report control, the weekly content-health job with its 400-day pruning, the print stylesheet, and
— optionally — `export-help-docs.mjs` writing a mirror into `docs/help/` with a one-time sidebar
entry in [`apps/docs/sidebarsPlatform.ts`](../../../../../apps/docs/sidebarsPlatform.ts).

**Done when:** the _Feedback_ and _Content health_ acceptance rows are ticked and the migration has
run on a fresh database and on a database that already has the table.

---

## 12. Constitution compliance

| Gate                                               | Status | Justification                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **I — Plugin-first**                               | ✅     | No external integration. The manual is a build artefact; the only network hop is web → our own API. No provider, no credential, no settings schema, no outbound call.                                                                                                                                                                                                                                |
| **II — Capability-driven resolution**              | ✅     | No plugin id appears anywhere in this epic. Section identifiers are content taxonomy. "Ask the assistant about this" hands off to the existing assistant, which resolves its model through the existing capability resolution.                                                                                                                                                                       |
| **III — Source-of-truth repositories**             | ✅     | Untouched. The manual is our product documentation, not user content; it never enters a user's data or site repository, and no user content enters the manual.                                                                                                                                                                                                                                       |
| **IV — Job runtime**                               | ✅     | The one scheduled job is registered through the configured provider's native cron mechanism in `packages/tasks`. No `@Cron` on the API process, no `@trigger.dev/sdk` import outside `packages/tasks`. A future fan-out variant must declare a `*_DISPATCHER` symbol and register it in `_tasks-symbols.ts` (§6).                                                                                    |
| **V — Forward-only migrations**                    | ✅     | One entity, one migration, same PR (§3.2, §3.4). `up()` creates only new objects with `ifNotExists`; `down()` drops only what it created; no data is destroyed and nothing pre-existing is altered.                                                                                                                                                                                                  |
| **VI — Tests are a prerequisite**                  | ✅     | 9 web unit specs, 3 API specs, 1 agent spec, 5 e2e specs, plus five build-level gates (§10). The catalogue-invariants spec is itself the mechanism for spec FR-5.                                                                                                                                                                                                                                    |
| **VII — Privacy & secret hygiene**                 | ✅     | Search query text is never stored or logged (FR-19, FR-37). Notes matching a credential shape are rejected before storage and never logged (FR-35). Feedback notes are platform-admin-only and expire at 400 days. No secret-bearing field is read by any part of this epic.                                                                                                                         |
| **VIII — Single source of truth for plugin lists** | ✅     | The manual links to the canonical built-in-plugins document rather than restating counts or lists; the authoring rules in `apps/web/src/content/help/README.md` forbid a plugin count in an article.                                                                                                                                                                                                 |
| **IX — Specs are behaviour-first**                 | ✅     | [spec.md](./spec.md) contains no file path, class name or code. Every implementation detail — the generator, the union type, the entity, the migration, the job — is in this plan.                                                                                                                                                                                                                   |
| **X — Backwards compatibility**                    | ✅     | Two additive endpoints under a new path, additive-only contracts exports, two additive `ROUTES` constants, one additive optional prop on the shared empty state, one additive drawer tab. Nothing renamed, nothing removed, no existing response shape changed. Article identifiers are never reused (FR-3), so an old link either resolves to the same article or shows the not-in-this-build page. |

---

## 13. References

- Program overview and the rules every epic follows: [`../README.md`](../README.md)
- Finished-backend inventory this epic did **not** need: [`../EXISTING-SUBSTRATE.md`](../EXISTING-SUBSTRATE.md)
- The palette this epic registers a result group into: [`../AW-01-command-palette/plan.md`](../AW-01-command-palette/plan.md)
- The changelog this epic cross-links with: [`../AW-14-whats-new/plan.md`](../AW-14-whats-new/plan.md)
- Constitution: [`.specify/memory/constitution.md`](../../../../../.specify/memory/constitution.md)
- Spec Kit conventions and templates: [`.specify/templates/`](../../../../../.specify/templates)
