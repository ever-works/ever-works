import { describe, expect, it } from 'vitest';
import {
	EMAIL_INBOX_BURST_RECIPIENTS,
	EMAIL_INBOX_BURST_SENDS,
	EMAIL_INBOX_DEFAULT_DAILY_CAP,
	EMAIL_MAX_RECIPIENTS_PER_MESSAGE,
	EMAIL_SEND_CAP_MAX_CONFIGURABLE,
	EMAIL_SEND_CAP_RECOMMENDED_DEFAULTS,
	EMAIL_WORKSPACE_DAILY_CAP,
	EMAIL_WORKSPACE_MONTHLY_CAP
} from '../email.constants.js';
import {
	computeEmailCapRetryAfterSeconds,
	distinctEmailRecipients,
	emailSendCapWindowsInForce,
	evaluateEmailSendCaps,
	normalizeEmailRecipient,
	normalizeEmailSendCapsOverride,
	resolveEmailSendCaps,
	type EmailSendWindowUsage
} from '../email-send-caps.js';
import {
	AGENT_INBOX_DEFAULT_MODE,
	EMAIL_MESSAGE_STATUSES,
	EMAIL_SEND_CAP_FIELDS,
	EMAIL_SEND_CAP_LIMIT_KINDS
} from '../email.types.js';

const PLATFORM = {
	inboxDailySends: EMAIL_INBOX_DEFAULT_DAILY_CAP,
	inboxBurstSends: EMAIL_INBOX_BURST_SENDS,
	inboxBurstRecipients: EMAIL_INBOX_BURST_RECIPIENTS,
	recipientsPerMessage: EMAIL_MAX_RECIPIENTS_PER_MESSAGE,
	workspaceDailySends: EMAIL_WORKSPACE_DAILY_CAP,
	workspaceMonthlySends: EMAIL_WORKSPACE_MONTHLY_CAP
};

const EMPTY_USAGE: EmailSendWindowUsage = {
	hasInbox: true,
	inboxBurstSends: 0,
	inboxDailySends: 0,
	inboxRecentRecipients: [],
	workspaceDailySends: 0,
	workspaceMonthlySends: 0
};

describe('email contract constants', () => {
	it('starts a new inbox in draft review and keeps the status list append-only', () => {
		expect(AGENT_INBOX_DEFAULT_MODE).toBe('draft-review');
		expect(EMAIL_MESSAGE_STATUSES.slice(0, 2)).toEqual(['received', 'draft']);
		expect(EMAIL_SEND_CAP_LIMIT_KINDS[0]).toBe('recipientsPerMessage');
	});
});

describe('normalizeEmailSendCapsOverride', () => {
	it('keeps integers in range, including 0 for "no ceiling"', () => {
		expect(normalizeEmailSendCapsOverride({ inboxDailySends: 0, workspaceDailySends: 42 })).toEqual({
			inboxDailySends: 0,
			workspaceDailySends: 42
		});
	});

	it('drops garbage so a malformed stored value inherits instead of lifting the ceiling', () => {
		expect(
			normalizeEmailSendCapsOverride({
				inboxDailySends: -1,
				inboxBurstSends: 2.5,
				inboxBurstRecipients: '10',
				recipientsPerMessage: EMAIL_SEND_CAP_MAX_CONFIGURABLE + 1,
				unknownField: 3
			})
		).toEqual({});
		expect(normalizeEmailSendCapsOverride(null)).toEqual({});
		expect(normalizeEmailSendCapsOverride([1, 2])).toEqual({});
	});

	it('restricts the field list when asked', () => {
		expect(
			normalizeEmailSendCapsOverride({ inboxDailySends: 5, workspaceDailySends: 5 }, ['inboxDailySends'])
		).toEqual({ inboxDailySends: 5 });
	});
});

