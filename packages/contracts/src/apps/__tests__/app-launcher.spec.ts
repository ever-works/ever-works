import { describe, expect, it } from 'vitest';

import * as appsBarrel from '../index.js';
import * as packageRoot from '../../index.js';

import {
	APP_LAUNCHER_CATALOG_MAX_ENTRIES,
	APP_LAUNCHER_CLIENT_CACHE_MS,
	APP_LAUNCHER_DESCRIPTION_MAX_LENGTH,
	APP_LAUNCHER_EMPTY_ACTIONS,
	APP_LAUNCHER_ENVIRONMENTS,
	APP_LAUNCHER_FILTER_MAX_LENGTH,
	APP_LAUNCHER_ICON_MAX_BYTES,
	APP_LAUNCHER_ITEM_KINDS,
	APP_LAUNCHER_MANAGE_STATES,
	APP_LAUNCHER_MAX_CHANGES_PER_SAVE,
	APP_LAUNCHER_MAX_ITEMS_RESPONSE,
	APP_LAUNCHER_MAX_PREFERENCE_ROWS,
	APP_LAUNCHER_NAME_MAX_LENGTH,
	APP_LAUNCHER_PANEL_PLATFORMS_MAX,
	APP_LAUNCHER_PANEL_WORKS_MAX,
	APP_LAUNCHER_PIN_LIMIT,
	APP_LAUNCHER_PLATFORM_STATUSES,
	APP_LAUNCHER_REJECTION_REASONS,
	APP_LAUNCHER_SECTIONS,
	APP_LAUNCHER_WORK_CHIPS,
	appLauncherPinLimitExceeded,
	isAppLauncherEnvironment,
	type AppLauncherEmptyAction,
	type AppLauncherEnvironment,
	type AppLauncherItem,
	type AppLauncherItemKind,
	type AppLauncherListResponse,
	type AppLauncherManageState,
	type AppLauncherPinLimitErrorBody,
	type AppLauncherPlatformStatus,
	type AppLauncherPlatformsResponse,
	type AppLauncherPreferenceChange,
	type AppLauncherRejectionReason,
	type AppLauncherSavePreferencesResponse,
	type AppLauncherSection,
	type AppLauncherWorkChip
} from '../app-launcher.js';

/**
 * Behavioural contract for APW-11's shared launcher module
 * (`app-launcher.ts`, plan §3.3 = plan.md:239-336).
 *
 * The pins are what this file is for: every closed union is checked member for
 * member against the line that fixes it, every number against its spec line (the
 * line is in the test NAME, so a failure names its own source), every predicate at
 * the limit **and** the limit + 1, and the relationships between the limits. A
 * suite that could not fail would be no evidence at all — see the perturbation
 * note in the epic's task report.
 */

/** Compile-time equality, so a widened or narrowed union fails to type-check. */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Forces `Equal<…>` to be `true` at compile time. */
type Expect<T extends true> = T;

/**
 * The closed unions restated from the PLAN/SPEC — never from the module — so the
 * pins below compare the module to its source rather than to itself.
 */
type SpecAppLauncherEnvironment = 'production' | 'stage' | 'develop'; // plan.md:245, FR-9 spec.md:214-215
type SpecAppLauncherItemKind = 'platform' | 'work'; // plan.md:248
type SpecAppLauncherSection = 'pinned' | 'platforms' | 'works'; // plan.md:249, FR-2 spec.md:188-189
type SpecAppLauncherWorkChip = 'deploying' | 'lastDeployFailed'; // plan.md:250, FR-18 spec.md:238-239
type SpecAppLauncherManageState = 'listed' | 'notLive' | 'exposureOff'; // plan.md:251
type SpecAppLauncherPlatformStatus = 'available' | 'beta'; // plan.md:263, FR-9 spec.md:214
type SpecAppLauncherRejectionReason = 'unknownItem' | 'cannotHideCurrent'; // plan.md:299, FR-35 spec.md:323-324
type SpecAppLauncherEmptyAction = 'createAppWork' | 'goToWorks'; // plan.md:289, FR-64 spec.md:201-204

