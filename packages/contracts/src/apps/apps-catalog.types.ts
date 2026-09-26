/**
 * App Works — the **Apps catalog** and **Blueprint resolution** vocabulary: one
 * entry as the platform sanitizes it, the list query and its response, the
 * detail, and what a resolution attempt returns.
 *
 * Owning epic: **APW-03** (App spec, Apps catalog and license gate).
 *
 * Spec: `docs/specs/features/app-works/APW-03-app-spec-and-catalog/catalog.md`
 * §3.1 (the `manifest.json` entry fields, cited row by row below), §3.2 (the
 * verification evidence), §4 (`licenses.yml`) and §5 (the Blueprint repository
 * and its overlay limits). `.../spec.md` FR-27…FR-35 (the catalog) and FR-40,
 * FR-43, FR-81 (resolution). Plan: `.../plan.md` §2.4 (the service, the cache
 * and `managedHostingAvailability`), §2.5 (the resolver flow and the apply job),
 * §3.2:468 (this file's place in the shared-type table) and §4.1 (the three
 * public routes). Bindings: `docs/specs/features/app-works/CONTRACTS.md` §2A
 * (:321, :326) and **R-3** (a `red` row is dropped and never listed), **R-5**
 * (tier state is passed in, never read here) and **R-26** (additive only).
 *
 * **Nothing here reads an environment variable or a policy.** The catalog's
 * purity is part of its contract (plan §2.4:216): a resolved availability is a
 * value computed from the arguments a caller hands over, so the same inputs
 * always produce the same verdict and a test can prove it without an
 * environment.
 *
 * Where the numbers live: plan §3.2 lists every constant in one block and names
 * `apps-limits.ts` as their home. That file already shipped with APW-01's
 * repository-stage and quota limits and this task must not edit a landed
 * module, so the catalog's and the resolver's limits live here, next to the
 * shapes they bound. No number is declared twice anywhere in this folder.
 */

import type { AppDependencyKind } from './app-dependencies.js';
import type { ManagedHostingAvailability, BlueprintMatchSource, LicenseClass } from './app-license.types.js';

import type { AppBlueprintPrompt } from './app-source.js';

// ---------------------------------------------------------------------------
// The catalog's limits and cadence (plan §3.2:483-496)
// ---------------------------------------------------------------------------

/**
 * How long a successful catalog read is cached — 3 600 000 ms
 * (plan §2.4:212 "TTL 1 h"; FR-27's service).
 */
export const APPS_CATALOG_CACHE_TTL_MS = 3_600_000;

/**
 * How long a **failed** read is cached before another attempt — 30 000 ms
 * (plan §2.4:212, §9.2:829 "30 s negative cache"; FR-29).
 */
export const APPS_CATALOG_FAILURE_TTL_MS = 30_000;

/**
 * The tokenless read's timeout — 8 000 ms (plan §2.4:210 "tokenless
 * `raw.githubusercontent.com/…` (8 s, User-Agent …)"; FR-28).
 */
export const APPS_CATALOG_FETCH_TIMEOUT_MS = 8_000;

/**
 * The largest `manifest.json` the service accepts — 2 097 152 bytes
 * (catalog.md:78 "file ≤ 2 MiB"; plan §2.4:211). A larger body is treated as a
 * failed read, not as a partial catalog.
 */
export const APPS_CATALOG_MANIFEST_MAX_BYTES = 2_097_152;

/** The most entries one `manifest.json` may carry — 1 000 (catalog.md:78; plan §2.4:211). */
export const APPS_CATALOG_MAX_ENTRIES = 1_000;

/**
 * The largest `licenses.yml` the service accepts — 262 144 bytes
 * (catalog.md:261 "file ≤ 256 KiB"; plan §2.4:211).
 */
export const APPS_CATALOG_REGISTRY_MAX_BYTES = 262_144;

/**
 * How long the last good license registry is kept — seven days
 * (plan §2.4:212 "keeps the last parsed registry for 7 days"; FR-38's
 * live → last good → snapshot preference, plan §2.6:321-323).
 */
