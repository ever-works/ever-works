/**
 * Fleet — desktop view & control (FL-07, CONTRACTS §1.1, §1.2, §3.3, R-8, R-25).
 *
 * The **Desktop** source of the screen channel: the machine's whole desktop on
 * one display, captured by an optional native screen helper the machine's
 * owner admits on the machine itself. The existing **browser** source (an
 * Agent's own browser window, AW-11) is untouched — its reasons, job kind and
 * socket leg stay exactly as they are (FR-12); the eight desktop reasons live
 * in their own union here instead of widening `COMPUTER_UNWATCHABLE_REASONS`.
 *
 * Watching rides FL-02's node link: the platform opens a `desktop` channel with
 * `{ source: 'desktop', viewId, display?, quality? }`; the node answers with
 * `desktop.started`, then `FRAME` (20) keyframes in the existing computer-frame
 * encoding, `TILES` (23) changed regions ({@link FLEET_DESKTOP_TILE_SIZE}-pixel
 * tiles, `fleet-desktop-tiles.codec.ts`) and a `desktop.stats` JSON once a
 * second. A browser attaches through FL-02's viewer gateway
 * (`/ws/fleet/desktop/<viewId>`).
 *
 * Nothing in this module carries a picture, a tile or typed text.
 */

import { COMPUTER_MAX_DIMENSION, COMPUTER_QUALITIES, type ComputerQuality } from '../computer/computer-frame.types.js';

// ─── Sources and capability tags (CONTRACTS §1.2) ───────────────────────────

/** What fills the screen channel: an Agent's own browser (AW-11) or the machine's whole desktop (FL-07). */
export const FLEET_SCREEN_SOURCES = ['browser', 'desktop'] as const;

export type FleetScreenSource = (typeof FLEET_SCREEN_SOURCES)[number];

export function isFleetScreenSource(value: unknown): value is FleetScreenSource {
	return value === 'browser' || value === 'desktop';
}

/** OS-level desktop capture is available: an admitted helper, `--attend`, and no desktop reason. */
export const FLEET_SCREEN_DESKTOP_CAPABILITY = 'screen:desktop';

/** A native screen helper is admitted on this machine (`hash-pinned` or `signed`). */
export const FLEET_HELPER_SCREEN_CAPABILITY = 'helper:screen';

/** Alias of the existing `screen` tag (browser-profile capture); both are advertised. */
export const FLEET_SCREEN_BROWSER_CAPABILITY = 'screen:browser';

// ─── Helper trust (R-8) ─────────────────────────────────────────────────────

/**
 * How far the platform may trust the machine's screen helper: `none` (no helper
 * admitted, or it failed verification), `hash-pinned` (the owner acknowledged
 * its SHA-256 fingerprint — labelled **Reduced trust**), `signed` (a code
 * signature from a known identity, P3).
 */
export const FLEET_HELPER_TRUST_LEVELS = ['none', 'hash-pinned', 'signed'] as const;

export type FleetHelperTrust = (typeof FLEET_HELPER_TRUST_LEVELS)[number];

export function isFleetHelperTrust(value: unknown): value is FleetHelperTrust {
	return typeof value === 'string' && (FLEET_HELPER_TRUST_LEVELS as readonly string[]).includes(value);
}

/** A reported trust level, or `none` for anything this build does not know (fail-closed). */
export function normalizeFleetHelperTrust(value: unknown): FleetHelperTrust {
	return isFleetHelperTrust(value) ? value : 'none';
}

/** The `varchar` the stored column is (`fleet_nodes.helperTrust`). */
export const FLEET_HELPER_TRUST_MAX_LENGTH = 16;

// ─── Why a machine cannot show its desktop (FR-3, FR-4) ─────────────────────

/**
 * The eight desktop reasons (FR-4), in the order an owner should fix them: a
 * machine with no helper AND on Wayland says "install the helper" first only
 * when that is the thing that unblocks it — `kind-unsupported` and the Wayland
 * session cannot be fixed by installing anything, so they come first.
 *
 * The node reports the ones it knows in every heartbeat (`desktopReasons`);
 * `kind-unsupported` is the platform's own (a `desktop-node` computer has no
 * `--attend` wiring yet, R-10). `permission-accessibility` blocks control only,
 * never watching.
 */
export const FLEET_DESKTOP_REASONS = [
	'kind-unsupported',
	'wayland-unsupported',
	'helper-missing',
	'helper-unadmitted',
	'helper-untrusted',
	'no-display-session',
	'permission-screen-recording',
	'permission-accessibility'
] as const;

