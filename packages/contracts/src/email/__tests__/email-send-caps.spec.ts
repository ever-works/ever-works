import { describe, expect, it } from 'vitest';
import {
	EMAIL_INBOX_BURST_RECIPIENTS,
	EMAIL_INBOX_BURST_SENDS,
	EMAIL_INBOX_DEFAULT_DAILY_CAP,
	EMAIL_MAX_RECIPIENTS_PER_MESSAGE,
	EMAIL_SEND_CAP_MAX_CONFIGURABLE,
	EMAIL_WORKSPACE_DAILY_CAP,
	EMAIL_WORKSPACE_MONTHLY_CAP
} from '../email.constants.js';
import {
	computeEmailCapRetryAfterSeconds,
	distinctEmailRecipients,
	evaluateEmailSendCaps,
	normalizeEmailRecipient,
	normalizeEmailSendCapsOverride,
	resolveEmailSendCaps,
	type EmailSendWindowUsage
} from '../email-send-caps.js';
import { AGENT_INBOX_DEFAULT_MODE, EMAIL_MESSAGE_STATUSES, EMAIL_SEND_CAP_LIMIT_KINDS } from '../email.types.js';

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