describe('resolveEmailSendCaps', () => {
	it('uses the platform ceilings when nothing overrides them', () => {
		const { caps, sources } = resolveEmailSendCaps({ platform: PLATFORM });
		expect(caps.inboxDailySends).toBe(100);
		expect(sources.inboxDailySends).toBe('platform');
	});

	it('lets the organization replace any ceiling and the inbox replace its own', () => {
		const { caps, sources } = resolveEmailSendCaps({
			platform: PLATFORM,
			organization: { inboxDailySends: 40, workspaceDailySends: 200 },
			inbox: { inboxDailySends: 7 }
		});
		expect(caps.inboxDailySends).toBe(7);
		expect(sources.inboxDailySends).toBe('inbox');
		expect(caps.workspaceDailySends).toBe(200);
		expect(sources.workspaceDailySends).toBe('organization');
	});

	it('never lets an inbox widen the workspace ceilings', () => {
		const { caps, sources } = resolveEmailSendCaps({
			platform: PLATFORM,
			inbox: { workspaceDailySends: 0, workspaceMonthlySends: 999_999 }
		});
		expect(caps.workspaceDailySends).toBe(EMAIL_WORKSPACE_DAILY_CAP);
		expect(caps.workspaceMonthlySends).toBe(EMAIL_WORKSPACE_MONTHLY_CAP);
		expect(sources.workspaceDailySends).toBe('platform');
	});

	it('maps an explicit 0 at any scope to "no ceiling"', () => {
		const platformOff = resolveEmailSendCaps({ platform: { ...PLATFORM, workspaceMonthlySends: 0 } });
		expect(platformOff.caps.workspaceMonthlySends).toBeNull();
		const inboxOff = resolveEmailSendCaps({ platform: PLATFORM, inbox: { inboxDailySends: 0 } });
		expect(inboxOff.caps.inboxDailySends).toBeNull();
	});

	it('treats null at a scope as inherit', () => {
		const { caps, sources } = resolveEmailSendCaps({
			platform: PLATFORM,
			organization: { inboxBurstSends: 3 },
			inbox: { inboxBurstSends: null }
		});
		expect(caps.inboxBurstSends).toBe(3);
		expect(sources.inboxBurstSends).toBe('organization');
	});
});