type _Environment = Expect<Equal<AppLauncherEnvironment, SpecAppLauncherEnvironment>>;
type _ItemKind = Expect<Equal<AppLauncherItemKind, SpecAppLauncherItemKind>>;
type _Section = Expect<Equal<AppLauncherSection, SpecAppLauncherSection>>;
type _WorkChip = Expect<Equal<AppLauncherWorkChip, SpecAppLauncherWorkChip>>;
type _ManageState = Expect<Equal<AppLauncherManageState, SpecAppLauncherManageState>>;
type _PlatformStatus = Expect<Equal<AppLauncherPlatformStatus, SpecAppLauncherPlatformStatus>>;
type _RejectionReason = Expect<Equal<AppLauncherRejectionReason, SpecAppLauncherRejectionReason>>;
type _EmptyAction = Expect<Equal<AppLauncherEmptyAction, SpecAppLauncherEmptyAction>>;

/** `meta.pinLimit` carries the literal 6, not a general number (plan.md:282). */
type _PinLimitLiteral = Expect<Equal<AppLauncherListResponse['meta']['pinLimit'], 6>>;

/**
 * `meta.total` is a plain count (FR-63 spec.md:303-305): the number of eligible
 * items **before** the filter and before the cap, so it cannot be pinned to a
 * literal and cannot be `items.length` either.
 */
type _TotalIsANumber = Expect<Equal<AppLauncherListResponse['meta']['total'], number>>;

/**
 * Every closed union this module exports, with the members its spec line fixes,
 * in that order. `expected` is written out rather than derived from `actual`, so
 * the array cannot pin itself.
 */
const UNIONS: Array<[name: string, actual: readonly string[], expected: readonly string[]]> = [
	['APP_LAUNCHER_ENVIRONMENTS', APP_LAUNCHER_ENVIRONMENTS, ['production', 'stage', 'develop']], // FR-9 spec.md:214-215
	['APP_LAUNCHER_ITEM_KINDS', APP_LAUNCHER_ITEM_KINDS, ['platform', 'work']], // plan.md:248
	['APP_LAUNCHER_SECTIONS', APP_LAUNCHER_SECTIONS, ['pinned', 'platforms', 'works']], // FR-2 spec.md:188-189
	['APP_LAUNCHER_WORK_CHIPS', APP_LAUNCHER_WORK_CHIPS, ['deploying', 'lastDeployFailed']], // FR-18 spec.md:238-239
	['APP_LAUNCHER_MANAGE_STATES', APP_LAUNCHER_MANAGE_STATES, ['listed', 'notLive', 'exposureOff']], // plan.md:251
	['APP_LAUNCHER_PLATFORM_STATUSES', APP_LAUNCHER_PLATFORM_STATUSES, ['available', 'beta']], // FR-9 spec.md:214
	['APP_LAUNCHER_REJECTION_REASONS', APP_LAUNCHER_REJECTION_REASONS, ['unknownItem', 'cannotHideCurrent']],
	['APP_LAUNCHER_EMPTY_ACTIONS', APP_LAUNCHER_EMPTY_ACTIONS, ['createAppWork', 'goToWorks']] // FR-64 spec.md:201-204
];

/**
 * One key per member of every union, keyed by the TYPE.
 *
 * This is the "accepts exactly those members" half of the pin, and it fails from
 * both sides: a member added to a union without a key here is a compile error in
 * `pnpm --filter @ever-works/contracts type-check:tests`, while a key here that the
 * array does not list fails at run time in the test below.
 */
const EVERY_ENVIRONMENT: Record<AppLauncherEnvironment, true> = { production: true, stage: true, develop: true };
const EVERY_ITEM_KIND: Record<AppLauncherItemKind, true> = { platform: true, work: true };
const EVERY_SECTION: Record<AppLauncherSection, true> = { pinned: true, platforms: true, works: true };
const EVERY_WORK_CHIP: Record<AppLauncherWorkChip, true> = { deploying: true, lastDeployFailed: true };
const EVERY_MANAGE_STATE: Record<AppLauncherManageState, true> = { listed: true, notLive: true, exposureOff: true };
const EVERY_PLATFORM_STATUS: Record<AppLauncherPlatformStatus, true> = { available: true, beta: true };
const EVERY_REJECTION_REASON: Record<AppLauncherRejectionReason, true> = {
	unknownItem: true,
	cannotHideCurrent: true
};
const EVERY_EMPTY_ACTION: Record<AppLauncherEmptyAction, true> = { createAppWork: true, goToWorks: true };

