/**
 * App Works — the App Launcher contract: the panel, the apps registry and the
 * personal arrangement (pins, hides and order) in one vocabulary.
 *
 * Owning epic: **APW-11** (App Launcher & Apps registry API).
 *
 * Spec: `docs/specs/features/app-works/APW-11-app-launcher/spec.md`; the FR-*
 * ids quoted below are that file's. Plan:
 * `docs/specs/features/app-works/APW-11-app-launcher/plan.md` §3.3 is the
 * normative type reference implemented here, and §4.1–§4.3 the routes that carry
 * these shapes (`plan.md:` line numbers are cited throughout).
 * Bindings: `docs/specs/features/app-works/CONTRACTS.md` §3 (routes at :402-403)
 * and **R-26** — the owner's additive-only rule: a union gains a member, a limit
 * is raised deliberately, and no name declared here is ever removed, renamed or
 * narrowed.
 *
 * Why one module: the API writes these shapes, the web server action reads them
 * and the P2 web component renders them (`plan.md:326`, APW11-G22) — a second
 * copy of "the same" tile or "the same" limit is how the panel and **Manage
 * apps** start disagreeing about what a person pinned. Where plan §3.3 wrote a
 * closed union inline (`'platform' | 'work'`) it is declared here as the array +
 * derived type pair the rest of this folder uses, so the same members are also
 * checkable at run time; that is additive, never a narrowing.
 *
 * Types, closed unions, constants and pure predicates only: no I/O, no import
 * from another workspace package, and no number that is not the spec's or plan
 * §3.3's — each constant names the line it comes from.
 */

// ---------------------------------------------------------------------------
// Closed vocabularies (plan §3.3:245-251, 261, 289, 299)
// ---------------------------------------------------------------------------

/**
 * The environments a launcher item can be addressed in, in FR-9's order
 * (spec.md:214-215) and the only values `?environment=` accepts (`plan.md:444`).
 * FR-10 is why this set is closed: an entry with no address for the environment
 * Ever Works is itself running in is not shown, and nothing may ever send a
 * person from one environment to another.
 */
export const APP_LAUNCHER_ENVIRONMENTS = ['production', 'stage', 'develop'] as const;

/** Union derived from {@link APP_LAUNCHER_ENVIRONMENTS}. */
export type AppLauncherEnvironment = (typeof APP_LAUNCHER_ENVIRONMENTS)[number];

/**
 * The two kinds of launcher item (`plan.md:248`): a platform read from the Ever
 * apps catalog, or one of the person's own Works — FR-2's two sections
 * (spec.md:188-189).
 */
export const APP_LAUNCHER_ITEM_KINDS = ['platform', 'work'] as const;

/** Union derived from {@link APP_LAUNCHER_ITEM_KINDS}. */
export type AppLauncherItemKind = (typeof APP_LAUNCHER_ITEM_KINDS)[number];

/**
 * The three sections an item renders under (`plan.md:249`, FR-2 spec.md:188-189):
 * the **Pinned** row (rendered only when at least one item is pinned), **Ever
 * apps** and **Your apps**.
 *
 * `pinned` is a view fact, not a third kind: an item in that section keeps its
 * own `kind`, which is what lets the panel show six pins drawn from both
 * sections (FR-4 spec.md:192, FR-62 spec.md:298-302).
 */
export const APP_LAUNCHER_SECTIONS = ['pinned', 'platforms', 'works'] as const;

/** Union derived from {@link APP_LAUNCHER_SECTIONS}. */
export type AppLauncherSection = (typeof APP_LAUNCHER_SECTIONS)[number];

/**
 * The two chips a Work tile may carry (FR-18 spec.md:238-239, FR-58
 * spec.md:251-255): `deploying` while the latest production deployment has not
 * finished, `lastDeployFailed` when it ended in error, timed out or was rolled
 * back after a failed check. A finished deployment and one a person cancelled
 * show neither — a cancellation is a decision, not a failure.
 */
export const APP_LAUNCHER_WORK_CHIPS = ['deploying', 'lastDeployFailed'] as const;

/** Union derived from {@link APP_LAUNCHER_WORK_CHIPS}. */
export type AppLauncherWorkChip = (typeof APP_LAUNCHER_WORK_CHIPS)[number];

