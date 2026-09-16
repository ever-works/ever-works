/**
 * Agent computers — taking control of the machine an Agent works on.
 *
 * A live view starts in watching mode. A person the machine's control
 * policy allows may TAKE control: their pointer and keyboard drive the
 * Agent's own browser, the Agent's own input to it is paused, and control
 * is handed back — by the person, or automatically when they go idle, lose
 * their connection or reach the ceiling on one stretch of control.
 *
 * Exactly one person holds a machine at a time, across every live view of
 * it. The platform keeps that as a compare-and-set lock on the machine's
 * row, so two people pressing "Take over" at once, or a hand-over racing an
 * automatic release, always resolve to one holder. These are the shapes the
 * owner's surface reads it through.
 */

import type { ComputerControlReleaseReason, ComputerMode } from './computer-frame.types.js';
import type { ComputerControlPolicy } from './computer-session.types.js';

/** Control is given back after this long with no pointer or key input (operator clamp 1–60 min). */
export const COMPUTER_CONTROL_IDLE_MS_DEFAULT = 10 * 60_000;

/** The countdown before an idle release is shown for this long. */
export const COMPUTER_CONTROL_IDLE_WARNING_MS = 30_000;

/** Longest single stretch of control (operator clamp 5–240 min); extendable once. */
export const COMPUTER_CONTROL_CEILING_MS_DEFAULT = 60 * 60_000;

/** Control is released this long after the controlling browser stops acknowledging. */
export const COMPUTER_CONTROL_DISCONNECT_MS = 30_000;

/** A request for control declines on its own after this long. */
export const COMPUTER_CONTROL_REQUEST_TIMEOUT_MS = 60_000;

/** The person asking, relative to the machine. Decides what the control policy lets them do. */
export const COMPUTER_VIEWER_ROLES = ['owner', 'org-admin', 'org-member', 'stranger'] as const;
export type ComputerViewerRole = (typeof COMPUTER_VIEWER_ROLES)[number];

export function isComputerViewerRole(value: unknown): value is ComputerViewerRole {
	return typeof value === 'string' && (COMPUTER_VIEWER_ROLES as readonly string[]).includes(value);
}

/**
 * Why a control act was refused — a closed set, so the surface can say the
 * one thing that is true instead of a generic failure.
 */
export const COMPUTER_CONTROL_REFUSALS = [
	/** The machine's control policy does not include this person. */
	'policy',
	/** Someone else holds control. */
	'held',
	/** The view is not showing pictures yet (or any more): there is nothing to drive. */
	'not-live',
	/** The view has ended. */
	'session-ended',
	/** The act needs control, and this view does not hold it. */
	'not-holder',
	/** Nobody holds control, so there is nobody to ask — take it instead. */
	'not-held',
	/** Another request is already waiting for an answer. */
	'already-requested',
	/** The request being answered is gone (answered, withdrawn or timed out). */
	'no-request',
	/** This stretch of control was already extended once. */
	'already-extended'
] as const;
export type ComputerControlRefusal = (typeof COMPUTER_CONTROL_REFUSALS)[number];

export function isComputerControlRefusal(value: unknown): value is ComputerControlRefusal {
	return typeof value === 'string' && (COMPUTER_CONTROL_REFUSALS as readonly string[]).includes(value);
}

/** How the holder answers a request. */
export const COMPUTER_CONTROL_DECISIONS = ['hand-over', 'keep'] as const;
export type ComputerControlDecision = (typeof COMPUTER_CONTROL_DECISIONS)[number];

export function isComputerControlDecision(value: unknown): value is ComputerControlDecision {
	return typeof value === 'string' && (COMPUTER_CONTROL_DECISIONS as readonly string[]).includes(value);
}

/** Who holds control of the machine right now. */
export interface ComputerControlHolderView {
	userId: string;
	/** The live view that holds it. */
	sessionId: string;
	since: string | null;
	/** The ceiling on this stretch of control. */
	expiresAt: string | null;
	/** When control is given back if no input arrives before then. */
	idleAt: string | null;
	/** True once this stretch was extended (it can be, once). */
	extended: boolean;
	/** The person asking holds it (possibly in another view of theirs). */
	you: boolean;
	/** The view asking is the one that holds it. */
	thisView: boolean;
}