export const APPS_CATALOG_LAST_GOOD_REGISTRY_MS = 7 * 86_400_000;

/** The default page size of `GET /api/apps-catalog` — 24 (plan §3.2:490). */
export const APPS_CATALOG_PAGE_SIZE = 24;

/** The largest `limit` the public list accepts — 100 (FR-32 spec.md:264-266; plan §3.2:491). */
export const APPS_CATALOG_PAGE_SIZE_MAX = 100;

/**
 * How many characters a search term needs before it is used — 2 (FR-32
 * spec.md:263-264 "search (minimum 2 characters)"; plan §3.2:492). A one-character
 * `q` is ignored rather than answered with a narrowed list (ACC-03-19).
 */
export const APPS_CATALOG_SEARCH_MIN_CHARS = 2;

/**
 * How much of a Blueprint's `README.md` is served and sanitized — 65 536 bytes
 * (FR-33 spec.md:267; catalog.md:309; plan §2.4:217).
 */
export const APPS_CATALOG_README_MAX_BYTES = 65_536;

/** How many public catalog requests one client may make per minute — 120 (plan §4.1:543-545). */
export const APPS_CATALOG_PUBLIC_PER_MIN = 120;

/**
 * How many App Works one hourly refresh may fan out an upgrade notice to — 500
 * (plan §3.2:495; T30 tasks.md:566-567, ACC-03-22).
 */
export const APPS_CATALOG_FANOUT_PER_RUN = 500;

/**
 * The hourly catalog refresh's cron — `23 * * * *` (plan §3.2:496).
 *
 * T30 pins this constant **equal** in the Trigger.dev task and in the API's
 * fallback cron service, so the two schedules can never drift apart.
 */
export const APPS_CATALOG_REFRESH_CRON = '23 * * * *';

// ---------------------------------------------------------------------------
// Resolution and apply limits (plan §3.2:497-505)
// ---------------------------------------------------------------------------

/** How long a **hit** is cached — 3 600 000 ms (plan §2.5:250-251; FR-43). */
export const BLUEPRINT_RESOLVE_HIT_TTL_MS = 3_600_000;

/** How long a **miss** is cached — 600 000 ms (plan §2.5:250-251). */
export const BLUEPRINT_RESOLVE_MISS_TTL_MS = 600_000;

/**
 * How many provider reads the probe path may spend — 3
 * (plan §2.5:250 "At most 3 provider reads on the probe path"; FR-43; ACC-03-25).
 */
export const BLUEPRINT_PROBE_MAX_READS = 3;

/**
 * The most alternatives a resolution may report — 5 (plan §3.2:500).
 *
 * **Gap, named rather than guessed:** plan §3.2 declares this constant and no
 * prose in this epic says what it caps. It is declared because T1 requires every
 * constant of that block to exist with its value; the resolver's
 * unlisted-repository path is the only place it can apply today, and the epic's
 * text must say which before a caller relies on it.
 */
export const BLUEPRINT_ALTERNATIVES_MAX = 5;

/** The most overlay files one Blueprint may contribute — 50 (catalog.md:304; plan §3.2:501). */
export const BLUEPRINT_OVERLAY_MAX_FILES = 50;

/** The largest single overlay file — 1 048 576 bytes (catalog.md:304 "each ≤ 1 MiB"). */
export const BLUEPRINT_OVERLAY_FILE_MAX_BYTES = 1_048_576;

/** The largest overlay set in total — 5 242 880 bytes (catalog.md:304 "total ≤ 5 MiB"). */
export const BLUEPRINT_OVERLAY_TOTAL_MAX_BYTES = 5_242_880;

/**
 * How many times a non-fast-forward `commitFiles` is retried before the apply
 * falls back to the pull-request path — 3 (plan §2.5:279-280, §9.2:832).
 */
export const BLUEPRINT_APPLY_RETRIES = 3;