/**
 * Why an item is (not) in the panel, as **Manage apps** must render it
 * (`plan.md:251`, FR-27 spec.md:291-292): `listed` — live and exposed;
 * `notLive` — FR-56's **Not live — no address** (spec.md:245-247), kept in
 * **Manage apps** with the stored arrangement; `exposureOff` — the Work's FR-19
 * setting is off, explicitly or by its kind default (spec.md:259-261).
 */
export const APP_LAUNCHER_MANAGE_STATES = ['listed', 'notLive', 'exposureOff'] as const;

/** Union derived from {@link APP_LAUNCHER_MANAGE_STATES}. */
export type AppLauncherManageState = (typeof APP_LAUNCHER_MANAGE_STATES)[number];

/**
 * A platform entry's status (FR-9 spec.md:214, `plan.md:261`). An entry carrying
 * any other status is dropped by the catalog reader and logged with its entry id
 * only (FR-11 spec.md:219-221).
 */
export const APP_LAUNCHER_PLATFORM_STATUSES = ['available', 'beta'] as const;

/** Union derived from {@link APP_LAUNCHER_PLATFORM_STATUSES}. */
export type AppLauncherPlatformStatus = (typeof APP_LAUNCHER_PLATFORM_STATUSES)[number];

/**
 * The reasons one change was refused (`plan.md:299`, FR-35 spec.md:323-324).
 *
 * `unknownItem` is deliberately ONE reason for a key that does not exist and for
 * a key this person cannot reach (spec S18), so a save can never be used to probe
 * whether somebody else's Work exists. `cannotHideCurrent` is FR-13's **You're
 * here** entry, which cannot be hidden (spec.md:224-225).
 */
export const APP_LAUNCHER_REJECTION_REASONS = ['unknownItem', 'cannotHideCurrent'] as const;

/** Union derived from {@link APP_LAUNCHER_REJECTION_REASONS}. */
export type AppLauncherRejectionReason = (typeof APP_LAUNCHER_REJECTION_REASONS)[number];

/**
 * The two empty-state actions of FR-64 (spec.md:201-204). Which one renders is
 * decided by whether App Works are available to this person
 * (`meta.appWorksAvailable`), and the component reports both the action it
 * offered and the one the person chose.
 */
export const APP_LAUNCHER_EMPTY_ACTIONS = ['createAppWork', 'goToWorks'] as const;

/** Union derived from {@link APP_LAUNCHER_EMPTY_ACTIONS}. */
export type AppLauncherEmptyAction = (typeof APP_LAUNCHER_EMPTY_ACTIONS)[number];

// ---------------------------------------------------------------------------
// The tile and the registry responses (plan §3.3:253-324, §4.1–§4.3)
// ---------------------------------------------------------------------------

/**
 * One launcher tile — the shape `GET /api/me/apps` returns and the panel renders
 * (`plan.md:253-271`, FR-33 spec.md:317-320).
 *
 * Every derived fact travels WITH the tile, because none of it may be computed in
 * the browser: the address (FR-16 spec.md:232-235, FR-55 spec.md:240-244), the
 * **You're here** marker (FR-13), the chip (FR-58) and whether the item is listed
 * at all (FR-56). `url` is `null` exactly when `manageState !== 'listed'`; when it
 * is not `null` it is `https` and carries no path the launcher added (FR-16).
 */