const DERIVED_UNIONS: Array<[name: string, actual: readonly string[], accepted: Record<string, true>]> = [
	['AppLauncherEnvironment', APP_LAUNCHER_ENVIRONMENTS, EVERY_ENVIRONMENT],
	['AppLauncherItemKind', APP_LAUNCHER_ITEM_KINDS, EVERY_ITEM_KIND],
	['AppLauncherSection', APP_LAUNCHER_SECTIONS, EVERY_SECTION],
	['AppLauncherWorkChip', APP_LAUNCHER_WORK_CHIPS, EVERY_WORK_CHIP],
	['AppLauncherManageState', APP_LAUNCHER_MANAGE_STATES, EVERY_MANAGE_STATE],
	['AppLauncherPlatformStatus', APP_LAUNCHER_PLATFORM_STATUSES, EVERY_PLATFORM_STATUS],
	['AppLauncherRejectionReason', APP_LAUNCHER_REJECTION_REASONS, EVERY_REJECTION_REASON],
	['AppLauncherEmptyAction', APP_LAUNCHER_EMPTY_ACTIONS, EVERY_EMPTY_ACTION]
];

/** Asserts a guard admits every member of its own union (one fixture each). */
function everyMemberIsAccepted<T extends string>(members: readonly T[], guard: (value: unknown) => value is T): void {
	for (const member of members) {
		expect(guard(member), member).toBe(true);
	}
}

/**
 * One tile with every optional field plan §3.3 gives a PLATFORM item
 * (plan.md:253-271): `description`, `iconDataUri`, `current` and `status`.
 */
const PLATFORM_ITEM: AppLauncherItem = {
	key: 'platform:ever-gauzy',
	kind: 'platform',
	section: 'platforms',
	name: 'Ever Gauzy',
	description: 'Business management platform',
	iconDataUri: 'data:image/svg+xml;base64,PHN2Zy8+',
	url: 'https://gauzy.example.com',
	host: 'gauzy.example.com',
	current: true,
	status: 'available',
	visible: true,
	pinned: true,
	pinOrder: 0,
	order: 1,
	manageState: 'listed'
};

/**
 * One tile with only the REQUIRED fields — the proof that everything else is
 * optional (plan.md:260-270), and the shape FR-56 gives a not-live Work.
 */
const NOT_LIVE_WORK_ITEM: AppLauncherItem = {
	key: 'work:2f1c9f0e-3d5a-4a3f-8f4b-1c2d3e4f5a6b',
	kind: 'work',
	section: 'works',
	name: 'Landing page',
	url: null,
	host: null,
	visible: false,
	pinned: false,
	pinOrder: null,
	order: 0,
	manageState: 'notLive'
};

/** The `GET /api/me/apps` envelope (plan.md:273-286). */
const LIST_RESPONSE: AppLauncherListResponse = {
	items: [PLATFORM_ITEM, NOT_LIVE_WORK_ITEM],
	meta: {
		environment: 'production',
		catalogVersion: '2026-09-17',
		catalogAvailable: true,
		scopeKey: 'global',
		worksTotal: 140,
		// The eligible count FR-63 renders — 140, while this envelope carries 2
		// items, because it is counted before the cap (FR-34).
		total: 140,
		truncated: false,
		pinLimit: APP_LAUNCHER_PIN_LIMIT,
		appWorksAvailable: true
	}
};

/** The `PUT /api/me/apps/preferences` answer (plan.md:306-311). */
const SAVE_RESPONSE: AppLauncherSavePreferencesResponse = {
	saved: 2,
	rejected: [{ key: 'work:not-mine', reason: 'unknownItem' }],
	items: [PLATFORM_ITEM, NOT_LIVE_WORK_ITEM]
};

/** The 422 body of FR-25 (plan.md:313-317). */
const PIN_LIMIT_BODY: AppLauncherPinLimitErrorBody = { code: 'pinLimit', limit: APP_LAUNCHER_PIN_LIMIT };

/** The public catalog read of FR-37 (plan.md:319-324). */
const PLATFORMS_RESPONSE: AppLauncherPlatformsResponse = {
	catalogVersion: '2026-09-17',
	environment: 'develop',
	platforms: [PLATFORM_ITEM]
};

describe('app-launcher — the closed unions (plan §3.3:245-299)', () => {
	it.each(UNIONS)('%s lists each of its members exactly once, in spec order', (_name, actual, expected) => {
		expect([...actual]).toEqual([...expected]);
		expect(new Set(actual).size, 'no member may appear twice').toBe(actual.length);
		expect(new Set(expected).size, 'the pin list itself must not repeat a member').toBe(expected.length);
	});

	it.each(DERIVED_UNIONS)('%s accepts exactly the members its array lists', (_name, actual, accepted) => {
		expect(Object.keys(accepted).sort()).toEqual([...actual].sort());
		expect(Object.keys(accepted), 'one key per member and no more').toHaveLength(actual.length);
	});
});