/** How many applies one App Work accepts per hour — 5 (plan §4.1:549-550). */
export const BLUEPRINT_APPLY_PER_HOUR = 5;

// ---------------------------------------------------------------------------
// Closed vocabularies (catalog.md §3.1:89, :92; §3.2:132)
// ---------------------------------------------------------------------------

/**
 * The fifteen catalog categories (catalog.md:89), in that row's order — the
 * `category.<category>` i18n keys of plan §8:786 are exactly these fifteen.
 */
export const APPS_CATALOG_CATEGORIES = [
	'analytics',
	'communication',
	'content',
	'crm',
	'developer-tools',
	'finance',
	'forms',
	'knowledge',
	'marketing',
	'productivity',
	'project-management',
	'scheduling',
	'security',
	'support',
	'other'
] as const;

/** Union derived from {@link APPS_CATALOG_CATEGORIES}. */
export type AppsCatalogCategory = (typeof APPS_CATALOG_CATEGORIES)[number];

/**
 * An entry's maturity (catalog.md:92): `production`, `beta` or `placeholder`.
 * A placeholder is listed and marked **not selectable** — it is how the catalog
 * says "this app is coming" without pretending it can be created (FR-32).
 */
export const APPS_CATALOG_ENTRY_STATUSES = ['production', 'beta', 'placeholder'] as const;

/** Union derived from {@link APPS_CATALOG_ENTRY_STATUSES}. */
export type AppsCatalogEntryStatus = (typeof APPS_CATALOG_ENTRY_STATUSES)[number];

/**
 * The verification evidence's computed state (catalog.md:132): `candidate`,
 * `verified`, `at-risk`, `not-verified`. One failed run at the current pin gives
 * `at-risk` **and keeps the badge**; a second consecutive failure, or a
 * classified licence that differs from the declared one, gives `not-verified`
 * and removes it; a pin change resets to `candidate` (catalog.md:143-144;
 * FR-34).
 */
export const APPS_CATALOG_VERIFICATION_STATUSES = ['candidate', 'verified', 'at-risk', 'not-verified'] as const;

/** Union derived from {@link APPS_CATALOG_VERIFICATION_STATUSES}. */
export type AppsCatalogVerificationStatus = (typeof APPS_CATALOG_VERIFICATION_STATUSES)[number];

/**
 * The two classes an entry's `license.class` may declare (catalog.md:105
 * "`green` · `amber` — must equal the class `licenses.yml` computes for `spdx`").
 *
 * `red` is absent on purpose: a row whose `spdx` classifies `red` in the
 * registry is **dropped**, whatever its own `license.class` claims (plan
 * §2.4:213, R-3; ACC-03-46), so a `red` class never reaches a caller.
 */
export const APPS_CATALOG_ENTRY_LICENSE_CLASSES = ['green', 'amber'] as const;

/** Union derived from {@link APPS_CATALOG_ENTRY_LICENSE_CLASSES}. */
export type AppsCatalogEntryLicenseClass = (typeof APPS_CATALOG_ENTRY_LICENSE_CLASSES)[number];

// ---------------------------------------------------------------------------
// The catalog entry (catalog.md §3.1:83-121)
// ---------------------------------------------------------------------------

/** One upstream of an entry (catalog.md:96-100). */
export interface AppsCatalogUpstream {
	/** The current canonical `owner/repo`. */
	repo: string;
	/** ≤ 5 former names (renames and transfers) in the same format. */
	aliases?: readonly string[];
	refs?: AppsCatalogUpstreamRefs;
}

/**
 * Which of an upstream's refs a Blueprint covers (catalog.md:98-100).
 *
 * `exclude` is what produces a **ref mismatch**: a tag or branch matching it
 * must never resolve to the entry (FR-40; `refMismatch`).
 */