export type FleetDesktopReason = (typeof FLEET_DESKTOP_REASONS)[number];

export function isFleetDesktopReason(value: unknown): value is FleetDesktopReason {
	return typeof value === 'string' && (FLEET_DESKTOP_REASONS as readonly string[]).includes(value);
}

/** Reasons that take away watching (every reason except the control-only one). */
export const FLEET_DESKTOP_WATCH_REASONS: readonly FleetDesktopReason[] = FLEET_DESKTOP_REASONS.filter(
	(reason) => reason !== 'permission-accessibility'
);

/** Reasons a report may carry at most (the eight, each once). */
export const FLEET_DESKTOP_MAX_REASONS = FLEET_DESKTOP_REASONS.length;

/** A reported reason list: known reasons only, each once, in precedence order. Never throws. */
export function normalizeFleetDesktopReasons(value: unknown): FleetDesktopReason[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<FleetDesktopReason>();
	for (const entry of value.slice(0, 64)) {
		if (isFleetDesktopReason(entry)) seen.add(entry);
	}
	return FLEET_DESKTOP_REASONS.filter((reason) => seen.has(reason));
}

/**
 * What fixes each reason, where something does: the exact command to run on the
 * machine, or the settings path to follow there (spec §5.4). The node's binary
 * is `ever-works-node`.
 */
export const FLEET_DESKTOP_REASON_FIXES: Readonly<
	Record<FleetDesktopReason, { readonly command?: string; readonly settingsPath?: string }>
> = Object.freeze({
	'kind-unsupported': Object.freeze({}),
	'wayland-unsupported': Object.freeze({}),
	'helper-missing': Object.freeze({ command: 'ever-works-node helper install' }),
	'helper-unadmitted': Object.freeze({ command: 'ever-works-node helper admit' }),
	'helper-untrusted': Object.freeze({ command: 'ever-works-node helper status' }),
	'no-display-session': Object.freeze({}),
	'permission-screen-recording': Object.freeze({
		settingsPath: 'System Settings → Privacy & Security → Screen Recording'
	}),
	'permission-accessibility': Object.freeze({ settingsPath: 'System Settings → Privacy & Security → Accessibility' })
});

/**
 * The one-line hint an API refusal and an Agent tool carry for a reason — the
 * same sentence the Desktop tab shows (FR-35). English: i18n keys mirror it in
 * the web (`fleet.desktop.unavailable.*`).
 */
export function fleetDesktopReasonHint(reason: FleetDesktopReason, nodeName: string): string {
	const name = nodeName.trim() || 'this computer';
	switch (reason) {
		case 'kind-unsupported':
			return 'Not available on this kind of computer yet';
		case 'wayland-unsupported':
			return 'Desktop view needs an X11 session; Wayland is not supported yet';
		case 'helper-missing':
			return `The screen helper is not installed on ${name}. Run this on ${name}: ever-works-node helper install`;
		case 'helper-unadmitted':
			return `The screen helper is waiting for your approval on ${name}. Run this on ${name}: ever-works-node helper admit`;
		case 'helper-untrusted':
			return `The screen helper on ${name} has changed since you approved it. Nothing starts until you approve it again: ever-works-node helper status`;
		case 'no-display-session':
			return `Nobody is signed in on ${name}; sign in there to show its desktop`;
		case 'permission-screen-recording':
			return `${name} has not allowed screen recording. On ${name}: System Settings → Privacy & Security → Screen Recording → allow ever-works-screen`;
		case 'permission-accessibility':
			return `${name} has not allowed control. On ${name}: System Settings → Privacy & Security → Accessibility → allow ever-works-screen`;
	}
}

// ─── What stops a desktop view, platform side (availability) ────────────────

/**
 * Everything that can stand between a person and a computer's desktop, in the
 * order it is checked: the fleet-wide stop first, then the computer's kind,
 * reachability, consent, the viewer's audience, the machine's own reasons, and
 * last the node link. The first one found is the one the Desktop tab shows.
 */
export const FLEET_DESKTOP_BLOCKERS = [
	'kill-switch',
	'kind-unsupported',
	'offline',
	'consent-missing',
	'permission-denied',
	'wayland-unsupported',
	'helper-missing',
	'helper-unadmitted',
	'helper-untrusted',
	'no-display-session',
	'permission-screen-recording',
	'link-unavailable'
] as const;