describe('app-launcher — the derived unions reject what they do not list', () => {
	it('is enforced by the type checker, not only at run time', () => {
		// Each line below is a COMPILE error that `@ts-expect-error` asserts must
		// exist: if a union ever grew one of these members, `pnpm type-check:tests`
		// would fail on an unused directive instead of the pin going quiet.
		// @ts-expect-error FR-9's three environments, and 'prod' is not one (spec.md:214-215)
		const environment: AppLauncherEnvironment = 'prod';
		// @ts-expect-error an item kind is 'platform' | 'work' (plan.md:248)
		const kind: AppLauncherItemKind = 'ever-app';
		// @ts-expect-error the sections are 'pinned' | 'platforms' | 'works' (plan.md:249)
		const section: AppLauncherSection = 'apps';
		// @ts-expect-error a chip is 'deploying' | 'lastDeployFailed' (FR-18 spec.md:238-239)
		const chip: AppLauncherWorkChip = 'failed';
		// @ts-expect-error FR-56's state is `notLive`, not 'hidden' (spec.md:245-247)
		const manageState: AppLauncherManageState = 'hidden';
		// @ts-expect-error a catalog status is 'available' | 'beta' (FR-9 spec.md:214)
		const status: AppLauncherPlatformStatus = 'preview';
		// @ts-expect-error one identical reason covers unknown and inaccessible (FR-35 spec.md:323-324)
		const reason: AppLauncherRejectionReason = 'inaccessible';
		// @ts-expect-error FR-64's two actions are 'createAppWork' and 'goToWorks' (spec.md:201-204)
		const action: AppLauncherEmptyAction = 'createWork';

		expect([environment, kind, section, chip, manageState, status, reason, action]).toHaveLength(8);
	});
});

describe('app-launcher — the numeric limits (plan §3.3:327-335)', () => {
	it('APP_LAUNCHER_PIN_LIMIT is 6 (FR-4 spec.md:192, FR-25 spec.md:287-288, plan.md:327)', () => {
		expect(APP_LAUNCHER_PIN_LIMIT).toBe(6);
	});

	it('APP_LAUNCHER_MAX_ITEMS_RESPONSE is 200 (FR-34 spec.md:321-322, NFR-2 spec.md:749, plan.md:328)', () => {
		expect(APP_LAUNCHER_MAX_ITEMS_RESPONSE).toBe(200);
	});

	it('APP_LAUNCHER_MAX_CHANGES_PER_SAVE is 200 (FR-28 spec.md:294, NFR-3 spec.md:751, plan.md:329)', () => {
		expect(APP_LAUNCHER_MAX_CHANGES_PER_SAVE).toBe(200);
	});

	it('APP_LAUNCHER_MAX_PREFERENCE_ROWS is 500 (FR-28 spec.md:294-295, NFR-3 spec.md:751-752, plan.md:330)', () => {
		expect(APP_LAUNCHER_MAX_PREFERENCE_ROWS).toBe(500);
	});

	it('APP_LAUNCHER_PANEL_PLATFORMS_MAX is 12 (FR-4 spec.md:192, plan.md:331)', () => {
		expect(APP_LAUNCHER_PANEL_PLATFORMS_MAX).toBe(12);
	});

	it('APP_LAUNCHER_PANEL_WORKS_MAX is 24 (FR-4 spec.md:192-193, ACC-11-14 spec.md:580, plan.md:332)', () => {
		expect(APP_LAUNCHER_PANEL_WORKS_MAX).toBe(24);
	});

	it('APP_LAUNCHER_CATALOG_MAX_ENTRIES is 24 (FR-11 spec.md:219-221, NFR-5 spec.md:757, plan.md:333)', () => {
		expect(APP_LAUNCHER_CATALOG_MAX_ENTRIES).toBe(24);
	});

	it('APP_LAUNCHER_ICON_MAX_BYTES is 16_384 = the 16 KB of NFR-5 (spec.md:757-758, plan.md:334)', () => {
		expect(APP_LAUNCHER_ICON_MAX_BYTES).toBe(16_384);
		expect(APP_LAUNCHER_ICON_MAX_BYTES).toBe(16 * 1024);
	});

	it('APP_LAUNCHER_CLIENT_CACHE_MS is 300_000 = the 5 minutes of FR-5/FR-6 (spec.md:194-198, plan.md:335)', () => {
		expect(APP_LAUNCHER_CLIENT_CACHE_MS).toBe(300_000);
		expect(APP_LAUNCHER_CLIENT_CACHE_MS).toBe(5 * 60_000);
	});

	it('APP_LAUNCHER_NAME_MAX_LENGTH is 100 (FR-57 spec.md:248-250, plan.md:257)', () => {
		expect(APP_LAUNCHER_NAME_MAX_LENGTH).toBe(100);
	});

	it('APP_LAUNCHER_DESCRIPTION_MAX_LENGTH is 80 (FR-9 spec.md:213-214, plan.md:258)', () => {
		expect(APP_LAUNCHER_DESCRIPTION_MAX_LENGTH).toBe(80);
	});
});

