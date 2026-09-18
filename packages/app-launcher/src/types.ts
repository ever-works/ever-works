/**
 * The App Launcher element's public vocabulary.
 *
 * Owning epic: **APW-11** (T11/T12), plan §6.1–§6.3.
 *
 * **Everything the element consumes is declared HERE, structurally.** The
 * registry shapes also exist in `@ever-works/contracts`
 * (`src/apps/app-launcher.ts`, the landed T1 contract) and the host passes those
 * values straight in, which works because the two are structurally identical —
 * and plan §6.1 is explicit about why that duplication is deliberate: this
 * package must be extractable on its own for P2 (T28), so its source may not
 * depend on the monorepo. `dist/index.d.ts` referencing `@ever-works/contracts`
 * would make an extracted package's types unresolvable.
 *
 * The cost of a mirror is drift, so drift is what §6.1's own conformance is for:
 * `src/__tests__/types.conformance.spec.ts` imports BOTH declarations and
 * asserts each is assignable to the other in both directions, for the unions
 * **and** the two object shapes. A field added to the contract alone, or
 * renamed here alone, fails that spec rather than failing a host's build.
 *
 * What is declared here, then: the registry vocabulary the element reads, plus
 * what the contracts do not own at all — the element's string table, its error
 * vocabulary and the event details of plan §6.2.
 */

// ---------------------------------------------------------------------------
// The registry vocabulary, mirrored from `@ever-works/contracts`
// (apps/app-launcher.ts) — see the conformance spec before changing anything.
// ---------------------------------------------------------------------------

/** `production` | `stage` | `develop` (contracts `APP_LAUNCHER_ENVIRONMENTS`). */
export type AppLauncherEnvironment = 'production' | 'stage' | 'develop';

/** A platform from the Ever apps catalog, or one of the person's own Works. */
export type AppLauncherItemKind = 'platform' | 'work';

/** The three sections an item renders under (FR-2). */
export type AppLauncherSection = 'pinned' | 'platforms' | 'works';

/** The two chips a Work tile may carry (FR-18). */
export type AppLauncherWorkChip = 'deploying' | 'lastDeployFailed';

/** Why an item is (not) in the panel, as **Manage apps** renders it (FR-27). */
export type AppLauncherManageState = 'listed' | 'notLive' | 'exposureOff';

/** A platform entry's status (FR-9). */
export type AppLauncherPlatformStatus = 'available' | 'beta';

/** S8's two buttons (FR-64). */
export type AppLauncherEmptyAction = 'createAppWork' | 'goToWorks';

/**
 * One launcher tile (contracts `AppLauncherItem`, plan §3.3).
 *
 * Every derived fact travels with the tile because none of it may be computed in
 * the browser: the address (FR-16), the **You're here** marker (FR-13), the chip
 * (FR-58) and whether the item is listed at all (FR-56). `url` is `null` exactly
 * when `manageState !== 'listed'`; when it is not `null` it is `https`.
 */
export interface AppLauncherItem {
	/** `platform:<catalogId>` or `work:<uuid>`. */
	key: string;
	kind: AppLauncherItemKind;
	/** The section the tile renders under; `pinned` wins over the kind's section (FR-2). */
	section: AppLauncherSection;
	/** Display name. */
	name: string;
	/** Platforms only. */
	description?: string;
	/** Inline `data:` icon, present only within the icon byte cap (NFR-5). */
	iconDataUri?: string;
	/** `https`, or `null` exactly when `manageState !== 'listed'` (FR-16). */
	url: string | null;
	/** The address's host, so a caller never re-parses `url`. */
	host: string | null;
	/** FR-13's **You're here** marker; such a tile is not a link. */
	current?: boolean;
	/** Platforms only (FR-9). */
	status?: AppLauncherPlatformStatus;
	/** Works only: the Work's kind, so the tile can say what it is. */
	workKind?: string;
	/** Works only: FR-18's chip, decided from the one latest production row (FR-58). */
	chip?: AppLauncherWorkChip;
	visible: boolean;
	pinned: boolean;
	/** Position in the merged pinned view, or `null` when not pinned (FR-26). */
	pinOrder: number | null;
	/** The tile's order inside its section (FR-26). */
	order: number;
	manageState: AppLauncherManageState;
}

/**
 * `GET /api/me/apps` — the merged, ordered list plus the facts a client must not
 * re-derive (contracts `AppLauncherListResponse`, plan §4.1).
 *
 * `pinLimit` is the literal `6` here as it is in the contracts
 * (`APP_LAUNCHER_PIN_LIMIT`), so the number the panel renders and the number the
 * save path enforces cannot drift; the conformance spec pins the literal.
 *
 * `total` is the one field a host may need before the element does: it is FR-63's
 * `{count}`, mirrored here so a host that renders its own **Showing 200 of
 * {count}** line reads the same number the element would.
 */
