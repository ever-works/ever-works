import { describe, expect, it } from 'vitest';
import {
	INBOX_EXTERNAL_CHOICE_KINDS,
	INBOX_EXTERNAL_ITEM_KINDS,
	INBOX_ITEM_KINDS,
	INBOX_ITEM_ORIGINS,
	INBOX_ITEM_SOURCE_TYPES,
	INBOX_ITEM_STATUSES,
	INBOX_MAX_OPTIONS,
	INBOX_MAX_OPTION_ID_CHARS,
	INBOX_MAX_OPTION_LABEL_CHARS,
	INBOX_SOURCE_META_MAX_FIELD_CHARS,
	isSafeInboxSourceUrl,
	normalizeInboxEmailMeta,
	normalizeInboxOptions,
	normalizeInboxSourceMeta
} from '../inbox.types.js';

/**
 * `normalizeInboxOptions` is the trust boundary for the one field a
 * MODEL controls end to end: an `ask_human` option list arrives as raw
 * tool arguments and is rendered as clickable buttons whose id comes
 * back as the recorded answer. Everything unanswerable or unbounded has
 * to die here, before it reaches the column.
 */
describe('normalizeInboxOptions', () => {
	it('returns null for non-arrays, empty arrays and all-garbage arrays', () => {
		expect(normalizeInboxOptions(undefined)).toBeNull();
		expect(normalizeInboxOptions(null)).toBeNull();
		expect(normalizeInboxOptions('approve')).toBeNull();
		expect(normalizeInboxOptions([])).toBeNull();
		expect(normalizeInboxOptions([1, 'x', null, []])).toBeNull();
	});

	it('keeps id + label and trims both', () => {
		expect(normalizeInboxOptions([{ id: '  a  ', label: '  Ship it  ' }])).toEqual([{ id: 'a', label: 'Ship it' }]);
	});

	it('drops options with no usable id or label', () => {
		expect(
			normalizeInboxOptions([
				{ id: 'a', label: 'Keep' },
				{ id: '   ', label: 'No id' },
				{ id: 'b' },
				{ label: 'No id at all' },
				{ id: 'c', label: 42 }
			])
		).toEqual([{ id: 'a', label: 'Keep' }]);
	});

	it('drops duplicate ids rather than letting the answer be ambiguous', () => {
		expect(
			normalizeInboxOptions([
				{ id: 'a', label: 'First' },
				{ id: 'a', label: 'Second' }
			])
		).toEqual([{ id: 'a', label: 'First' }]);
	});

	it('carries description and recommended only when they are usable', () => {
		expect(
			normalizeInboxOptions([
				{ id: 'a', label: 'A', description: '  why  ', recommended: true },
				{ id: 'b', label: 'B', description: '   ', recommended: 'yes' }
			])
		).toEqual([
			{ id: 'a', label: 'A', description: 'why', recommended: true },
			{ id: 'b', label: 'B' }
		]);
	});

	it('caps the option count and every string length', () => {
		const many = Array.from({ length: INBOX_MAX_OPTIONS + 5 }, (_, index) => ({
			id: `id-${index}`,
			label: `Label ${index}`
		}));
		expect(normalizeInboxOptions(many)).toHaveLength(INBOX_MAX_OPTIONS);

		const [long] = normalizeInboxOptions([
			{
				id: 'x'.repeat(INBOX_MAX_OPTION_ID_CHARS + 50),
				label: 'y'.repeat(INBOX_MAX_OPTION_LABEL_CHARS + 50),
				description: 'z'.repeat(INBOX_MAX_OPTION_LABEL_CHARS + 50)
			}
		])!;
		expect(long.id).toHaveLength(INBOX_MAX_OPTION_ID_CHARS);
		expect(long.label).toHaveLength(INBOX_MAX_OPTION_LABEL_CHARS);
		expect(long.description).toHaveLength(INBOX_MAX_OPTION_LABEL_CHARS);
	});

	it('is idempotent — normalizing its own output changes nothing', () => {
		const once = normalizeInboxOptions([
			{ id: 'a', label: 'A', recommended: true },
			{ id: 'b', label: 'B' }
		]);
		expect(normalizeInboxOptions(once)).toEqual(once);
	});
});