export type FleetDesktopBlocker = (typeof FLEET_DESKTOP_BLOCKERS)[number];

export function isFleetDesktopBlocker(value: unknown): value is FleetDesktopBlocker {
	return typeof value === 'string' && (FLEET_DESKTOP_BLOCKERS as readonly string[]).includes(value);
}

/** The CONTRACTS §8 error code a blocker refuses an open with. */
export const FLEET_DESKTOP_BLOCKER_CODES: Readonly<
	Record<
		FleetDesktopBlocker,
		'kill_switch' | 'unsupported_on_node' | 'unreachable' | 'consent_missing' | 'permission_denied'
	>
> = Object.freeze({
	'kill-switch': 'kill_switch',
	'kind-unsupported': 'unsupported_on_node',
	offline: 'unreachable',
	'consent-missing': 'consent_missing',
	'permission-denied': 'permission_denied',
	'wayland-unsupported': 'unsupported_on_node',
	'helper-missing': 'unsupported_on_node',
	'helper-unadmitted': 'unsupported_on_node',
	'helper-untrusted': 'unsupported_on_node',
	'no-display-session': 'unsupported_on_node',
	'permission-screen-recording': 'unsupported_on_node',
	'link-unavailable': 'unreachable'
});

/** The facts {@link resolveFleetDesktopBlocker} reads — all already known to the platform. */
export interface FleetDesktopAvailabilityFacts {
	/** The fleet kill switch is on (or unreadable — read fail-closed). */
	killSwitch: boolean;
	/** `fleet_nodes.kind`. A `desktop-node` has no `--attend` wiring yet (R-10). */
	kind: string;
	/** The computer heartbeated within the offline threshold. */
	online: boolean;
	/** The computer runs with `--attend`. */
	attend: boolean;
	/** The viewer is in the computer's `desktop` audience (R-25). */
	inDesktopAudience: boolean;
	/** What the machine reported in its last heartbeat. */
	reasons: readonly FleetDesktopReason[];
	/** The machine reported an admitted helper (`helperTrust !== 'none'`). */
	helperTrust: FleetHelperTrust;
	/** The node link is up on some API replica. */
	linkConnected: boolean;
}

/**
 * The first thing that stops a desktop view, or null when one may open. Pure.
 * A machine that reported no reason but no admitted helper either is read as
 * `helper-missing` (an older node that predates the report, fail-closed).
 */
export function resolveFleetDesktopBlocker(facts: FleetDesktopAvailabilityFacts): FleetDesktopBlocker | null {
	if (facts.killSwitch) return 'kill-switch';
	if (facts.kind !== 'node') return 'kind-unsupported';
	if (!facts.online) return 'offline';
	if (!facts.attend) return 'consent-missing';
	if (!facts.inDesktopAudience) return 'permission-denied';
	const reasons = normalizeFleetDesktopReasons(facts.reasons);
	for (const blocker of FLEET_DESKTOP_BLOCKERS) {
		if ((reasons as readonly string[]).includes(blocker)) return blocker;
	}
	if (facts.helperTrust === 'none') return 'helper-missing';
	if (!facts.linkConnected) return 'link-unavailable';
	return null;
}

// ─── Displays (FR-9, FR-10) ─────────────────────────────────────────────────

/** One display of the machine as the helper enumerates it. */
export interface FleetDisplayView {
	/** The helper's stable id for the display (≤ {@link FLEET_DISPLAY_ID_MAX_LENGTH}). */
	id: string;
	/** What the OS calls it (`Built-in Retina`, `DP-1`, …). */
	name: string;
	/** Pixel size of the display in display pixels. */
	width: number;
	height: number;
	/** Scale factor (2 on a Retina display). */
	scale: number;
	primary: boolean;
	/** A virtual display the owner added (P3, Linux X11). */
	virtual: boolean;
}

export const FLEET_DISPLAY_ID_MAX_LENGTH = 64;
export const FLEET_DISPLAY_NAME_MAX_LENGTH = 64;
export const FLEET_DESKTOP_MAX_DISPLAYS = 16;
/** A display reports a scale between these (fractional scales included). */
export const FLEET_DISPLAY_MIN_SCALE = 0.5;
export const FLEET_DISPLAY_MAX_SCALE = 8;

const DISPLAY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

export function isFleetDisplayId(value: unknown): value is string {
	return typeof value === 'string' && DISPLAY_ID_PATTERN.test(value);
}

