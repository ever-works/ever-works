import {
	EMAIL_DAY_WINDOW_MS,
	EMAIL_INBOX_BURST_WINDOW_MS,
	EMAIL_INBOX_RECIPIENT_WINDOW_MS,
	EMAIL_MONTH_WINDOW_MS,
	EMAIL_SEND_CAP_MAX_CONFIGURABLE
} from './email.constants.js';
import {
	EMAIL_INBOX_CAP_FIELDS,
	EMAIL_SEND_CAP_FIELDS,
	type EmailSendCapField,
	type EmailSendCapLimitKind,
	type EmailSendCapScope,
	type EmailSendCapSource,
	type EmailSendCapsOverride,
	type ResolvedEmailSendCaps
} from './email.types.js';

/**
 * Agent email (AW-05) — the PURE half of the send ceilings.
 *
 * Three scopes, least to most specific:
 *
 *     platform (constants, replaceable by the operator)  <  organization  <  Agent inbox
 *
 * Most specific wins, field by field. An inbox may only speak about the
 * per-inbox ceilings; the workspace ceilings are decided by the platform and
 * the organization alone, so no Agent's own settings can widen the total an
 * account sends.
 *
 * Nothing here touches a database, the clock or a request, so the precedence
 * and the arithmetic can be tested on their own and the same functions run
 * in the API and the worker.
 */

/**
 * Coerce one stored ceiling. Returns `undefined` for "inherit" (null, absent
 * or not a usable integer) — a malformed stored value must degrade to the
 * scope above, never to "no ceiling".
 */
export function normalizeEmailSendCapValue(raw: unknown): number | undefined {
	if (typeof raw !== 'number' || !Number.isInteger(raw)) return undefined;
	if (raw < 0 || raw > EMAIL_SEND_CAP_MAX_CONFIGURABLE) return undefined;
	return raw;
}

/** Keep only well-formed ceilings for the named fields. */
export function normalizeEmailSendCapsOverride(
	raw: unknown,
	fields: readonly EmailSendCapField[] = EMAIL_SEND_CAP_FIELDS
): EmailSendCapsOverride {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
	const source = raw as Record<string, unknown>;
	const out: EmailSendCapsOverride = {};
	for (const field of fields) {
		const value = normalizeEmailSendCapValue(source[field]);
		if (value !== undefined) out[field] = value;
	}
	return out;
}

export interface ResolveEmailSendCapsInput {
	/** Platform ceilings, already carrying any operator replacement. `0` = none. */
	platform: Record<EmailSendCapField, number>;
	organization?: EmailSendCapsOverride | null;
	inbox?: EmailSendCapsOverride | null;
}

export interface ResolvedEmailSendCapsWithSources {
	caps: ResolvedEmailSendCaps;
	sources: Record<EmailSendCapField, EmailSendCapSource>;
}

export function resolveEmailSendCaps(input: ResolveEmailSendCapsInput): ResolvedEmailSendCapsWithSources {
	const organization = normalizeEmailSendCapsOverride(input.organization);
	const inbox = normalizeEmailSendCapsOverride(input.inbox, EMAIL_INBOX_CAP_FIELDS);
	const caps = {} as ResolvedEmailSendCaps;
	const sources = {} as Record<EmailSendCapField, EmailSendCapSource>;
	for (const field of EMAIL_SEND_CAP_FIELDS) {
		let value = normalizeEmailSendCapValue(input.platform[field]) ?? 0;
		let source: EmailSendCapSource = 'platform';
		const orgValue = organization[field];
		if (orgValue !== undefined && orgValue !== null) {
			value = orgValue;
			source = 'organization';
		}
		const inboxValue = inbox[field];
		if (inboxValue !== undefined && inboxValue !== null) {
			value = inboxValue;
			source = 'inbox';
		}
		caps[field] = value === 0 ? null : value;
		sources[field] = source;
	}
	return { caps, sources };
}

/** Lower-case, trim and strip a display name (`Ada <ada@x.io>` → `ada@x.io`). */
export function normalizeEmailRecipient(raw: string): string {
	const trimmed = raw.trim();
	const angle = /<([^<>]+)>\s*$/.exec(trimmed);
	return (angle ? angle[1] : trimmed).trim().toLowerCase();
}

/** Distinct, normalized, non-empty recipients across to + cc + bcc. */
export function distinctEmailRecipients(...lists: ReadonlyArray<readonly string[] | null | undefined>): string[] {
	const seen = new Set<string>();
	for (const list of lists) {
		for (const entry of list ?? []) {
			if (typeof entry !== 'string') continue;
			const value = normalizeEmailRecipient(entry);
			if (value) seen.add(value);
		}
	}
	return [...seen];
}

