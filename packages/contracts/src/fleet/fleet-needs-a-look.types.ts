/**
 * Fleet hub (FL-01) — "needs a look": the one shape every producer emits
 * and the hub renders (CONTRACTS §4.6, R-23).
 *
 * An item is COMPUTED, never stored: a producer (FL-03 health, FL-05
 * sessions, FL-13 schedules, FL-17 cloud, FL-18 runners, FL-02 consents)
 * reads facts it already owns and says, per computer, what a person should
 * look at. FL-01 owns the shape, the registry and the renderer, and ships
 * no producer of its own.
 *
 * The item is EXACTLY CONTRACTS §4.6's shape — no extra fields: the
 * renderer resolves the computer's name from `nodeId` against the node
 * list it already holds.
 */

/** Every kind a producer may raise (CONTRACTS §4.6). A closed set: a new kind is a contract change. */
export const NEEDS_A_LOOK_KINDS = [
	'disk-low',
	'node-throttled',
	'node-quarantined',
	'node-upgrade-required',
	'runner-stopped',
	'job-unassignable',
	'session-needs-you',
	'session-unconfirmed',
	'service-failed',
	'schedule-failed',
	'cloud-idle',
	'helper-untrusted',
	'consent-missing'
] as const;

export type NeedsALookKind = (typeof NEEDS_A_LOOK_KINDS)[number];

export function isNeedsALookKind(value: unknown): value is NeedsALookKind {
	return typeof value === 'string' && (NEEDS_A_LOOK_KINDS as readonly string[]).includes(value);
}

/** Severities, most urgent first — the order the list is sorted in. */
export const NEEDS_A_LOOK_SEVERITIES = ['critical', 'warn', 'info'] as const;

export type NeedsALookSeverity = (typeof NEEDS_A_LOOK_SEVERITIES)[number];

export function isNeedsALookSeverity(value: unknown): value is NeedsALookSeverity {
	return typeof value === 'string' && (NEEDS_A_LOOK_SEVERITIES as readonly string[]).includes(value);
}

/**
 * The one action a row may offer (FR-6): navigate to a `route` (an app path
 * starting with `/`), or run a named `command` the web tier knows how to run
 * (e.g. FL-03's "clear limit now"). Exactly one of the two.
 */
export interface NeedsALookAction {
	label: string;
	route?: string;
	command?: string;
}

export interface NeedsALookItem {
	/** Stable per (node, kind, subject): the same problem keeps the same id across reads. */
	id: string;
	nodeId: string;
	severity: NeedsALookSeverity;
	kind: NeedsALookKind;
	/** Plain-language problem, one short sentence. */
	title: string;
	/** One more sentence: the number, the reset time, what happens next. */
	detail: string;
	action?: NeedsALookAction;
	/** ISO-8601 instant the problem started (or was first seen). */
	since: string;
}

/**
 * Response header of `GET /api/fleet/needs-a-look` and
 * `GET /api/fleet/nodes/:id/needs-a-look` (whose body is `NeedsALookItem[]`):
 * `true` when at least one producer failed and was skipped, so the list is
 * what the others said (spec U11) — never proof that nothing needs a look.
 */
export const NEEDS_A_LOOK_PARTIAL_HEADER = 'X-Fleet-Partial';

/** Bounds a producer's output is clipped to before it reaches a browser. */
export const NEEDS_A_LOOK_MAX_ITEMS = 200;
export const NEEDS_A_LOOK_MAX_TITLE_LENGTH = 200;
export const NEEDS_A_LOOK_MAX_DETAIL_LENGTH = 500;
export const NEEDS_A_LOOK_MAX_LABEL_LENGTH = 60;
export const NEEDS_A_LOOK_MAX_ROUTE_LENGTH = 500;
export const NEEDS_A_LOOK_MAX_COMMAND_LENGTH = 64;

const COMMAND_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;

function clip(value: unknown, max: number): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (trimmed.length === 0) return null;
	return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function normalizeSince(value: unknown): string | null {
	if (typeof value !== 'string' && !(value instanceof Date)) return null;
	const at = new Date(value as string | Date);
	return Number.isFinite(at.getTime()) ? at.toISOString() : null;
}

/**
 * An app route a row may navigate to: a same-origin path, never a URL with a
 * scheme or a protocol-relative `//host` (a producer bug must not become an
 * open redirect in someone's hub). ASCII whitespace and control characters
 * are refused anywhere in it: URL parsing strips tabs and newlines BEFORE it
 * reads the path, so `/\t/evil.example` would otherwise navigate like
 * `//evil.example`.
 */
export function isNeedsALookRoute(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.startsWith('/') &&
		!value.startsWith('//') &&
		!value.includes('\\') &&
		!hasWhitespaceOrControl(value) &&
		value.length <= NEEDS_A_LOOK_MAX_ROUTE_LENGTH
	);
}

/** True when `value` holds an ASCII control character (U+0000–U+001F, U+007F) or a space. */
function hasWhitespaceOrControl(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code <= 0x20 || code === 0x7f) return true;
	}
	return false;
}

/**
 * Validate and clip one producer item. Returns null for anything that does
 * not carry the required fields with known values — a malformed item is
 * dropped, never rendered half-right. An action with neither a valid route
 * nor a valid command is dropped (the row still renders, without a button).
 */
export function normalizeNeedsALookItem(value: unknown): NeedsALookItem | null {
	if (!value || typeof value !== 'object') return null;
	const raw = value as Record<string, unknown>;
	const id = clip(raw.id, 200);
	const nodeId = clip(raw.nodeId, 64);
	const title = clip(raw.title, NEEDS_A_LOOK_MAX_TITLE_LENGTH);
	const since = normalizeSince(raw.since);
	if (!id || !nodeId || !title || !since) return null;
	if (!isNeedsALookSeverity(raw.severity) || !isNeedsALookKind(raw.kind)) return null;

	const item: NeedsALookItem = {
		id,
		nodeId,
		severity: raw.severity,
		kind: raw.kind,
		title,
		detail: clip(raw.detail, NEEDS_A_LOOK_MAX_DETAIL_LENGTH) ?? '',
		since
	};
	const action = raw.action as Record<string, unknown> | undefined;
	if (action && typeof action === 'object') {
		const label = clip(action.label, NEEDS_A_LOOK_MAX_LABEL_LENGTH);
		const route = isNeedsALookRoute(action.route) ? action.route : null;
		const command =
			typeof action.command === 'string' &&
			action.command.length <= NEEDS_A_LOOK_MAX_COMMAND_LENGTH &&
			COMMAND_PATTERN.test(action.command)
				? action.command
				: null;
		if (label && (route || command)) {
			item.action = route ? { label, route } : { label, command: command as string };
		}
	}
	return item;
}

const SEVERITY_RANK: Readonly<Record<NeedsALookSeverity, number>> = { critical: 0, warn: 1, info: 2 };

/**
 * The list order (FR-5): critical, then warn, then info; within a severity
 * the longest-standing problem first; ties broken by id so two reads of the
 * same facts render in the same order. Returns a new array.
 */
export function sortNeedsALook(items: readonly NeedsALookItem[]): NeedsALookItem[] {
	return [...items].sort((a, b) => {
		const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
		if (bySeverity !== 0) return bySeverity;
		const bySince = new Date(a.since).getTime() - new Date(b.since).getTime();
		if (bySince !== 0) return bySince;
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});
}
