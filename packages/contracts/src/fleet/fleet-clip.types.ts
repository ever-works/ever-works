/**
 * Fleet — paste into a desktop (FL-11 phase 2, CONTRACTS R-27, §3.2 `CLIP`,
 * §3.3 `clip` family, §7 `node.clip.paste`, §10 clipboard paste).
 *
 * The clipboard's ONE sanctioned direction: text from the viewer's own
 * clipboard into the machine behind a desktop view, at most 256 KiB, only
 * while the viewer holds control of that view and switched paste on for it.
 * The machine places the text on its clipboard and sends its paste chord to
 * the focused window; it never sends its clipboard to the platform. The
 * blocked clipboard shortcuts of the live view stay blocked — this is a
 * separate act on a separate channel.
 *
 * Wire: `channel.open { family: 'clip', params: { viewId } }` (R-27 — the
 * computer session being pasted into, never a fleet session), one `CLIP`
 * frame carrying the UTF-8 text, the node answers JSON `clip.pasted
 * { bytes }` or `clip.failed { error }`, and the platform closes the channel.
 */

import { FLEET_LINK_MAX_CLIP_BYTES } from './fleet-link.types.js';

/** Largest text one paste carries, in UTF-8 bytes (CONTRACTS §10). */
export const FLEET_CLIP_MAX_BYTES = FLEET_LINK_MAX_CLIP_BYTES;

/** Pastes per user per minute (CONTRACTS §10.1). */
export const FLEET_CLIP_PASTE_RATE_LIMIT = 30;

/** A node that has not confirmed a paste within this long is `unreachable`. */
export const FLEET_CLIP_PASTE_TIMEOUT_MS = 10_000;

/** JSON `type`s the node sends on a `clip` channel. */
export const FLEET_CLIP_MESSAGES = {
	pasted: 'clip.pasted',
	failed: 'clip.failed'
} as const;

/** `channel.open { family: 'clip', params }`. */
export interface FleetClipOpenParams {
	/** The desktop view (computer session) being pasted into. */
	viewId: string;
}

/** `POST /api/fleet/nodes/:id/desktop/views/:viewId/clip`. */
export interface FleetClipPasteRequest {
	text: string;
}

export interface FleetClipPasteResult {
	bytes: number;
	pastedAt: string;
}

/** `PATCH /api/fleet/nodes/:id/desktop/views/:viewId` (the field FL-11 adds). */
export interface FleetClipPasteSwitch {
	pasteAllowed: boolean;
}

/** The view's paste switch as the Desktop tab reads it. */
export interface FleetClipViewState {
	viewId: string;
	pasteAllowed: boolean;
}

const VIEW_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isFleetClipViewId(value: unknown): value is string {
	return typeof value === 'string' && VIEW_ID_PATTERN.test(value);
}

export function parseFleetClipOpenParams(value: unknown): FleetClipOpenParams | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	return isFleetClipViewId(raw.viewId) ? { viewId: raw.viewId } : null;
}

/** The UTF-8 size of a text, as the cap measures it. */
export function fleetClipByteLength(text: string): number {
	return new TextEncoder().encode(text).byteLength;
}

/** True when the text may be pasted: a non-empty string, no NUL, within {@link FLEET_CLIP_MAX_BYTES}. */
export function isFleetClipText(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		!value.includes('\0') &&
		fleetClipByteLength(value) <= FLEET_CLIP_MAX_BYTES
	);
}
