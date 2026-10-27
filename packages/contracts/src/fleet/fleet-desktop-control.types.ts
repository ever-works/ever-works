import { COMPUTER_BLOCKED_SHORTCUTS } from '../computer/computer-control.types.js';
import type { ComputerControlStateView } from '../computer/computer-control.types.js';
import type { FleetDesktopAttachGrant } from './fleet-desktop.types.js';

/**
 * Desktop view & control (FL-07 P2, spec §4.4, FR-36 … FR-42, CONTRACTS §2.1
 * R-25) — taking control of a computer's desktop: the mouse and keyboard of
 * the machine itself, through its admitted screen helper.
 *
 * Control is opt-in TWICE, both on the platform and on the machine:
 *
 *   1. The owner allows it ON THE MACHINE, by typing {@link FLEET_HELPER_CONTROL_WORD}
 *      at `ever-works-node helper control allow` (default: not allowed). The
 *      permission is bound to ONE admission of the helper
 *      ({@link FleetHelperControlRecord.admissionAt}): approving a changed helper
 *      again turns control off until it is allowed again. `helper control deny`
 *      (or `helper revoke`) ends a live control within a second.
 *   2. A person in the computer's `desktop` audience (R-25 — the one family that
 *      governs watching and controlling) takes it explicitly from a live view,
 *      confirming once (`confirm`, CONTRACTS §2.2), through AW-11's control
 *      arbiter: one controller per computer across every view, the idle and
 *      ceiling releases, request and hand-over.
 *
 * The node reports the machine half on every heartbeat inside `helper`
 * (`control`, `inputReasons`), so the platform can say why control is not
 * offered ({@link FLEET_DESKTOP_CONTROL_REASONS}) before anyone tries.
 */

// ─── Why a desktop cannot be controlled ────────────────────────────────────

/**
 * Reasons control is not available on a desktop that CAN be watched — the
 * watching reasons (`FLEET_DESKTOP_REASONS`) come first and are not repeated.
 *
 *  - `control-not-allowed` — the owner has not allowed control on the machine
 *    (`ever-works-node helper control allow`), or allowed it for a helper that
 *    has since been approved again;
 *  - `permission-accessibility` — macOS has not granted the helper
 *    Accessibility (input), FR-22;
 *  - `input-unavailable` — the session takes no synthetic input (an X server
 *    without the XTest extension, another desktop in front on Windows).
 */
export const FLEET_DESKTOP_CONTROL_REASONS = ['control-not-allowed', 'permission-accessibility', 'input-unavailable'] as const;

export type FleetDesktopControlReason = (typeof FLEET_DESKTOP_CONTROL_REASONS)[number];

export function isFleetDesktopControlReason(value: unknown): value is FleetDesktopControlReason {
	return typeof value === 'string' && (FLEET_DESKTOP_CONTROL_REASONS as readonly string[]).includes(value);
}

/** Known reasons only, de-duplicated, in the order of {@link FLEET_DESKTOP_CONTROL_REASONS}. */
export function normalizeFleetDesktopControlReasons(value: unknown): FleetDesktopControlReason[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set(value.filter(isFleetDesktopControlReason));
	return FLEET_DESKTOP_CONTROL_REASONS.filter((reason) => seen.has(reason));
}

/** The command or settings path that fixes each reason (shown beside the hint). */
export const FLEET_DESKTOP_CONTROL_REASON_FIXES: Readonly<
	Record<FleetDesktopControlReason, { command?: string; settingsPath?: string }>
> = Object.freeze({
	'control-not-allowed': { command: 'ever-works-node helper control allow' },
	'permission-accessibility': { settingsPath: 'System Settings → Privacy & Security → Accessibility' },
	'input-unavailable': {}
});

/** The one-sentence hint for a reason (the same words on the web, the API refusal and the tools). */
export function fleetDesktopControlReasonHint(reason: FleetDesktopControlReason, computerName: string): string {
	switch (reason) {
		case 'control-not-allowed':
			return `Control is not allowed on ${computerName}. At that computer, run: ever-works-node helper control allow`;
		case 'permission-accessibility':
			return `macOS has not allowed the screen helper on ${computerName} to use the mouse and keyboard — System Settings → Privacy & Security → Accessibility`;
		case 'input-unavailable':
			return `${computerName} does not take mouse and keyboard input from the screen helper in this session`;
	}
}

// ─── The machine half: the owner's permission ──────────────────────────────

/** What the node reports in `helper.control`: the owner's on-machine permission. */
export const FLEET_HELPER_CONTROL_STATES = ['allowed', 'not-allowed'] as const;

export type FleetHelperControlState = (typeof FLEET_HELPER_CONTROL_STATES)[number];

export function isFleetHelperControlState(value: unknown): value is FleetHelperControlState {
	return typeof value === 'string' && (FLEET_HELPER_CONTROL_STATES as readonly string[]).includes(value);
}

/** The word the owner types at `ever-works-node helper control allow` (on the machine, never from the web). */
export const FLEET_HELPER_CONTROL_WORD = 'control';