export interface AppsCatalogUpstreamRefs {
	/** ≤ 10 glob patterns the built branch must match; `["*"]` when absent. */
	branches?: readonly string[];
	/** A semantic-version range a tag must satisfy when a tag is built (e.g. `>=7.0.0`). */
	tags?: string;
	/** ≤ 10 glob patterns of branches or tags that must never match. */
	exclude?: readonly string[];
}

/** The Blueprint an entry points at (catalog.md:101-103): all three pinned in the manifest. */
export interface AppsCatalogBlueprintRef {
	/** `^ever-works/[a-z0-9-]+$`. */
	repo: string;
	/** Semantic version; a tag `v<version>` must exist in the Blueprint repository. */
	version: string;
	/** `^[0-9a-f]{40}$`; must equal the commit the tag points to. */
	sha: string;
}

/** The upstream licence an entry declares (catalog.md:104-105). */
export interface AppsCatalogLicenseRef {
	/** An SPDX expression of the upstream at the pinned refs. */
	spdx: string;
	/** Must equal the class `licenses.yml` computes for `spdx`. */
	class: AppsCatalogEntryLicenseClass;
}

/**
 * The recorded agreement that permits hosting an **amber** entry on Ever Works
 * Apps (catalog.md:108).
 *
 * `reference` identifies the agreement record kept in the private operations
 * repository — never the agreement's text or terms — and `recordedAt` is an ISO
 * 8601 date. The mapper **strips this object from every non-amber row** (plan
 * §2.4:213), and its presence is what turns `upstreamAgreementMissing` into an
 * available verdict (R-3).
 */
export interface AppsCatalogUpstreamAgreement {
	/** `^[A-Za-z0-9._-]{1,80}$`. */
	reference: string;
	/** ISO 8601 date. */
	recordedAt: string;
}

/** What an entry declares about Ever Works Apps hosting (catalog.md:106-108). */
export interface AppsCatalogManagedHosting {
	/** `false` when the licence, a trademark or an operational reason rules the managed tier out. */
	allowed: boolean;
	/** ≤ 200 characters, shown when `allowed` is `false`. */
	reason?: string;
	/** Amber only; ignored (and a CI failure) on any other class. */
	upstreamAgreement?: AppsCatalogUpstreamAgreement;
}

/** The trademark facts the platform copies into the App spec (catalog.md:109-111). */
export interface AppsCatalogTrademark {
	/** ≤ 300 characters. */
	notice?: string;
	/** ≤ 40 characters, e.g. `(community build)`; `display.name` becomes `"<name> <suffix>"`. */
	displayNameSuffix?: string;
	/** ≤ 50 globs copied into `display.protectedPaths`. */
	protectedPaths?: readonly string[];
}

/** What the entry needs to run, summed by CI (catalog.md:112-115). */
export interface AppsCatalogMinResources {
	/** Sum of requests across components, e.g. `750m`. */
	cpu: string;
	/** e.g. `1536Mi`. */
	memory: string;
	/** Sum of volumes and dependency storage, e.g. `10Gi`. */
	storage?: string;
	/** A hint for the build target, e.g. `12Gi`. */
	buildMemory?: string;
}

/** Text links shown on the card (catalog.md:119): `https://` URLs ≤ 300 characters, never fetched. */
export interface AppsCatalogLinks {
	homepage?: string;
	docs?: string;
}

/**
 * One piece of verification evidence (catalog.md:141): `{ path, runUrl, result }`,
 * ≤ 10 most recent, `path` under `evidence/<id>/`.
 *
 * **Gap, named rather than guessed:** catalog.md:141 writes the third field as
 * `result` and no table in this epic gives its value set, so it stays a `string`
 * here. The predicate that matters — `isVerified(entry, now)` — reads
 * `blueprintSha` and `expiresAt` (plan §2.4:215), never this field.
 */
export interface AppsCatalogVerificationEvidence {
	/** A path under `evidence/<id>/`. */
	path: string;
	/** The CI run that produced the evidence. */
	runUrl: string;
	/** The run's outcome, as the catalog repository writes it. */
	result: string;
}