function boundedInt(value: unknown, min: number, max: number): number | null {
	return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

/** One reported display, re-validated; null when it cannot be used. Never throws. */
export function normalizeFleetDisplay(value: unknown): FleetDisplayView | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	if (!isFleetDisplayId(raw.id)) return null;
	const width = boundedInt(raw.width, 1, 65_535);
	const height = boundedInt(raw.height, 1, 65_535);
	if (width === null || height === null) return null;
	const scale =
		typeof raw.scale === 'number' &&
		Number.isFinite(raw.scale) &&
		raw.scale >= FLEET_DISPLAY_MIN_SCALE &&
		raw.scale <= FLEET_DISPLAY_MAX_SCALE
			? Math.round(raw.scale * 100) / 100
			: 1;
	const name =
		typeof raw.name === 'string' && raw.name.trim()
			? raw.name
					.replace(/[\u0000-\u001f\u007f]/g, '')
					.trim()
					.slice(0, FLEET_DISPLAY_NAME_MAX_LENGTH)
			: raw.id;
	return { id: raw.id, name, width, height, scale, primary: raw.primary === true, virtual: raw.virtual === true };
}

/**
 * A reported display list: usable entries only, each id once, at most
 * {@link FLEET_DESKTOP_MAX_DISPLAYS}, the primary first then the machine's
 * order; exactly one primary (the first entry when none or several claim it).
 */
export function normalizeFleetDisplays(value: unknown): FleetDisplayView[] {
	if (!Array.isArray(value)) return [];
	const out: FleetDisplayView[] = [];
	const ids = new Set<string>();
	for (const entry of value.slice(0, FLEET_DESKTOP_MAX_DISPLAYS * 4)) {
		const display = normalizeFleetDisplay(entry);
		if (!display || ids.has(display.id)) continue;
		ids.add(display.id);
		out.push(display);
		if (out.length >= FLEET_DESKTOP_MAX_DISPLAYS) break;
	}
	if (out.length === 0) return out;
	const primaryIndex = out.findIndex((display) => display.primary);
	const primary = primaryIndex >= 0 ? primaryIndex : 0;
	const ordered = [out[primary], ...out.filter((_, index) => index !== primary)];
	return ordered.map((display, index) => ({ ...display, primary: index === 0 }));
}

/**
 * The display a view shows: the one asked for when it is still there, else the
 * primary — and whether that was a fall-back the strip must say (FR-10, U14).
 */
export function pickFleetDisplay(
	displays: readonly FleetDisplayView[],
	wanted: string | null | undefined
): { display: FleetDisplayView | null; fellBack: boolean } {
	if (displays.length === 0) return { display: null, fellBack: false };
	if (wanted) {
		const match = displays.find((display) => display.id === wanted);
		if (match) return { display: match, fellBack: false };
		return { display: displays.find((display) => display.primary) ?? displays[0], fellBack: true };
	}
	return { display: displays.find((display) => display.primary) ?? displays[0], fellBack: false };
}

// ─── The desktop facts a computer carries (heartbeat, CONTRACTS §1.1) ───────

/** What a computer's last heartbeat said about its desktop, as stored and shown. */
export interface FleetNodeDesktopView {
	/** The helper's state (`null` from a node that never reported one). */
	helper: FleetHelperStatusView | null;
	displays: FleetDisplayView[];
	reasons: FleetDesktopReason[];
	/** Platform receipt time of the report (never the machine's clock). */
	reportedAt: string | null;
}

/** The helper as a heartbeat reports it (`helper { trust, version?, verifiedAt? }` plus what the tab names). */
export interface FleetHelperStatusView {
	trust: FleetHelperTrust;
	/** The helper file is on the machine. */
	present: boolean;
	/** A trust record exists for it (it may still fail verification). */
	admitted: boolean;
	/** Helper version (from its `hello`), when known. */
	version: string | null;
	/** First {@link FLEET_HELPER_FINGERPRINT_PREFIX_LENGTH} hex digits of the admitted fingerprint. */
	fingerprintPrefix: string | null;
	/** When the node last verified the file against the record (the machine's report). */
	verifiedAt: string | null;
	/** The admitted fingerprint is one the node package publishes (false: the owner admitted an unpublished build). */
	published: boolean | null;
}

/** The fingerprint prefix shown and audited — never a full hash under a key a redactor eats. */
export const FLEET_HELPER_FINGERPRINT_PREFIX_LENGTH = 8;
export const FLEET_HELPER_VERSION_MAX_LENGTH = 32;