export interface AppLauncherItem {
	/** `platform:<catalogId>` or `work:<uuid>` (`plan.md:254`, `plan.md:212`). */
	key: string;
	kind: AppLauncherItemKind;
	/** The section the tile renders under; `pinned` wins over the kind's section (FR-2). */
	section: AppLauncherSection;
	/** Display name, at most {@link APP_LAUNCHER_NAME_MAX_LENGTH} characters (FR-57 spec.md:248-250). */
	name: string;
	/** Platforms only, at most {@link APP_LAUNCHER_DESCRIPTION_MAX_LENGTH} characters (FR-9 spec.md:213-214). */
	description?: string;
	/** Inline `data:` icon, present only within {@link APP_LAUNCHER_ICON_MAX_BYTES} (NFR-5 spec.md:757-758). */
	iconDataUri?: string;
	/** `https`, or `null` exactly when `manageState !== 'listed'` (`plan.md:260`, FR-16). */
	url: string | null;
	/** The address's host, so a caller never re-parses `url` (`plan.md:261`). */
	host: string | null;
	/** FR-13's **You're here** marker; such a tile is not a link (spec.md:224-225). */
	current?: boolean;
	/** Platforms only (FR-9 spec.md:214). */
	status?: AppLauncherPlatformStatus;
	/** Works only: the Work's kind, so the tile can say what it is (`plan.md:264`). */
	workKind?: string;
	/** Works only: FR-18's chip, decided from the one latest production row (FR-58). */
	chip?: AppLauncherWorkChip;
	visible: boolean;
	pinned: boolean;
	/** Position in the merged pinned view, or `null` when not pinned (FR-26, FR-62). */
	pinOrder: number | null;
	/** The tile's order inside its section (FR-26 spec.md:289-290). */
	order: number;
	manageState: AppLauncherManageState;
}

/**
 * `GET /api/me/apps` — the merged, ordered list plus the facts a client must not
 * re-derive (`plan.md:273-286`, FR-33 spec.md:317-320, §4.1).
 *
 * `pinLimit` is typed from {@link APP_LAUNCHER_PIN_LIMIT} rather than restating
 * `6`, so the number the panel renders and the number the save path enforces
 * (FR-25) cannot drift; the literal type is identical (`6`).
 */
export interface AppLauncherListResponse {
	items: AppLauncherItem[];
	meta: {
		/** The environment these addresses belong to (FR-10 spec.md:216-218). */
		environment: AppLauncherEnvironment;
		/** The catalog version read, or `null` when no catalog is available (`plan.md:277`, S9/S10). */
		catalogVersion: string | null;
		/** False when the catalog could not be read and the current platform alone is shown (`plan.md:368-372`). */
		catalogAvailable: boolean;
		/** `global`, `personal`, or the active Organization id (`plan.md:211`, §3.2). */
		scopeKey: string;
		/** How many Works this scope holds, so **View all {count}** is exact (FR-4 spec.md:193, ACC-11-14 spec.md:580). */
		worksTotal: number;
		/**
		 * How many items are **eligible** in this scope — counted before `limit`
		 * truncates the answer and before the FR-63 filter narrows it, so it is
		 * the number the **Showing 200 of {count}** line means (FR-63
		 * spec.md:303-305, ACC-11-47 spec.md:665).
		 *
		 * Deliberately **not** `items.length`: a response with more than
		 * {@link APP_LAUNCHER_MAX_ITEMS_RESPONSE} eligible items carries the first
		 * 200 of them (FR-34 spec.md:321-322), so a client that counted the rows
		 * it holds would render **Showing 200 of 200** for a person with 250 — it
		 * could not say how many items it is not showing, which is exactly what
		 * the counted line exists to say. A filter never moves it either: the
		 * count is a fact about the scope, not about one query.
		 *
		 * `worksTotal` stays what it was — Works only, for FR-4's **View all
		 * {count}** — because the two counts answer different questions and the
		 * panel renders one while **Manage apps** renders the other.
		 */
		total: number;
		/** True when the response hit its cap — the answer is short, never silently complete (FR-34, FR-63). */
		truncated: boolean;
		/** Always {@link APP_LAUNCHER_PIN_LIMIT}; the same literal type, one source (FR-25 spec.md:287-288). */
		pinLimit: typeof APP_LAUNCHER_PIN_LIMIT;
		/** spec S8/FR-64 — App Works are available to this person (APW-01's fail-closed `works-app` gate, R-6). */
		appWorksAvailable: boolean;
	};
}

/**
 * One change inside a `PUT /api/me/apps/preferences` save (`plan.md:291-296`,
 * `plan.md:400-406`).
 *
 * A merge patch per item: an absent field keeps its stored value, which is what
 * makes a save idempotent per item (FR-29 spec.md:296). There is deliberately no
 * `pinOrder` field (`plan.md:429-430`): pinning appends after the last pin of the
 * merged view and `pinOrder` is recomputed inside the save's transaction, so a
 * client can never send a ranking the server has to trust.
 */