/**
 * A verified entry's evidence (catalog.md §3.2:130-141).
 *
 * `verification.status` drives `verified` (catalog.md:143-144), and the badge is
 * shown only while `verified` is true, `blueprintSha` matches the entry's
 * `blueprint.sha` and `expiresAt` is in the future (catalog.md:127-128;
 * plan §2.4:215 `isVerified`).
 */
export interface AppsCatalogVerification {
	status: AppsCatalogVerificationStatus;
	/** ISO 8601; the first passing run at the current pin. */
	verifiedAt?: string;
	/** ISO 8601; the most recent passing run. */
	lastPassedAt?: string;
	/** ISO 8601; ≤ `lastPassedAt` + 180 days. */
	expiresAt?: string;
	/** Must equal `blueprint.sha`. */
	blueprintSha?: string;
	/** The 40-hex upstream commit the passing runs built. */
	pinnedUpstreamSha?: string;
	/** `true` when the latest canary run on the upstream head failed; informational only. */
	canaryBehind?: boolean;
	/** The platform release of the last passing run. */
	platformVersion?: string;
	/** The GitHub login of the maintainer who merged the evidence. */
	verifiedBy?: string;
	/** ≤ 10 most recent evidence files. */
	evidence?: readonly AppsCatalogVerificationEvidence[];
}

/**
 * One catalog entry, sanitized (catalog.md §3.1:83-121, §3.2:123-144; FR-30).
 *
 * `id`…`links` are the manifest's own fields, with strings stripped of HTML and
 * every rule of §3.1 applied by the mapper; `verified`, `managed` and
 * `yourCluster` are **computed** and are what the browser's badges, the
 * `runs on` line and the managed tooltip read (FR-34, FR-35; plan §8:787-788).
 * A row is dropped — never returned half-sanitized — when its `spdx` classifies
 * `red` (R-3), when `blueprint.repo` is outside `ever-works/`, or when any other
 * §3.1 rule fails (plan §2.4:213).
 */
export interface AppsCatalogEntry {
	/** `^[a-z0-9][a-z0-9-]{0,63}$`, unique, never reused after removal. */
	id: string;
	/** 1–60 characters, plain text. */
	name: string;
	/** 1–160 characters, plain text. */
	summary: string;
	/** ≤ 2 000 characters, a Markdown subset. */
	description?: string;
	category: AppsCatalogCategory;
	/** ≤ 8 tags, each `^[a-z0-9][a-z0-9-]{0,39}$`. */
	tags?: readonly string[];
	/** `^icons/[a-z0-9-]+\.svg$`. */
	icon: string;
	status: AppsCatalogEntryStatus;
	/** When several entries share an upstream, exactly one is `true`. */
	default?: boolean;
	/** ≤ 12 featured entries per file. */
	featured?: boolean;
	/** 1–5; empty only for a `placeholder`. */
	upstreams: readonly AppsCatalogUpstream[];
	blueprint: AppsCatalogBlueprintRef;
	license: AppsCatalogLicenseRef;
	managedHosting: AppsCatalogManagedHosting;
	trademark?: AppsCatalogTrademark;
	minResources: AppsCatalogMinResources;
	/** The dependency kinds CI derived from the App spec. */
	dependencies?: readonly AppDependencyKind[];
	/** Computed by CI from `verification.status`; never hand-edited (catalog.md:117). */
	verified: boolean;
	/** Present when `verified` (catalog.md:118). */
	verification?: AppsCatalogVerification;
	links?: AppsCatalogLinks;
	/**
	 * FR-35: `available`, or the **first** failing managed reason in evaluation
	 * order. Computed by the pure `managedHostingAvailability` from the entry's
	 * licence class, its `managedHosting` block, the registry and the tier state
	 * the caller passes in (plan §2.4:216) — never read from a policy here (R-5).
	 */
	managed: ManagedHostingAvailability;
	/**
	 * Whether the entry may run on **Your cluster**. `true` for every listed row:
	 * `licenses.yml` gives all three classes `yourCluster: true` (catalog.md:194-196)
	 * and a `red` row is dropped before it is listed (R-3). It is carried so the
	 * browser's `Runs on: Your cluster · Ever Works Apps` line is one comparison
	 * (`yourCluster && managed === 'available'`) rather than an assumption.
	 */
	yourCluster: boolean;
}

