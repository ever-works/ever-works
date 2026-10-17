import { describe, expect, it } from 'vitest';
import {
	EMAIL_MESSAGE_ID_MAX_LENGTH,
	EMAIL_REFERENCES_MAX_IDS,
	normalizeMessageId,
	parseMessageIdList
} from '../capabilities/email-provider.interface.js';

/**
 * EW-P4-3 — RFC threading helpers. Every plugin parses its provider's
 * `Message-ID` / `In-Reply-To` / `References` through these, and the
 * dispatcher compares the bare ids they produce, so an id must normalize to
 * the same string whichever way a provider or client wrote it.
 */
describe('normalizeMessageId', () => {
	it.each([
		['<abc@example.com>', 'abc@example.com'],
		['  <abc@example.com>  ', 'abc@example.com'],
		['abc@example.com', 'abc@example.com'],
		['<abc@example.com> (comment)', 'abc@example.com'],
		['<abc@example.com', 'abc@example.com']
	])('normalizes %j to %j', (raw, expected) => {
		expect(normalizeMessageId(raw)).toBe(expected);
	});

	it.each([[''], ['   '], ['<>'], ['<a b@c>'], ['<a\r\nb@c>'], [undefined], [null]])(
		'answers undefined for %j',
		(raw) => {
			expect(normalizeMessageId(raw as string | undefined)).toBeUndefined();
		}
	);

	it('refuses an over-long id instead of truncating it', () => {
		const long = `${'a'.repeat(EMAIL_MESSAGE_ID_MAX_LENGTH)}@x`;
		expect(normalizeMessageId(`<${long}>`)).toBeUndefined();
		const fits = `${'a'.repeat(EMAIL_MESSAGE_ID_MAX_LENGTH - 2)}@x`;
		expect(normalizeMessageId(`<${fits}>`)).toBe(fits);
	});

	it('stays linear on a long run of unclosed brackets (sender-written header)', () => {
		const hostile = '<'.repeat(200_000);
		const started = Date.now();
		expect(normalizeMessageId(hostile)).toBeUndefined();
		expect(Date.now() - started).toBeLessThan(1000);
	});
});

describe('parseMessageIdList', () => {
	it('reads bracketed ids in header order', () => {
		expect(parseMessageIdList('<a@x> <b@x>\r\n <c@x>')).toEqual(['a@x', 'b@x', 'c@x']);
	});

	it('accepts an unbracketed, comma- or space-separated list', () => {
		expect(parseMessageIdList('a@x, b@x c@x')).toEqual(['a@x', 'b@x', 'c@x']);
	});

	it('accepts several header values', () => {
		expect(parseMessageIdList(['<a@x>', '<b@x>'])).toEqual(['a@x', 'b@x']);
	});

	it('de-duplicates and keeps the newest ids when over the cap', () => {
		const many = Array.from({ length: EMAIL_REFERENCES_MAX_IDS + 5 }, (_, i) => `<id${i}@x>`);
		const parsed = parseMessageIdList(['<id0@x>', ...many].join(' '));
		expect(parsed).toHaveLength(EMAIL_REFERENCES_MAX_IDS);
		expect(parsed[parsed.length - 1]).toBe(`id${EMAIL_REFERENCES_MAX_IDS + 4}@x`);
		expect(new Set(parsed).size).toBe(parsed.length);
	});

	it('answers [] for nothing', () => {
		expect(parseMessageIdList(undefined)).toEqual([]);
		expect(parseMessageIdList('')).toEqual([]);
		expect(parseMessageIdList('<>')).toEqual([]);
	});
});