const HEX_PREFIX = /^[0-9a-f]{8}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

function boundedVersion(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return /^[A-Za-z0-9.+_-]{1,32}$/.test(trimmed) ? trimmed : null;
}

/** A reported helper block, re-validated; null when unusable. Never throws. */
export function normalizeFleetHelperStatus(value: unknown): FleetHelperStatusView | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	const prefix = typeof raw.fingerprintPrefix === 'string' ? raw.fingerprintPrefix.toLowerCase() : null;
	return {
		trust: normalizeFleetHelperTrust(raw.trust),
		present: raw.present === true,
		admitted: raw.admitted === true,
		version: boundedVersion(raw.version),
		fingerprintPrefix: prefix && HEX_PREFIX.test(prefix) ? prefix : null,
		verifiedAt: typeof raw.verifiedAt === 'string' && ISO_INSTANT.test(raw.verifiedAt) ? raw.verifiedAt : null,
		published: typeof raw.published === 'boolean' ? raw.published : null
	};
}

// ─── Views (CONTRACTS §11.2 `/api/fleet/nodes/:id/desktop/*`) ───────────────

/** `GET …/desktop/availability`. */
export interface FleetDesktopAvailabilityView {
	nodeId: string;
	nodeName: string;
	/** True when a desktop view may open now. */
	available: boolean;
	/** The first thing in the way, or null. */
	blocker: FleetDesktopBlocker | null;
	/** The exact hint (same sentence as the tool and the API refusal), or null. */
	hint: string | null;
	/** Every desktop reason the machine reported (the tab may name more than the first). */
	reasons: FleetDesktopReason[];
	helper: FleetHelperStatusView | null;
	displays: FleetDisplayView[];
	/** Last heartbeat (ISO), for the offline variant. */
	lastSeenAt: string | null;
	/** The Agent's browser can still be watched on this computer (`screen` tag + `--attend`). */
	browserSourceAvailable: boolean;
	/** Live desktop views on this computer and the per-computer cap. */
	liveViews: number;
	maxViews: number;
}

/** `POST …/desktop/views` body (FR-1). `source` defaults to `desktop`. */
export interface FleetDesktopOpenRequest {
	source?: 'desktop';
	displayId?: string;
	quality?: ComputerQuality;
	/** The FL-04 session the view sits beside (the split, P2). */
	fleetSessionId?: string;
}

/** `PATCH …/desktop/views/:viewId` body: another display or quality (re-attach with the new grant). */
export interface FleetDesktopUpdateRequest {
	displayId?: string;
	quality?: ComputerQuality;
}

/** A desktop view as the API answers it. Never carries picture bytes. */
export interface FleetDesktopViewView {
	viewId: string;
	nodeId: string;
	source: 'desktop';
	displayId: string | null;
	quality: ComputerQuality;
	/** `viewer` while watching (P1); `driver` only to the control holder (P2). */
	role: 'viewer' | 'driver';
	openedByUserId: string;
	openedAt: string;
	fleetSessionId: string | null;
}

/** The single-use, 60-second viewer grant for `/ws/fleet/desktop/<viewId>` (FL-02's minter). */
export interface FleetDesktopAttachGrant {
	token: string;
	wsPath: string;
	expiresInSec: number;
	role: 'viewer' | 'driver';
}

/** `POST …/desktop/views` and `PATCH …/views/:viewId` answer. */
export interface FleetDesktopOpenResult {
	view: FleetDesktopViewView;
	attach: FleetDesktopAttachGrant;
	/** The display the view will show, or null when the machine reported none yet. */
	display: FleetDisplayView | null;
	/** The remembered display is gone; the primary is shown instead (U14). */
	fellBack: boolean;
}

/** Body of `POST …/desktop/views/:viewId/attach-token` (a reconnect of the same view). */
export interface FleetDesktopAttachRequest {
	role?: 'viewer' | 'driver';
}

export function isFleetDesktopQuality(value: unknown): value is ComputerQuality {
	return typeof value === 'string' && (COMPUTER_QUALITIES as readonly string[]).includes(value);
}

const VIEW_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A desktop view id (a UUID the platform minted). */
export function isFleetDesktopViewId(value: unknown): value is string {
	return typeof value === 'string' && VIEW_ID_PATTERN.test(value);
}

// ─── Limits (AW-11 values, README D13, CONTRACTS §10) ───────────────────────