/** `helper-control.json` beside the admission record (`0600`, owner-only ACL on Windows). */
export interface FleetHelperControlRecord {
	schemaVersion: 1;
	allowed: boolean;
	/** The `acknowledgedAt` of the admission it was given for — another admission voids it. */
	admissionAt: string;
	/** When the owner last changed it (the machine's clock). */
	changedAt: string;
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** Read a control record; null for anything that is not exactly one (read as "not allowed"). */
export function parseFleetHelperControlRecord(value: unknown): FleetHelperControlRecord | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	if (raw.schemaVersion !== 1 || typeof raw.allowed !== 'boolean') return null;
	if (typeof raw.admissionAt !== 'string' || !ISO_INSTANT.test(raw.admissionAt)) return null;
	if (typeof raw.changedAt !== 'string' || !ISO_INSTANT.test(raw.changedAt)) return null;
	return { schemaVersion: 1, allowed: raw.allowed, admissionAt: raw.admissionAt, changedAt: raw.changedAt };
}

/** Control is allowed only by a record given for THIS admission. */
export function isFleetHelperControlAllowed(
	control: FleetHelperControlRecord | null | undefined,
	admission: { acknowledgedAt: string } | null | undefined
): boolean {
	return Boolean(control?.allowed && admission && control.admissionAt === admission.acknowledgedAt);
}

/**
 * The control reasons a reported helper status implies (`helper.control`,
 * `helper.inputReasons` on the heartbeat). A status that says nothing about
 * control (an older node) reads as `control-not-allowed`: control is never
 * offered on a guess.
 */
export function resolveFleetDesktopControlReasons(
	helper: { control?: unknown; inputReasons?: unknown } | null | undefined
): FleetDesktopControlReason[] {
	const reasons = normalizeFleetDesktopControlReasons(helper?.inputReasons);
	if (helper?.control !== 'allowed' && !reasons.includes('control-not-allowed')) reasons.unshift('control-not-allowed');
	return normalizeFleetDesktopControlReasons(reasons);
}

// ─── The channel ───────────────────────────────────────────────────────────

/** A desktop channel's mode, fixed when it opens (`channel.open { mode }`, from the grant). */
export const FLEET_DESKTOP_MODES = ['watching', 'controlling'] as const;

export type FleetDesktopMode = (typeof FLEET_DESKTOP_MODES)[number];

export function isFleetDesktopMode(value: unknown): value is FleetDesktopMode {
	return typeof value === 'string' && (FLEET_DESKTOP_MODES as readonly string[]).includes(value);
}

/** Longest controller name the node prints on the machine ("… is controlling this computer"). */
export const FLEET_DESKTOP_CONTROLLER_NAME_MAX = 64;

/** A controller name safe to print on the machine's console: one line, no control characters, bounded. */
export function normalizeFleetDesktopControllerName(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const clean = value
		.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, FLEET_DESKTOP_CONTROLLER_NAME_MAX);
	return clean.length > 0 ? clean : null;
}

/**
 * `desktop.inputRefused { code }` (node → the controlling viewer, at most one a
 * second): an input the machine did not take. A code only — never the input.
 */
export const FLEET_DESKTOP_INPUT_REFUSED_CODES = [
	'blocked-shortcut',
	'not-controlling',
	'control-not-allowed',
	'permission-accessibility',
	'input-unavailable',
	'inject-failed'
] as const;

export type FleetDesktopInputRefusedCode = (typeof FLEET_DESKTOP_INPUT_REFUSED_CODES)[number];

export function isFleetDesktopInputRefusedCode(value: unknown): value is FleetDesktopInputRefusedCode {
	return typeof value === 'string' && (FLEET_DESKTOP_INPUT_REFUSED_CODES as readonly string[]).includes(value);
}

/** Map anything the helper answered to a known code (an unknown one is `inject-failed`). */
export function normalizeFleetDesktopInputRefusedCode(value: unknown): FleetDesktopInputRefusedCode {
	return isFleetDesktopInputRefusedCode(value) ? value : 'inject-failed';
}

/** The shortcuts a controller's keyboard never forwards (AW-11's list, named on the surface, FR-37). */
export function fleetDesktopBlockedShortcutLabels(): string[] {
	return [...new Set(COMPUTER_BLOCKED_SHORTCUTS.map((shortcut) => shortcut.label))];
}

// ─── Routes (CONTRACTS §11.2 `/api/fleet/nodes/:id/desktop/views/:viewId/control*`) ───

/** `POST …/views/:viewId/control` body: take control (`confirm: true`, class `confirm`), or ask for it (`request: true`). */
export interface FleetDesktopControlRequest {
	request?: boolean;
	confirm?: boolean;
}

/**
 * What every control route answers: AW-11's control state as this view sees
 * it, and — when the view's role changed (it took control, or gave it back) —
 * the fresh grant to re-attach with (`driver` while it holds control, else
 * `viewer`).
 */
export interface FleetDesktopControlResult {
	state: ComputerControlStateView;
	attach: FleetDesktopAttachGrant | null;
}

/** The control half of `GET …/desktop/availability`. */
export interface FleetDesktopControlAvailability {
	/** True when a person in the `desktop` audience may take control of a live view now. */
	available: boolean;
	reasons: FleetDesktopControlReason[];
	/** The first reason's hint, or null. */
	hint: string | null;
	/** What the keyboard never forwards. */
	blockedShortcuts: string[];
}

/** Assemble the control availability of a computer from its reported helper status. */
export function fleetDesktopControlAvailabilityOf(
	helper: { control?: unknown; inputReasons?: unknown } | null | undefined,
	computerName: string
): FleetDesktopControlAvailability {
	const reasons = resolveFleetDesktopControlReasons(helper);
	return {
		available: reasons.length === 0,
		reasons,
		hint: reasons.length > 0 ? fleetDesktopControlReasonHint(reasons[0], computerName) : null,
		blockedShortcuts: fleetDesktopBlockedShortcutLabels()
	};
}