/**
 * The public list's query (plan §4.1:543): `q, category, tag, status,
 * licenseClass, managed, page, limit`.
 *
 * `q` below {@link APPS_CATALOG_SEARCH_MIN_CHARS} characters is **ignored**
 * (ACC-03-19), `limit` is capped at {@link APPS_CATALOG_PAGE_SIZE_MAX}, and
 * search spans name, summary, tags and upstream repository names (FR-32).
 */
export interface AppsCatalogListQuery {
	q?: string;
	category?: AppsCatalogCategory;
	tag?: string;
	status?: AppsCatalogEntryStatus;
	licenseClass?: LicenseClass;
	/** `true` narrows to entries whose `managed` is `available`. */
	managed?: boolean;
	/** 1-based; `1` when absent. */
	page?: number;
	/** Defaults to {@link APPS_CATALOG_PAGE_SIZE}, capped at {@link APPS_CATALOG_PAGE_SIZE_MAX}. */
	limit?: number;
}

/**
 * The public list's response (plan §3.2:468; plan §4.1:543).
 *
 * `available` is the catalog's reachability, **not** an entry's: an unreachable
 * catalog answers `200 { items: [], total: 0, available: false }` rather than an
 * error (FR-29, ACC-03-16), and `items` are already ordered featured, then
 * verified, then name (FR-32).
 */
export interface AppsCatalogListResponse {
	items: readonly AppsCatalogEntry[];
	total: number;
	available: boolean;
	page: number;
	limit: number;
}

/**
 * The App-spec summary a detail carries (FR-33 spec.md:267-269: "a summary of
 * its App spec (components, dependencies, number of variables asked at setup),
 * read at the pinned commit and cached for 1 hour").
 *
 * The plan names the field but not its shape; the three members are FR-33's own
 * three items, which is also what the details drawer renders (`Asks you for
 * {count} at setup`, spec.md:562-563).
 */
export interface AppsCatalogSpecSummary {
	/** How many `components[]` the Blueprint's spec declares. */
	components: number;
	/** The dependency kinds the Blueprint's spec declares. */
	dependencies: readonly AppDependencyKind[];
	/** How many `env` entries the spec asks a person for (an entry with `prompt`). */
	promptedVariables: number;
}

/**
 * One entry plus its detail (plan §2.4:217; FR-33, plan §4.1:545).
 *
 * `readme` is the first {@link APPS_CATALOG_README_MAX_BYTES} of the Blueprint
 * repository's `README.md` at the pinned sha, sanitized with the platform's
 * Markdown sanitizer — the drawer renders it and never fetches anything itself
 * (plan §5.2:627).
 */
export interface AppsCatalogDetail extends AppsCatalogEntry {
	/** Sanitized Markdown, ≤ {@link APPS_CATALOG_README_MAX_BYTES} bytes of source. */
	readme?: string;
	/** Read from the Blueprint repository at `blueprint.sha`. */
	specSummary?: AppsCatalogSpecSummary;
}

// ---------------------------------------------------------------------------
// Blueprint resolution (plan §2.5:220-252; FR-40, FR-43, FR-81)
// ---------------------------------------------------------------------------

/**
 * Why a repository resolved to **no** Blueprint, using the resolver flow's own
 * words (plan §2.5:228, :237-238):
 *
 * - `notListed` — no manifest entry, alias, fork root, or probe hit (FR-40).
 * - `lookupFailed` — a provider read failed, so the answer is unknown rather
 *   than negative (APW-01 answers `unavailable` in that case, so a member is
 *   never told "no Blueprint" because GitHub was rate-limiting).
 * - `refMismatch` — the repository matched an entry, but the requested ref is
 *   outside the entry's `refs` constraints (branches, tags range, `exclude`).
 * - `blueprintNotFound` — an explicit `blueprintId` (FR-81) is in neither the
 *   catalog nor a probe hit; the API answers `404 blueprintNotFound`
 *   (plan §4.2:568, ACC-03-44).
 */