/**
 * Live views per computer and per Organization — AW-11's numbers, counted
 * across BOTH sources (FR-33). The API reads the configured values through the
 * computer-session limits; these are the defaults the node also enforces on its
 * own desktop channels.
 */
export const FLEET_DESKTOP_VIEWS_PER_NODE = 2;
export const FLEET_DESKTOP_VIEWS_PER_ORGANIZATION = 5;
/** A view ends after this long, watched or not (AW-11 4-hour ceiling). */
export const FLEET_DESKTOP_VIEW_CEILING_MS = 4 * 60 * 60_000;
/** View opens per person per minute (plan §5 `POST /views` tier). */
export const FLEET_DESKTOP_OPEN_RATE_LIMIT = 10;

/** Side of one changed-region tile, in picture pixels (FR-6). */
export const FLEET_DESKTOP_TILE_SIZE = 64;
/** Largest single publish (a keyframe, or one `TILES` frame) — AW-11's 512 KiB (FR-6). */
export const FLEET_DESKTOP_MAX_PUBLISH_BYTES = 512 * 1024;
/** Display changes are reported within this long (FR-9, U14). */
export const FLEET_DESKTOP_DISPLAY_CHANGE_MS = 3_000;
/** The helper releases every key and button it pressed within this long (FR-39, P2). */
export const FLEET_DESKTOP_RELEASE_ALL_MS = 1_000;

// ─── The `desktop` channel's messages (CONTRACTS §3.3, the FL-07 additions) ──

/**
 * JSON message types on a desktop channel. `quality`, `refresh`, `displays`,
 * `setDisplay`, `openUrl` and `mode` are platform → node; `started`, `stats`
 * and `displayChanged` node → platform. A watcher may send only the three FL-02
 * lists for the family (`FLEET_LINK_VIEWER_JSON_TYPES.desktop`).
 */
export const FLEET_DESKTOP_MESSAGES = {
	started: 'desktop.started',
	stats: 'desktop.stats',
	quality: 'desktop.quality',
	refresh: 'desktop.refresh',
	displays: 'desktop.displays',
	setDisplay: 'desktop.setDisplay',
	displayChanged: 'desktop.displayChanged',
	mode: 'desktop.mode',
	openUrl: 'desktop.openUrl'
} as const;

/** Node → platform, once, right after `channel.ready`: what the view shows. */
export interface FleetDesktopStartedMessage {
	type: 'desktop.started';
	display: FleetDisplayView | null;
	displays: FleetDisplayView[];
	/** The display asked for is gone; the primary is shown (U14). */
	fellBack: boolean;
	quality: ComputerQuality;
}

/** Node → platform, once a second: numbers only (never a picture). */
export interface FleetDesktopStatsMessage {
	type: 'desktop.stats';
	quality: ComputerQuality;
	effectiveQuality: ComputerQuality;
	fps: number;
	backlog: number;
	bytesOut: number;
	tilesPerSec: number;
}

/** Node → platform within {@link FLEET_DESKTOP_DISPLAY_CHANGE_MS} of a hot-plug. */
export interface FleetDesktopDisplayChangedMessage {
	type: 'desktop.displayChanged';
	displays: FleetDisplayView[];
	/** Set when the captured display went away and the view fell back to this one. */
	fallback?: FleetDisplayView;
}

/** Channel-open params the platform sends for the Desktop source (CONTRACTS §3.3). */
export interface FleetDesktopSourceParams {
	source: 'desktop';
	viewId: string;
	display?: string | null;
	quality?: ComputerQuality;
}

/** Read a `desktop` channel's open params for the Desktop source; null when they are not. */
export function readFleetDesktopSourceParams(params: Record<string, unknown>): FleetDesktopSourceParams | null {
	if (params.source !== 'desktop' || !isFleetDesktopViewId(params.viewId)) return null;
	const out: FleetDesktopSourceParams = { source: 'desktop', viewId: params.viewId };
	if (isFleetDisplayId(params.display)) out.display = params.display;
	if (isFleetDesktopQuality(params.quality)) out.quality = params.quality;
	return out;
}

/** The live view's watermark: `EVER WORKS · LIVE VIEW · DESKTOP · design-mac` (FR-1). */
export function fleetDesktopWatermark(computerName: string): string {
	return `EVER WORKS · LIVE VIEW · DESKTOP · ${computerName}`;
}

/** Pictures larger than the platform ever asks for are refused (both sides of the codec). */
export const FLEET_DESKTOP_MAX_DIMENSION = COMPUTER_MAX_DIMENSION;