describe('closed value sets', () => {
	it('has no duplicates and matches the entity column widths', () => {
		for (const set of [INBOX_ITEM_KINDS, INBOX_ITEM_STATUSES, INBOX_ITEM_SOURCE_TYPES]) {
			expect(new Set(set).size).toBe(set.length);
		}
		// `kind` / `status` are varchar(16), `sourceType` is varchar(24).
		expect(Math.max(...INBOX_ITEM_KINDS.map((v) => v.length))).toBeLessThanOrEqual(16);
		expect(Math.max(...INBOX_ITEM_STATUSES.map((v) => v.length))).toBeLessThanOrEqual(16);
		expect(Math.max(...INBOX_ITEM_SOURCE_TYPES.map((v) => v.length))).toBeLessThanOrEqual(24);
	});

	it('lists fleet-run as a source type, appended last', () => {
		// Self-build slice Q. Appended, not inserted: the web mirror of this
		// list pins the order, and a fleet question must stay distinguishable
		// from the in-process `agent-run` one (different resume message).
		expect(INBOX_ITEM_SOURCE_TYPES).toEqual([
			'agent-run',
			'escalation',
			'proposal',
			'system',
			'work',
			'fleet-run',
			'fleet-session',
			'integration'
		]);
		expect(INBOX_ITEM_SOURCE_TYPES.indexOf('fleet-run')).toBe(5);
	});

	it('lists fleet-session (FL-05) after fleet-run, and integration (the inbox push) appended last', () => {
		expect(INBOX_ITEM_SOURCE_TYPES.indexOf('fleet-session')).toBe(6);
		expect(INBOX_ITEM_SOURCE_TYPES[INBOX_ITEM_SOURCE_TYPES.length - 1]).toBe('integration');
	});

	it('appends the integration kinds; an integration files every kind but escalation', () => {
		expect(INBOX_ITEM_KINDS.slice(0, 4)).toEqual(['question', 'approval', 'escalation', 'notice']);
		expect(INBOX_ITEM_KINDS.slice(4)).toEqual(['mention', 'assignment', 'email', 'other']);
		expect([...INBOX_EXTERNAL_ITEM_KINDS].sort()).toEqual(
			INBOX_ITEM_KINDS.filter((kind) => kind !== 'escalation').sort()
		);
		expect(INBOX_EXTERNAL_CHOICE_KINDS).toEqual(['question', 'approval']);
		expect(INBOX_ITEM_ORIGINS).toEqual(['platform', 'integration']);
		// `origin` is varchar(16) like `kind`.
		expect(Math.max(...INBOX_ITEM_ORIGINS.map((v) => v.length))).toBeLessThanOrEqual(16);
	});
});

/**
 * The integration inbox push: `sourceUrl` becomes a link in the member's
 * Inbox, so anything but an absolute https URL without credentials dies here
 * (and again in the web's `safeHttpsUrl`).
 */
describe('isSafeInboxSourceUrl', () => {
	it('accepts an absolute https URL, fragments and queries included', () => {
		for (const url of [
			'https://app.gauzy.co/#/pages/inbox/1',
			'https://app.gauzy.co/inbox?id=1&tab=all',
			'HTTPS://app.gauzy.co/inbox'
		]) {
			expect([url, isSafeInboxSourceUrl(url)]).toEqual([url, true]);
		}
	});

	it('refuses every other scheme, relative URLs, credentials, whitespace and the oversize', () => {
		for (const url of [
			'http://app.gauzy.co/inbox/1',
			'javascript:alert(1)',
			' javascript:alert(1)',
			'jAvAsCrIpT:alert(1)',
			'data:text/html,<b>x</b>',
			'vbscript:msgbox(1)',
			'file:///etc/passwd',
			'//app.gauzy.co/inbox',
			'/inbox/1',
			'https://user:pass@app.gauzy.co/',
			'https://user@app.gauzy.co/',
			'https://app.gauzy.co/a b',
			'https://app.gauzy.co/\tinbox',
			'https://app.gauzy.co/\u0000',
			`https://app.gauzy.co/${'a'.repeat(2000)}`,
			'',
			null,
			42
		]) {
			expect([url, isSafeInboxSourceUrl(url)]).toEqual([url, false]);
		}
	});
});

