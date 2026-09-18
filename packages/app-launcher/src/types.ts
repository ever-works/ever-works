/**
 * The App Launcher element's public vocabulary.
 *
 * Owning epic: **APW-11** (T11/T12), plan §6.1–§6.3.
 *
 * **The registry shapes are not declared here.** `AppLauncherItem`,
 * `AppLauncherListResponse` and the section/chip/kind/status/empty-action unions
 * already exist in `@ever-works/contracts` (`src/apps/app-launcher.ts`, the
 * landed T1 contract) and this package re-exports them rather than declaring a
 * second copy — the failure one copy prevents is the panel and **Manage apps**
 * disagreeing about what a person pinned (CONTRACTS R-26).
 *
 * > **Deviation from plan §6.1, deliberate.** The plan's file table says
 * > `src/types.ts` "mirrors `AppLauncherItem` without importing
 * > `@ever-works/contracts`, so P2 extraction has no monorepo dependency". The
 * > build instruction for this task is the opposite — "do not duplicate them;
 * > import from `@ever-works/contracts`" — and this file follows that. The
 * > imports below are **type-only** and are erased by the compiler, so
 * > `dist/index.js` still has no runtime dependency on anything (which is what
 * > `scripts/check-size.mjs` proves); the P2 extraction (T28) would have to
 * > rewrite these re-exports, and that is recorded in the task report rather
 * > than hidden.
 *
 * What is declared here is only what the contracts do not own: the element's
 * own string table, its error vocabulary and the four event details of plan
 * §6.2.
 */

// ---------------------------------------------------------------------------
// Re-exported registry vocabulary (contracts `src/apps/app-launcher.ts`)
// ---------------------------------------------------------------------------

import type {
	AppLauncherEmptyAction,
	AppLauncherEnvironment,
	AppLauncherItem,
	AppLauncherItemKind,
	AppLauncherListResponse,
	AppLauncherSection,
	AppLauncherWorkChip
} from '@ever-works/contracts';

export type {
	AppLauncherEmptyAction,
	AppLauncherEnvironment,
	AppLauncherItem,
	AppLauncherItemKind,
	AppLauncherListResponse,
	AppLauncherSection,
	AppLauncherWorkChip
};

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