/** A pending request for control. */
export interface ComputerControlRequestView {
	/** Answer with this id. */
	requestId: string;
	userId: string;
	sessionId: string;
	requestedAt: string | null;
	/** When it declines on its own. */
	expiresAt: string | null;
	/** The person asking made it. */
	you: boolean;
}

/** How the view's last stretch of control ended — lets the surface say "released automatically". */
export interface ComputerControlLastReleaseView {
	reason: ComputerControlReleaseReason;
	at: string | null;
}

/** `GET /api/agents/:id/computer/sessions/:sessionId/control` — control, as one live view sees it. */
export interface ComputerControlStateView {
	nodeId: string;
	sessionId: string;
	policy: ComputerControlPolicy;
	/** Whether the policy lets the person asking take control at all. */
	canControl: boolean;
	/** `controlling` exactly when THIS view holds control. */
	mode: ComputerMode;
	holder: ComputerControlHolderView | null;
	request: ComputerControlRequestView | null;
	lastRelease: ComputerControlLastReleaseView | null;
	/** The platform's clock, so countdowns do not depend on the viewer's. */
	serverTime: string;
}

/** Modifier bits of a `key` frame: 1 alt, 2 ctrl, 4 meta, 8 shift. */
export const COMPUTER_KEY_MODIFIER_ALT = 1;
export const COMPUTER_KEY_MODIFIER_CTRL = 2;
export const COMPUTER_KEY_MODIFIER_META = 4;
export const COMPUTER_KEY_MODIFIER_SHIFT = 8;

/**
 * A key combination a controlling browser never forwards to the machine, and
 * the machine refuses even if one arrives. Clipboard combinations would move
 * clipboard contents between the viewer's computer and the Agent's; the rest
 * close, open or switch windows and tabs out from under the Agent, or reach
 * the machine's operating system rather than the Agent's page.
 */
export interface ComputerBlockedShortcut {
	/** Physical key (`KeyboardEvent.code`), so a keyboard layout cannot slip one through. */
	readonly code: string;
	/** Modifier bits that must ALL be held for the combination (`0` = the key on its own). */
	readonly requires: number;
	/** How the surface names it. Key names only, no prose. */
	readonly label: string;
}

const CTRL = COMPUTER_KEY_MODIFIER_CTRL;
const META = COMPUTER_KEY_MODIFIER_META;
const ALT = COMPUTER_KEY_MODIFIER_ALT;

/** Ctrl on one platform, ⌘ on the other: the same combination listed under both. */
function withCtrlOrMeta(code: string, key: string): ComputerBlockedShortcut[] {
	return [
		{ code, requires: CTRL, label: `Ctrl/⌘+${key}` },
		{ code, requires: META, label: `Ctrl/⌘+${key}` }
	];
}

export const COMPUTER_BLOCKED_SHORTCUTS: readonly ComputerBlockedShortcut[] = Object.freeze([
	...withCtrlOrMeta('KeyC', 'C'),
	...withCtrlOrMeta('KeyX', 'X'),
	...withCtrlOrMeta('KeyV', 'V'),
	...withCtrlOrMeta('KeyW', 'W'),
	...withCtrlOrMeta('KeyT', 'T'),
	...withCtrlOrMeta('KeyN', 'N'),
	...withCtrlOrMeta('KeyQ', 'Q'),
	...withCtrlOrMeta('Tab', 'Tab'),
	{ code: 'Tab', requires: ALT, label: 'Alt+Tab' },
	{ code: 'F4', requires: ALT, label: 'Alt+F4' },
	{ code: 'Delete', requires: CTRL | ALT, label: 'Ctrl+Alt+Delete' },
	{ code: 'MetaLeft', requires: 0, label: '⌘/Win' },
	{ code: 'MetaRight', requires: 0, label: '⌘/Win' }
]);

/** True when a key press is one of {@link COMPUTER_BLOCKED_SHORTCUTS}. Never throws. */
export function isComputerShortcutBlocked(frame: { code?: unknown; modifiers?: unknown }): boolean {
	const code = typeof frame?.code === 'string' ? frame.code : '';
	const modifiers = typeof frame?.modifiers === 'number' && Number.isFinite(frame.modifiers) ? frame.modifiers : 0;
	return COMPUTER_BLOCKED_SHORTCUTS.some(
		(shortcut) => shortcut.code === code && (modifiers & shortcut.requires) === shortcut.requires
	);
}