/** What has already been sent inside each window, read from persisted rows. */
export interface EmailSendWindowUsage {
	/** `false` when the send is not attributed to an Agent — inbox ceilings then do not apply. */
	hasInbox: boolean;
	inboxBurstSends: number;
	inboxDailySends: number;
	/** Recipients reached in the recipient window (any form; normalized here). */
	inboxRecentRecipients: readonly string[];
	workspaceDailySends: number;
	workspaceMonthlySends: number;
}

export interface EmailSendCapRefusal {
	limitKind: EmailSendCapLimitKind;
	scope: EmailSendCapScope;
	field: EmailSendCapField;
	used: number;
	cap: number;
	windowMs: number;
}

export const EMAIL_SEND_CAP_WINDOWS: Record<
	EmailSendCapLimitKind,
	{ field: EmailSendCapField; scope: EmailSendCapScope; windowMs: number }
> = {
	recipientsPerMessage: { field: 'recipientsPerMessage', scope: 'message', windowMs: 0 },
	inboxBurst: { field: 'inboxBurstSends', scope: 'inbox', windowMs: EMAIL_INBOX_BURST_WINDOW_MS },
	inboxRecipients: { field: 'inboxBurstRecipients', scope: 'inbox', windowMs: EMAIL_INBOX_RECIPIENT_WINDOW_MS },
	inboxDaily: { field: 'inboxDailySends', scope: 'inbox', windowMs: EMAIL_DAY_WINDOW_MS },
	workspaceDaily: { field: 'workspaceDailySends', scope: 'workspace', windowMs: EMAIL_DAY_WINDOW_MS },
	workspaceMonthly: { field: 'workspaceMonthlySends', scope: 'workspace', windowMs: EMAIL_MONTH_WINDOW_MS }
};

/**
 * Would ONE more message to `recipients` break a ceiling? Returns the first
 * ceiling broken, in {@link EMAIL_SEND_CAP_LIMIT_KINDS} order, or `null`.
 *
 * One message to N recipients counts as one send against the send ceilings
 * and N against the distinct-recipient ceiling.
 */
export function evaluateEmailSendCaps(
	caps: ResolvedEmailSendCaps,
	usage: EmailSendWindowUsage,
	recipients: readonly string[]
): EmailSendCapRefusal | null {
	const outgoing = distinctEmailRecipients(recipients);
	const refuse = (limitKind: EmailSendCapLimitKind, used: number, cap: number): EmailSendCapRefusal => {
		const window = EMAIL_SEND_CAP_WINDOWS[limitKind];
		return { limitKind, scope: window.scope, field: window.field, used, cap, windowMs: window.windowMs };
	};

	const perMessage = caps.recipientsPerMessage;
	if (perMessage !== null && outgoing.length > perMessage) {
		return refuse('recipientsPerMessage', outgoing.length, perMessage);
	}

	if (usage.hasInbox) {
		const burst = caps.inboxBurstSends;
		if (burst !== null && usage.inboxBurstSends >= burst) {
			return refuse('inboxBurst', usage.inboxBurstSends, burst);
		}
		const recipientCap = caps.inboxBurstRecipients;
		if (recipientCap !== null) {
			const recent = distinctEmailRecipients(usage.inboxRecentRecipients);
			const union = new Set([...recent, ...outgoing]);
			if (union.size > recipientCap) {
				return refuse('inboxRecipients', recent.length, recipientCap);
			}
		}
		const daily = caps.inboxDailySends;
		if (daily !== null && usage.inboxDailySends >= daily) {
			return refuse('inboxDaily', usage.inboxDailySends, daily);
		}
	}

	const workspaceDaily = caps.workspaceDailySends;
	if (workspaceDaily !== null && usage.workspaceDailySends >= workspaceDaily) {
		return refuse('workspaceDaily', usage.workspaceDailySends, workspaceDaily);
	}
	const workspaceMonthly = caps.workspaceMonthlySends;
	if (workspaceMonthly !== null && usage.workspaceMonthlySends >= workspaceMonthly) {
		return refuse('workspaceMonthly', usage.workspaceMonthlySends, workspaceMonthly);
	}
	return null;
}

/**
 * Seconds until a rolling window has room for one more send.
 *
 * `inWindowAscending` are the send times (epoch ms, oldest first) inside the
 * window. With `used` sends against `cap`, the send that has to age out is
 * the `(used - cap + 1)`-th oldest — capacity returns continuously, never in
 * a batch at a calendar boundary.
 */
export function computeEmailCapRetryAfterSeconds(
	inWindowAscending: readonly number[],
	cap: number,
	windowMs: number,
	nowMs: number
): number {
	if (windowMs <= 0 || inWindowAscending.length === 0) return 0;
	const index = Math.max(0, Math.min(inWindowAscending.length - 1, inWindowAscending.length - cap));
	const freesAt = inWindowAscending[index] + windowMs;
	return Math.max(1, Math.ceil((freesAt - nowMs) / 1000));
}