describe('normalizeInboxEmailMeta', () => {
	it('keeps the four fields, trimmed and capped, and drops the rest', () => {
		expect(
			normalizeInboxEmailMeta({
				from: '  Billing <billing@example.com> ',
				to: '',
				subject: ' Invoice #42 ',
				receivedAt: '2026-10-28T09:00:00Z',
				html: '<script>x</script>'
			})
		).toEqual({
			from: 'Billing <billing@example.com>',
			to: null,
			subject: 'Invoice #42',
			receivedAt: '2026-10-28T09:00:00Z'
		});
		expect(normalizeInboxEmailMeta({ from: 'a', subject: 'x'.repeat(400), receivedAt: '' })?.subject).toHaveLength(
			300
		);
	});

	it('answers null without a sender or a subject', () => {
		for (const value of [null, 'x', [], { from: 'a' }, { subject: 's' }, { from: ' ', subject: 's' }]) {
			expect(normalizeInboxEmailMeta(value)).toBeNull();
		}
	});
});

/**
 * `normalizeInboxSourceMeta` guards the one column a FLEET NODE indirectly
 * feeds (through the reconciler): the chips the Inbox renders next to a
 * fleet question. Same trust posture as the options: declared string
 * fields only, trimmed, capped, nothing else stored.
 */
describe('normalizeInboxSourceMeta', () => {
	it('returns null for non-objects, empty objects and all-blank fields', () => {
		expect(normalizeInboxSourceMeta(undefined)).toBeNull();
		expect(normalizeInboxSourceMeta(null)).toBeNull();
		expect(normalizeInboxSourceMeta('node-1')).toBeNull();
		expect(normalizeInboxSourceMeta(['node-1'])).toBeNull();
		expect(normalizeInboxSourceMeta({})).toBeNull();
		expect(normalizeInboxSourceMeta({ nodeId: '   ', branch: '', taskTitle: null, prUrl: undefined })).toBeNull();
	});

	it('keeps the six declared fields and drops unknown keys', () => {
		expect(
			normalizeInboxSourceMeta({
				nodeId: 'node-1',
				nodeName: 'everdesk2',
				branch: 'task/tsk-1',
				taskTitle: 'Fix the thing',
				prUrl: 'https://github.com/ever-works/ever-works/pull/1',
				mountDir: 'template',
				userId: 'smuggled',
				agentRunId: 'smuggled'
			})
		).toEqual({
			nodeId: 'node-1',
			nodeName: 'everdesk2',
			branch: 'task/tsk-1',
			taskTitle: 'Fix the thing',
			prUrl: 'https://github.com/ever-works/ever-works/pull/1',
			mountDir: 'template'
		});
	});

	it('trims every field, slices it to the cap and ignores non-strings', () => {
		const result = normalizeInboxSourceMeta({
			nodeName: '  everdesk2  ',
			taskTitle: 't'.repeat(INBOX_SOURCE_META_MAX_FIELD_CHARS + 50),
			branch: 42,
			prUrl: { href: 'x' }
		});
		expect(result).toEqual({
			nodeName: 'everdesk2',
			taskTitle: 't'.repeat(INBOX_SOURCE_META_MAX_FIELD_CHARS)
		});
		expect(Object.keys(result!)).toEqual(['nodeName', 'taskTitle']);
	});

	it('is idempotent — normalizing its own output changes nothing', () => {
		const once = normalizeInboxSourceMeta({ nodeId: 'n', branch: 'b' });
		expect(normalizeInboxSourceMeta(once)).toEqual(once);
	});
});