export interface AppLauncherPreferenceChange {
	/** `platform:<catalogId>` or `work:<uuid>` (`plan.md:254`, `plan.md:405`). */
	key: string;
	visible?: boolean;
	pinned?: boolean;
	/** 0..9999 (`plan.md:295`, `plan.md:405`; the ceiling is §3.2's `sortOrder`). */
	order?: number;
}

/** One refused change, with the single identical reason FR-35 requires (`plan.md:301-304`). */
export interface AppLauncherRejection {
	key: string;
	reason: AppLauncherRejectionReason;
}

/**
 * `PUT /api/me/apps/preferences` — what was saved, what was refused, and the
 * refreshed list so **Manage apps** re-renders without a second call
 * (`plan.md:306-311`, `plan.md:437-438`).
 */
export interface AppLauncherSavePreferencesResponse {
	saved: number;
	rejected: AppLauncherRejection[];
	/** The `includeHidden=true` list (`plan.md:310`). */
	items: AppLauncherItem[];
}

/**
 * The 422 body when a save is refused as a whole on the pin limit (FR-25
 * spec.md:287-288, `plan.md:313-317`): nothing is saved and the panel keeps
 * exactly the arrangement it had (`plan.md:414-415`).
 */
export interface AppLauncherPinLimitErrorBody {
	code: 'pinLimit';
	limit: typeof APP_LAUNCHER_PIN_LIMIT;
}

/**
 * `GET /api/app-launcher/platforms` — the public catalog read of FR-37
 * (spec.md:326-327), `plan.md:319-324` and §4.3. No credentials, no preference
 * fields beyond their defaults, cacheable for an hour.
 */
export interface AppLauncherPlatformsResponse {
	catalogVersion: string | null;
	environment: AppLauncherEnvironment;
	platforms: AppLauncherItem[];
}

// ---------------------------------------------------------------------------
// Limits (plan §3.3:327-335) — every number is the spec's
// ---------------------------------------------------------------------------

/**
 * At most 6 items are pinned per person per Organization, counting Ever apps and
 * Works together, and a change that would exceed it is refused as a whole
 * (FR-4 spec.md:192, FR-25 spec.md:287-288). The limit is evaluated over the
 * merged view of FR-62 (spec.md:298-302), which is why the same number serves the
 * panel, **Manage apps** and the save path.
 */
export const APP_LAUNCHER_PIN_LIMIT = 6;

/**
 * One registry response never holds more than 200 items (FR-34 spec.md:321-322,
 * FR-63 spec.md:303-305, NFR-2 spec.md:749) — **Manage apps** pages with `limit`
 * and says **Showing 200 of {count}** rather than hiding anything.
 */
export const APP_LAUNCHER_MAX_ITEMS_RESPONSE = 200;

/** A single save carries at most 200 item changes (FR-28 spec.md:294, NFR-3 spec.md:751). */
export const APP_LAUNCHER_MAX_CHANGES_PER_SAVE = 200;

/**
 * Each person holds at most 500 stored preference rows (FR-28 spec.md:294-295,
 * NFR-3 spec.md:751-752). Rows for Works that no longer exist or are no longer
 * accessible are ignored on read (spec.md:295) and are pruned first.
 */
export const APP_LAUNCHER_MAX_PREFERENCE_ROWS = 500;

/** The panel shows at most 12 **Ever apps** tiles (FR-4 spec.md:192). */
export const APP_LAUNCHER_PANEL_PLATFORMS_MAX = 12;

/**
 * The panel shows at most 24 **Your apps** tiles; the overflow renders
 * **View all {count}**, where `count` is `meta.worksTotal` — 140 exposed live
 * Works render 24 tiles and **View all 140** (FR-4 spec.md:192-193, ACC-11-14
 * spec.md:580).
 */
export const APP_LAUNCHER_PANEL_WORKS_MAX = 24;

/**
 * At most 24 catalog entries are read; entries past the cap, entries failing
 * validation and entries with an unknown status are dropped and the drop is
 * logged with the entry id only (FR-11 spec.md:219-221, NFR-5 spec.md:757).
 */
export const APP_LAUNCHER_CATALOG_MAX_ENTRIES = 24;