describe('app-launcher — the limits keep their relationships (plan §3.3:327-335)', () => {
	it('every panel cap fits inside one registry response (FR-4 spec.md:192 vs FR-34 spec.md:321-322)', () => {
		expect(APP_LAUNCHER_PANEL_PLATFORMS_MAX).toBeLessThanOrEqual(APP_LAUNCHER_MAX_ITEMS_RESPONSE);
		expect(APP_LAUNCHER_PANEL_WORKS_MAX).toBeLessThanOrEqual(APP_LAUNCHER_MAX_ITEMS_RESPONSE);
		expect(APP_LAUNCHER_PIN_LIMIT).toBeLessThanOrEqual(APP_LAUNCHER_MAX_ITEMS_RESPONSE);
	});

	it('the panel never shows more Ever apps tiles than the catalog may hold (FR-4 spec.md:192 vs FR-11 spec.md:219-220)', () => {
		// The catalog cap bounds what can exist; a panel cap above it would be dead
		// code, and the two numbers drift the day one of them is raised alone.
		expect(APP_LAUNCHER_PANEL_PLATFORMS_MAX).toBeLessThanOrEqual(APP_LAUNCHER_CATALOG_MAX_ENTRIES);
	});

	it('one save can never carry more changes than the rows a person may hold (FR-28 spec.md:294-295)', () => {
		expect(APP_LAUNCHER_MAX_CHANGES_PER_SAVE).toBeLessThanOrEqual(APP_LAUNCHER_MAX_PREFERENCE_ROWS);
	});

	it('the client cache is the whole number of minutes FR-5 and FR-6 both state (spec.md:194-198)', () => {
		expect(APP_LAUNCHER_CLIENT_CACHE_MS % 60_000, 'a whole number of minutes').toBe(0);
		expect(APP_LAUNCHER_CLIENT_CACHE_MS / 60_000).toBe(5);
	});
});

describe('isAppLauncherEnvironment — fail closed (FR-9 spec.md:214-215, FR-10 spec.md:216-218)', () => {
	it('accepts every member of the union', () => {
		everyMemberIsAccepted(APP_LAUNCHER_ENVIRONMENTS, isAppLauncherEnvironment);
	});

	it('rejects a near-miss string rather than coercing it', () => {
		for (const rejected of ['prod', 'production ', ' staging', 'staging', 'development', 'PRODUCTION', '']) {
			expect(isAppLauncherEnvironment(rejected), rejected).toBe(false);
		}
	});

	it('rejects a non-string without throwing', () => {
		for (const rejected of [null, undefined, 6, true, {}, ['production']]) {
			expect(isAppLauncherEnvironment(rejected), String(rejected)).toBe(false);
		}
	});
});

describe('appLauncherPinLimitExceeded — FR-25 refuses the whole save (spec.md:287-288)', () => {
	it('passes at the limit and refuses the limit + 1 (FR-4 spec.md:192)', () => {
		expect(appLauncherPinLimitExceeded(APP_LAUNCHER_PIN_LIMIT)).toBe(false);
		expect(appLauncherPinLimitExceeded(APP_LAUNCHER_PIN_LIMIT + 1)).toBe(true);
	});

	it('passes below the limit — an empty and a one-pin arrangement included', () => {
		for (const count of [0, 1, APP_LAUNCHER_PIN_LIMIT - 1]) {
			expect(appLauncherPinLimitExceeded(count), String(count)).toBe(false);
		}
	});

	it('fails closed on a count that is not a non-negative integer (plan.md:414-415)', () => {
		for (const broken of [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			-1,
			1.5,
			Number.MAX_SAFE_INTEGER + 1
		]) {
			expect(appLauncherPinLimitExceeded(broken), String(broken)).toBe(true);
		}
	});
});