describe('resolveEmailSendCaps — unconfigured = unchanged, every source opts in', () => {
	const HEAVY: EmailSendWindowUsage = {
		hasInbox: true,
		inboxBurstSends: 5_000,
		inboxDailySends: 1_000_000,
		inboxRecentRecipients: Array.from({ length: 2_000 }, (_, i) => `r${i}@x.io`),
		workspaceDailySends: 1_000_000,
		workspaceMonthlySends: 1_000_000
	};
	const MANY = Array.from({ length: 1_000 }, (_, i) => `n${i}@x.io`);

	it('enforces nothing when no source is configured — no env, no organization, no Agent settings', () => {
		const resolved = resolveEmailSendCaps({ platform: {} });
		expect(resolved.configured).toBe(false);
		for (const field of EMAIL_SEND_CAP_FIELDS) {
			expect(resolved.caps[field]).toBeNull();
			expect(resolved.sources[field]).toBe('unconfigured');
		}
		expect(evaluateEmailSendCaps(resolved.caps, HEAVY, MANY)).toBeNull();
		expect(emailSendCapWindowsInForce(resolved.caps, true)).toEqual({ inbox: false, workspace: false });
	});

	it('treats an empty organization policy like no policy', () => {
		const resolved = resolveEmailSendCaps({ platform: {}, organization: {}, inbox: null });
		expect(resolved.configured).toBe(false);
		expect(evaluateEmailSendCaps(resolved.caps, HEAVY, MANY)).toBeNull();
	});

	it('is not a large sentinel: the recommended numbers are documented but not applied', () => {
		expect(EMAIL_SEND_CAP_RECOMMENDED_DEFAULTS).toEqual(PLATFORM);
		const { caps } = resolveEmailSendCaps({ platform: {} });
		expect(Object.values(caps).every((value) => value === null)).toBe(true);
	});

	it('OPERATOR: an env-configured platform ceiling is enforced for that limit only', () => {
		const resolved = resolveEmailSendCaps({ platform: { workspaceDailySends: 300 } });
		expect(resolved.configured).toBe(true);
		expect(resolved.caps.workspaceDailySends).toBe(300);
		expect(resolved.sources.workspaceDailySends).toBe('platform');
		expect(resolved.caps.inboxDailySends).toBeNull();
		expect(resolved.sources.inboxDailySends).toBe('unconfigured');
		expect(
			evaluateEmailSendCaps(resolved.caps, { ...EMPTY_USAGE, workspaceDailySends: 300 }, ['a@x.io'])
		).toMatchObject({ limitKind: 'workspaceDaily', cap: 300 });
		expect(emailSendCapWindowsInForce(resolved.caps, true)).toEqual({ inbox: false, workspace: true });
	});

	it('OPERATOR: an explicit 0 is configured-as-unlimited, and beats the recommended fallback', () => {
		const resolved = resolveEmailSendCaps({ platform: { inboxDailySends: 0 }, inbox: {} });
		expect(resolved.caps.inboxDailySends).toBeNull();
		expect(resolved.sources.inboxDailySends).toBe('platform');
	});

	it('ORGANIZATION: its caps are enforced for its Agents with nothing configured by the operator', () => {
		const resolved = resolveEmailSendCaps({
			platform: {},
			organization: { inboxDailySends: 25, workspaceMonthlySends: 900 }
		});
		expect(resolved.configured).toBe(true);
		expect(resolved.caps.inboxDailySends).toBe(25);
		expect(resolved.sources.inboxDailySends).toBe('organization');
		expect(resolved.caps.workspaceMonthlySends).toBe(900);
		// …and nothing it did not set.
		expect(resolved.caps.inboxBurstSends).toBeNull();
		expect(resolved.sources.inboxBurstSends).toBe('unconfigured');
		expect(evaluateEmailSendCaps(resolved.caps, { ...EMPTY_USAGE, inboxDailySends: 25 }, ['a@x.io'])).toMatchObject(
			{
				limitKind: 'inboxDaily',
				cap: 25
			}
		);
	});

	it('AGENT SETTINGS: a settings row turns on the per-Agent limits, at the recommended numbers when unset', () => {
		const resolved = resolveEmailSendCaps({ platform: {}, inbox: { inboxDailySends: 7 } });
		expect(resolved.configured).toBe(true);
		expect(resolved.caps.inboxDailySends).toBe(7);
		expect(resolved.sources.inboxDailySends).toBe('inbox');
		expect(resolved.caps.inboxBurstSends).toBe(EMAIL_INBOX_BURST_SENDS);
		expect(resolved.sources.inboxBurstSends).toBe('recommended');
		expect(resolved.caps.inboxBurstRecipients).toBe(EMAIL_INBOX_BURST_RECIPIENTS);
		expect(resolved.caps.recipientsPerMessage).toBe(EMAIL_MAX_RECIPIENTS_PER_MESSAGE);
		// An Agent's settings never switch on the account-wide ceilings.
		expect(resolved.caps.workspaceDailySends).toBeNull();
		expect(resolved.sources.workspaceDailySends).toBe('unconfigured');
		expect(emailSendCapWindowsInForce(resolved.caps, true)).toEqual({ inbox: true, workspace: false });
	});

	it('AGENT SETTINGS: a row with every limit left to inherit is still protected', () => {
		const resolved = resolveEmailSendCaps({
			platform: {},
			inbox: { inboxDailySends: null, inboxBurstSends: null },
			inboxConfigured: true
		});
		expect(resolved.caps.inboxDailySends).toBe(EMAIL_INBOX_DEFAULT_DAILY_CAP);
		expect(resolved.sources.inboxDailySends).toBe('recommended');
	});

	it('AGENT SETTINGS: the recommended fallback yields to an organization or operator value above it', () => {
		const resolved = resolveEmailSendCaps({
			platform: { inboxBurstSends: 4 },
			organization: { inboxDailySends: 30 },
			inbox: {}
		});
		expect(resolved.caps.inboxBurstSends).toBe(4);
		expect(resolved.sources.inboxBurstSends).toBe('platform');
		expect(resolved.caps.inboxDailySends).toBe(30);
		expect(resolved.sources.inboxDailySends).toBe('organization');
	});

	it('does not count inbox windows for a send that is not attributed to an Agent', () => {
		const { caps } = resolveEmailSendCaps({ platform: PLATFORM });
		expect(emailSendCapWindowsInForce(caps, false)).toEqual({ inbox: false, workspace: true });
	});
});