/**
 * An icon is inlined only up to **16 KB** — 16 384 bytes (NFR-5 spec.md:757-758).
 * A larger icon is not inlined; it is never truncated into an unrenderable one.
 */
export const APP_LAUNCHER_ICON_MAX_BYTES = 16_384;

/**
 * How long a fetched list may be rendered before it is refetched: data cached
 * from an open in the last 5 minutes renders immediately, and past that the panel
 * refetches on open (FR-5 spec.md:194-195, FR-6 spec.md:197-198). Written as the
 * spec's arithmetic; the value is 300 000 ms (`plan.md:335`).
 */
export const APP_LAUNCHER_CLIENT_CACHE_MS = 5 * 60_000;

/**
 * A listed item's name is capped at 100 characters and is never cut in the middle
 * of the community-build suffix (FR-57 spec.md:248-250, `plan.md:257`).
 *
 * Declared here although plan §3.3's constant block does not list it, because the
 * cap is stated twice — by the tile's own field comment (`plan.md:257`) and by the
 * API truncation rule (`plan.md:394`) — and a number two callers must agree on
 * belongs in one place. Additive: nothing above or below depends on it.
 */
export const APP_LAUNCHER_NAME_MAX_LENGTH = 100;

/**
 * A catalog entry's one-line description is at most 80 characters (FR-9
 * spec.md:213-214, `plan.md:258`); an entry whose description is longer fails
 * validation and is dropped (FR-11).
 *
 * Declared here for the same reason as {@link APP_LAUNCHER_NAME_MAX_LENGTH}: the
 * catalog reader and the tile's field comment state the same cap.
 */
export const APP_LAUNCHER_DESCRIPTION_MAX_LENGTH = 80;

/**
 * The longest **Manage apps** filter a read accepts — `?q=` on
 * `GET /api/me/apps` (FR-63 spec.md:303-305).
 *
 * A filter is a **substring of an item's name**, and a name is at most
 * {@link APP_LAUNCHER_NAME_MAX_LENGTH} characters (FR-57 spec.md:248-250), so a
 * longer needle cannot match anything: the cap is the name cap itself rather
 * than a number of its own. The route's DTO refuses one character past it with
 * `400` (plan §4.5) instead of reading the whole eligible set to answer nothing.
 *
 * Declared here, beside the other limits, because the DTO that refuses it and
 * the client that sends it must agree on one number.
 */
export const APP_LAUNCHER_FILTER_MAX_LENGTH = APP_LAUNCHER_NAME_MAX_LENGTH;

// ---------------------------------------------------------------------------
// Pure predicates
// ---------------------------------------------------------------------------

/**
 * Whether a value is one of FR-9's three environments (spec.md:214-215) — the
 * check `?environment=` passes before it reaches the catalog reader
 * (`plan.md:444`).
 *
 * Fails closed: anything that is not a member is `false`, never a coerced string.
 * FR-10 (spec.md:216-218) is the reason — an unrecognised value must not be able
 * to select a different environment's addresses, and it must not fall back to
 * "show everything" either. The caller applies its own default.
 */
export function isAppLauncherEnvironment(value: unknown): value is AppLauncherEnvironment {
	return typeof value === 'string' && (APP_LAUNCHER_ENVIRONMENTS as readonly string[]).includes(value);
}

/**
 * Whether a save that would leave `pinnedCount` items pinned is over FR-25's
 * limit (spec.md:287-288) and must therefore be refused **as a whole** with
 * {@link AppLauncherPinLimitErrorBody}.
 *
 * Exactly 6 passes and 7 is refused: `appLauncherPinLimitExceeded(6) === false`,
 * `appLauncherPinLimitExceeded(7) === true` (FR-4 spec.md:192).
 *
 * Fails closed on a count that is not a non-negative integer — `NaN`, a negative
 * or a fractional count is reported as exceeding the limit, because
 * "we could not count it" must never read as "there is room" (`plan.md:414-415`,
 * FR-62 spec.md:298-302).
 */
export function appLauncherPinLimitExceeded(pinnedCount: number): boolean {
	if (!Number.isInteger(pinnedCount) || pinnedCount < 0) {
		return true;
	}
	return pinnedCount > APP_LAUNCHER_PIN_LIMIT;
}