describe('app-launcher — the tile and response shapes (plan §3.3:253-324)', () => {
	it('accepts a full platform tile and a required-fields-only not-live tile', () => {
		expect(PLATFORM_ITEM.status).toBe('available');
		expect(PLATFORM_ITEM.current).toBe(true);
		expect(PLATFORM_ITEM.iconDataUri?.startsWith('data:image/svg+xml;base64,')).toBe(true);
		expect(NOT_LIVE_WORK_ITEM.manageState).toBe('notLive');
		expect(NOT_LIVE_WORK_ITEM.url, 'a not-live item has no address (FR-56)').toBeNull();
		expect(NOT_LIVE_WORK_ITEM.host).toBeNull();
		expect(NOT_LIVE_WORK_ITEM.pinOrder).toBeNull();
	});

	it('carries the literal 6 as meta.pinLimit, never a loosened number', () => {
		expect(LIST_RESPONSE.meta.pinLimit).toBe(APP_LAUNCHER_PIN_LIMIT);
		expect(PIN_LIMIT_BODY).toEqual({ code: 'pinLimit', limit: 6 });
		expect(SAVE_RESPONSE.rejected[0].reason).toBe('unknownItem');
		expect(PLATFORMS_RESPONSE.environment).toBe('develop');
	});

	it('is pinned by the type checker as well as at run time', () => {
		// @ts-expect-error `url` is required and must be `string | null` (plan.md:260)
		const missingUrl: AppLauncherItem = { ...(NOT_LIVE_WORK_ITEM as Omit<AppLauncherItem, 'url'>) };
		// @ts-expect-error a tile has no field outside plan §3.3's list (plan.md:253-271)
		const extraField: AppLauncherItem = { ...NOT_LIVE_WORK_ITEM, notAField: true };
		// @ts-expect-error a preference change carries no `pinOrder` (plan.md:429-430)
		const withPinOrder: AppLauncherPreferenceChange = { key: 'work:x', pinOrder: 1 };
		// @ts-expect-error `meta.pinLimit` is the literal 6, not any number (plan.md:282)
		const loosenedLimit: AppLauncherListResponse['meta']['pinLimit'] = 7;
		// @ts-expect-error the only code in that body is 'pinLimit' (plan.md:313-317)
		const wrongCode: AppLauncherPinLimitErrorBody = { code: 'itemsLimit', limit: 6 };
		// @ts-expect-error a change's `order` is a number, not a string (plan.md:405)
		const stringOrder: AppLauncherPreferenceChange = { key: 'work:x', order: '1' };

		expect([missingUrl, extraField, withPinOrder, loosenedLimit, wrongCode, stringOrder]).toHaveLength(6);
	});

	it('keeps every preference-change field but the key optional (plan.md:291-296)', () => {
		const minimal: AppLauncherPreferenceChange = { key: 'platform:ever-gauzy' };
		const full: AppLauncherPreferenceChange = { key: 'work:x', visible: false, pinned: true, order: 9_999 };

		expect(Object.keys(minimal)).toEqual(['key']);
		expect(full.order).toBe(9_999);
	});
});

describe('app-launcher — the eligible count and the filter cap (FR-63 spec.md:303-305)', () => {
	it('carries meta.total as the eligible count, not the length of the answer', () => {
		expect(LIST_RESPONSE.meta.total).toBe(140);
		// The envelope holds 2 items: a response that reported `items.length` would
		// tell the person "Showing 200 of 200", which is the one thing FR-63 forbids.
		expect(LIST_RESPONSE.meta.total).not.toBe(LIST_RESPONSE.items.length);
	});

	it('caps the Manage apps filter at the name cap, so no needle is longer than a name', () => {
		// A filter is a substring of an item's name (FR-57), so a needle past the
		// name cap could never match anything: the DTO answers 400 instead. The cap
		// is the name cap itself rather than a number of its own.
		expect(APP_LAUNCHER_FILTER_MAX_LENGTH).toBe(APP_LAUNCHER_NAME_MAX_LENGTH);
		expect(Number.isInteger(APP_LAUNCHER_FILTER_MAX_LENGTH)).toBe(true);
	});
});