export interface AppLauncherListResponse {
	items: AppLauncherItem[];
	meta: {
		/** The environment these addresses belong to (FR-10). */
		environment: AppLauncherEnvironment;
		/** The catalog version read, or `null` when no catalog is available (S9/S10). */
		catalogVersion: string | null;
		/** False when the catalog could not be read and the current platform alone is shown. */
		catalogAvailable: boolean;
		/** `global`, `personal`, or the active Organization id. */
		scopeKey: string;
		/** How many Works this scope holds, so **View all {count}** is exact (FR-4). */
		worksTotal: number;
		/**
		 * How many items are **eligible** in this scope, counted before the
		 * response cap and before FR-63's filter — the number the **Showing 200
		 * of {count}** line means, and deliberately not `items.length`, which on
		 * a capped response is the one number that line must not be.
		 */
		total: number;
		/** True when the response hit its cap — the answer is short, never silently complete (FR-34). */
		truncated: boolean;
		/** Always `6`; the same literal the contracts declare (FR-25). */
		pinLimit: 6;
		/** spec S8/FR-64 — App Works are available to this person (APW-01's fail-closed gate, R-6). */
		appWorksAvailable: boolean;
	};
}

// ---------------------------------------------------------------------------
// Element-local vocabulary (plan §6.2)
// ---------------------------------------------------------------------------

/**
 * The `theme` attribute's three values (plan §6.2): a host-local choice, or
 * `auto`, which follows `prefers-color-scheme`.
 */
export type LauncherTheme = 'light' | 'dark' | 'auto';

/**
 * Which half of the panel failed (`loading`/`error` in plan §6.2): the platform
 * catalog read or the person's apps read. The two render differently — spec
 * §6.2 keeps **Ever apps** on screen when **Your apps** failed.
 */
export type LauncherErrorSection = 'catalog' | 'apps';

/**
 * The `section` a `:retry` reports: `catalog` is the Ever apps read, `works` is
 * the Your apps read. Spelled with the element's own words (`works`, not
 * `apps`) so a host listener reads the same word it passed to `error`.
 */
export type LauncherRetrySection = 'catalog' | 'works';

/**
 * Every user-visible string the element renders (FR-42: none is assembled from
 * fragments — each is one whole string a translator can replace).
 *
 * The key names are plan §8's `dashboard.appLauncher.*` leaves, so T14's
 * `useTranslations('dashboard.appLauncher')` object maps onto this type without
 * a second vocabulary. A host passes a `Partial` and the rest stay English.
 */
export interface LauncherStrings {
	/** Accessible name of the control (FR-1). */
	controlLabel: string;
	/** Control tooltip (FR-1). */
	controlTooltip: string;
	/** Panel title; also the menu's accessible name (plan §6.3). */
	panelTitle: string;
	/** Heading of the pinned row (FR-2). */
	sectionPinned: string;
	/** Heading of the **Ever apps** section (FR-2). */
	sectionPlatforms: string;
	/** Heading of the **Your apps** section (FR-2). */
	sectionWorks: string;
	/** Chip on the platform the launcher is running inside (FR-13). */
	chipCurrent: string;
	/** Chip on a `beta` catalog entry (FR-9). */
	chipBeta: string;
	/** Chip while the latest production deployment is unfinished (FR-18). */
	chipDeploying: string;
	/** Chip when the latest production deployment failed (FR-18). */
	chipLastDeployFailed: string;
	/** Overflow line of **Your apps** (FR-4). `{count}` is `meta.worksTotal`. */
	viewAll: string;
	/** Footer helper (spec §6.1). */
	footerHelper: string;
	/** Footer link label (FR-2). */
	manageLink: string;
	/** S8's empty-state line (spec §6.2). */
	emptyWorks: string;
	/** S8's button with App Works available (FR-64). */
	emptyWorksCreateApp: string;
	/** S8's button without App Works (FR-64). */
	emptyWorksGoToWorks: string;
	/** S9's message (spec §6.2). */
	catalogError: string;
	/** **Your apps**' failure message (spec §6.2). */
	worksError: string;
	/** The retry control of both error states (spec §6.2). */
	retry: string;
	/** P2's signed-out prompt (spec §6.5). */
	signInPrompt: string;
	/** P2's sign-in button (spec §6.5). */
	signIn: string;
	/** P2's footer link label (spec §6.5). */
	manageInEverWorks: string;
}

/**
 * `ever-app-launcher:item-activate` — plan §6.2's `{ key, kind, url, position,
 * pinned }`. Cancelable: a host that calls `preventDefault()` gets no tab
 * (ACC-11-40). `url` is the stored address, never a decorated one (FR-31).
 */
export interface LauncherItemActivateDetail {
	/** `platform:<catalogId>` or `work:<uuid>` (contracts). */
	key: string;
	kind: AppLauncherItemKind;
	/** The exact address the element would open (FR-31). */
	url: string;
	/** The tile's 0-based position in the panel's flat tile order. */
	position: number;
	/** Whether the tile is pinned (FR-4). */
	pinned: boolean;
}

/**
 * `ever-app-launcher:retry` — plan §6.2's `{ section? }`. The host refetches the
 * half that failed and sets `loading`/`error` again.
 */
export interface LauncherRetryDetail {
	section?: LauncherRetrySection;
}

/** `ever-app-launcher:manage` — plan §6.2's `{ section? }`. The host navigates. */
export interface LauncherManageDetail {
	section?: AppLauncherSection;
}

/** `ever-app-launcher:sign-in` — plan §6.2's `{ section? }` (P2). */
export interface LauncherSignInDetail {
	section?: AppLauncherSection;
}

/**
 * `ever-app-launcher:empty-action` — plan §6.2. The element reports the offered
 * action; the **host** navigates (FR-64), which is why this event is not
 * cancelable and why no navigation happens here.
 */
export interface LauncherEmptyActionDetail {
	action: AppLauncherEmptyAction;
}