export const BLUEPRINT_RESOLUTION_REASONS = ['notListed', 'lookupFailed', 'refMismatch', 'blueprintNotFound'] as const;

/** Union derived from {@link BLUEPRINT_RESOLUTION_REASONS}. */
export type BlueprintResolutionReason = (typeof BLUEPRINT_RESOLUTION_REASONS)[number];

/**
 * A repository that resolved to a Blueprint (plan §2.5:225-238).
 *
 * The four pinned facts are the ones the apply job writes into
 * `WorkAppSpecState` and into the composed `spec.blueprint` block
 * (plan §3.1:424, §2.5:269-271). `refs` constraints apply to a **non-explicit**
 * match only; an explicit id for a repository the entry does not list skips the
 * ref check and is **never verified** for managed hosting (FR-81,
 * plan §2.4:216).
 */
export interface BlueprintResolutionMatch {
	/** Never `null` on a match — this is the union's discriminant. */
	matchSource: BlueprintMatchSource;
	blueprintId: string;
	/**
	 * The entry's version. **Optional** because a probe hit carries none: the
	 * probe only proves a `ever-works/<name>-template` repository exists with a
	 * valid `blueprint`-mode spec, which is what "Unlisted Blueprint" means
	 * (plan §2.5:234-237).
	 */
	blueprintVersion?: string;
	blueprintRepo: string;
	/** The pinned commit the Blueprint is read at. */
	blueprintSha: string;
	/** The trademark display name FR-63 makes the Work's default name. */
	displayName?: string;
	/** Whether the App Work's name may be shown as hosted/verified (FR-34). */
	verified: boolean;
	/** The entry's declared class, when there is an entry. */
	licenseClass?: LicenseClass;
	/** The entry's declared SPDX expression, when there is an entry. */
	spdx?: string;
	/** The values the Blueprint asks for — names and descriptions only, never a value (FR-55). */
	prompts?: readonly AppBlueprintPrompt[];
	/**
	 * The upstream a **fork-network** match resolved through: the root `source`
	 * repository of the fork network, else the immediate `parent` (FR-40,
	 * plan §2.5:241-244). Present only on a `fork` match.
	 */
	upstreamRepo?: string;
	/**
	 * `true` on a fork-network match until the member confirms it: the apply is
	 * refused with `409 forkMatchNeedsConfirmation` (plan §4.2:569) so a fork of
	 * a fork never silently inherits a Blueprint nobody chose. The confirmation
	 * travels back as `confirmForkMatch: true` and the persisted match source is
	 * reused on a later apply (plan §2.5:256-263).
	 */
	confirmationRequired?: boolean;
}

/**
 * A repository that resolved to **no** Blueprint (plan §2.5:237-238): the
 * resolver's `none` outcome and the `refMismatch` outcome, which APW-01's
 * adapter maps to `null` so the App Provisioner path is taken (plan §2.7:380).
 */
export interface BlueprintResolutionMiss {
	/** `null` on a miss — the discriminant that separates this from a match. */
	matchSource: null;
	reason: BlueprintResolutionReason;
	/** The upstream a fork-network attempt compared against, when one was read (FR-40). */
	upstreamRepo?: string;
}

/**
 * What one resolution attempt returns (plan §3.2:468): a match or a miss.
 *
 * `BlueprintResolutionMatch.matchSource` is never `null` and
 * `BlueprintResolutionMiss.matchSource` always is, so `resolution.matchSource === null`
 * narrows the union without a cast.
 */
export type BlueprintResolution = BlueprintResolutionMatch | BlueprintResolutionMiss;