describe('app-launcher — reachable from the package root (tasks.md:71-75, ACC-11-54 spec.md:682-683)', () => {
	/**
	 * Every RUNTIME name this module adds. The barrel's collision check
	 * (`src/__tests__/index.barrel.spec.ts`) can only see a launcher name once
	 * `apps` is one of its `AREAS` — which it now is — so this list is the module's
	 * own proof that the check covers it, and it fails if a name of this module
	 * ever goes ambiguous against another area.
	 */
	const RUNTIME_EXPORTS: readonly string[] = [
		'APP_LAUNCHER_ENVIRONMENTS',
		'APP_LAUNCHER_ITEM_KINDS',
		'APP_LAUNCHER_SECTIONS',
		'APP_LAUNCHER_WORK_CHIPS',
		'APP_LAUNCHER_MANAGE_STATES',
		'APP_LAUNCHER_PLATFORM_STATUSES',
		'APP_LAUNCHER_REJECTION_REASONS',
		'APP_LAUNCHER_EMPTY_ACTIONS',
		'APP_LAUNCHER_PIN_LIMIT',
		'APP_LAUNCHER_MAX_ITEMS_RESPONSE',
		'APP_LAUNCHER_MAX_CHANGES_PER_SAVE',
		'APP_LAUNCHER_MAX_PREFERENCE_ROWS',
		'APP_LAUNCHER_PANEL_PLATFORMS_MAX',
		'APP_LAUNCHER_PANEL_WORKS_MAX',
		'APP_LAUNCHER_CATALOG_MAX_ENTRIES',
		'APP_LAUNCHER_ICON_MAX_BYTES',
		'APP_LAUNCHER_CLIENT_CACHE_MS',
		'APP_LAUNCHER_NAME_MAX_LENGTH',
		'APP_LAUNCHER_DESCRIPTION_MAX_LENGTH',
		'isAppLauncherEnvironment',
		'appLauncherPinLimitExceeded'
	];

	it('surfaces every runtime name of this module on the apps barrel and at the root', () => {
		for (const name of RUNTIME_EXPORTS) {
			expect(name in appsBarrel, `${name} must be on the apps barrel`).toBe(true);
			expect(name in packageRoot, `${name} must be at the package root`).toBe(true);
		}
	});

	it('resolves the same bindings — not copies — from the package root', () => {
		// The T1 Done-when import: `import { AppLauncherItem } from '@ever-works/contracts'`
		// (tasks.md:72). Both hops are plain `export *`, so the RUNTIME values arrive
		// at the root and are the very arrays the module declares.
		expect(packageRoot.APP_LAUNCHER_PIN_LIMIT).toBe(APP_LAUNCHER_PIN_LIMIT);
		expect(packageRoot.APP_LAUNCHER_ENVIRONMENTS).toBe(APP_LAUNCHER_ENVIRONMENTS);
		expect(packageRoot.APP_LAUNCHER_MAX_ITEMS_RESPONSE).toBe(APP_LAUNCHER_MAX_ITEMS_RESPONSE);
		expect(packageRoot.isAppLauncherEnvironment).toBe(isAppLauncherEnvironment);
		expect(packageRoot.appLauncherPinLimitExceeded(APP_LAUNCHER_PIN_LIMIT + 1)).toBe(true);
	});

	it('resolves the launcher TYPES from the package root too, not only the values', () => {
		// `AppLauncherItem` is a type, so nothing above would notice it going
		// missing at the root; these annotations and pins would not compile if it had.
		const item: packageRoot.AppLauncherItem = LIST_RESPONSE.items[0];
		const response: packageRoot.AppLauncherListResponse = LIST_RESPONSE;
		const change: packageRoot.AppLauncherPreferenceChange = { key: item.key, pinned: true };
		const platforms: packageRoot.AppLauncherPlatformsResponse = PLATFORMS_RESPONSE;
		const rejection: packageRoot.AppLauncherRejectionReason = SAVE_RESPONSE.rejected[0].reason;
		const action: packageRoot.AppLauncherEmptyAction = 'goToWorks';

		expect(item).toBe(PLATFORM_ITEM);
		expect(response.meta.worksTotal).toBe(140);
		expect(change.pinned).toBe(true);
		expect(platforms.platforms).toHaveLength(1);
		expect(rejection).toBe('unknownItem');
		expect(action).toBe('goToWorks');
	});
});