describe('evaluateEmailSendCaps', () => {
	const { caps } = resolveEmailSendCaps({ platform: PLATFORM });

	it('allows the 100th send of a rolling day and refuses the 101st', () => {
		expect(evaluateEmailSendCaps(caps, { ...EMPTY_USAGE, inboxDailySends: 99 }, ['a@x.io'])).toBeNull();
		expect(evaluateEmailSendCaps(caps, { ...EMPTY_USAGE, inboxDailySends: 100 }, ['a@x.io'])).toMatchObject({
			limitKind: 'inboxDaily',
			scope: 'inbox',
			used: 100,
			cap: 100
		});
	});

	it('refuses a message with more recipients than the per-message ceiling, first', () => {
		const recipients = Array.from({ length: 51 }, (_, i) => `r${i}@x.io`);
		expect(evaluateEmailSendCaps(caps, { ...EMPTY_USAGE, inboxDailySends: 100 }, recipients)).toMatchObject({
			limitKind: 'recipientsPerMessage',
			used: 51,
			cap: 50
		});
	});

	it('counts one message to N recipients as one send and N recipients', () => {
		const recipients = ['a@x.io', 'b@x.io', 'c@x.io', 'd@x.io', 'e@x.io'];
		expect(
			evaluateEmailSendCaps(caps, { ...EMPTY_USAGE, inboxBurstSends: 9, inboxRecentRecipients: [] }, recipients)
		).toBeNull();
		const recent = Array.from({ length: 16 }, (_, i) => `old${i}@x.io`);
		expect(
			evaluateEmailSendCaps(caps, { ...EMPTY_USAGE, inboxRecentRecipients: recent }, recipients)
		).toMatchObject({ limitKind: 'inboxRecipients', used: 16, cap: 20 });
	});

	it('does not double count a recipient already reached in the window', () => {
		const recent = Array.from({ length: 20 }, (_, i) => `r${i}@x.io`);
		expect(evaluateEmailSendCaps(caps, { ...EMPTY_USAGE, inboxRecentRecipients: recent }, ['R0@X.io'])).toBeNull();
	});

	it('refuses the 11th send inside a minute', () => {
		expect(evaluateEmailSendCaps(caps, { ...EMPTY_USAGE, inboxBurstSends: 10 }, ['a@x.io'])).toMatchObject({
			limitKind: 'inboxBurst'
		});
	});

	it('applies workspace ceilings even when the send has no inbox', () => {
		const usage = { ...EMPTY_USAGE, hasInbox: false, inboxDailySends: 10_000, workspaceDailySends: 500 };
		expect(evaluateEmailSendCaps(caps, usage, ['a@x.io'])).toMatchObject({
			limitKind: 'workspaceDaily',
			scope: 'workspace'
		});
		expect(
			evaluateEmailSendCaps(caps, { ...usage, workspaceDailySends: 0, workspaceMonthlySends: 10_000 }, ['a@x.io'])
		).toMatchObject({ limitKind: 'workspaceMonthly' });
	});

	it('lets an explicitly unrestricted configuration through every ceiling', () => {
		const unrestricted = resolveEmailSendCaps({
			platform: {
				inboxDailySends: 0,
				inboxBurstSends: 0,
				inboxBurstRecipients: 0,
				recipientsPerMessage: 0,
				workspaceDailySends: 0,
				workspaceMonthlySends: 0
			}
		}).caps;
		const heavy: EmailSendWindowUsage = {
			hasInbox: true,
			inboxBurstSends: 1_000,
			inboxDailySends: 1_000_000,
			inboxRecentRecipients: Array.from({ length: 500 }, (_, i) => `r${i}@x.io`),
			workspaceDailySends: 1_000_000,
			workspaceMonthlySends: 1_000_000
		};
		const recipients = Array.from({ length: 300 }, (_, i) => `n${i}@x.io`);
		expect(evaluateEmailSendCaps(unrestricted, heavy, recipients)).toBeNull();
	});
});

describe('recipient normalization', () => {
	it('strips display names, trims and lower-cases', () => {
		expect(normalizeEmailRecipient('  Ada Lovelace <Ada@Example.COM> ')).toBe('ada@example.com');
		expect(distinctEmailRecipients(['a@x.io', 'A@x.io'], null, [' b@x.io', ''])).toEqual(['a@x.io', 'b@x.io']);
	});
});

describe('computeEmailCapRetryAfterSeconds', () => {
	it('returns when the send that has to age out leaves the window', () => {
		const now = 1_000_000;
		const sends = [now - 50_000, now - 40_000, now - 30_000];
		// cap 3, used 3 → the oldest must age out of the 60s window: 10s.
		expect(computeEmailCapRetryAfterSeconds(sends, 3, 60_000, now)).toBe(10);
		// cap 2, used 3 → the second oldest must age out: 20s.
		expect(computeEmailCapRetryAfterSeconds(sends, 2, 60_000, now)).toBe(20);
	});

	it('returns 0 when waiting cannot help', () => {
		expect(computeEmailCapRetryAfterSeconds([], 3, 60_000, 0)).toBe(0);
		expect(computeEmailCapRetryAfterSeconds([1], 3, 0, 0)).toBe(0);
	});
});
