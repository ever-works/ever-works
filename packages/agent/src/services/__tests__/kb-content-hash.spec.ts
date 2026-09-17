import { hashNormalizedBody, normalizeBody } from '../kb-content-hash';

describe('kb-content-hash', () => {
    describe('normalizeBody', () => {
        it('collapses every whitespace run to one space and trims', () => {
            expect(normalizeBody('  # Title\n\n\tSome   text\n')).toBe('# Title Some text');
        });

        it('treats CRLF, CR and LF line endings alike', () => {
            expect(normalizeBody('a\r\nb')).toBe(normalizeBody('a\nb'));
            expect(normalizeBody('a\rb')).toBe(normalizeBody('a\nb'));
        });

        it('strips a leading byte-order mark', () => {
            expect(normalizeBody('﻿hello')).toBe('hello');
        });

        it('returns an empty string for an empty, null or undefined body', () => {
            expect(normalizeBody('')).toBe('');
            expect(normalizeBody(null)).toBe('');
            expect(normalizeBody(undefined)).toBe('');
            expect(normalizeBody(' \n\t ')).toBe('');
        });

        it('does not fold case or touch Markdown punctuation', () => {
            expect(normalizeBody('**Bold** _it_')).toBe('**Bold** _it_');
            expect(normalizeBody('Refund')).not.toBe(normalizeBody('refund'));
        });
    });

    describe('hashNormalizedBody', () => {
        it('is a 64-character hex SHA-256', () => {
            expect(hashNormalizedBody('hello')).toMatch(/^[0-9a-f]{64}$/);
        });

        it('gives reflowed text the same hash', () => {
            const original = 'When we refund,\nwhen we do not.\n\nAlways within 30 days.';
            const reflowed =
                '  When we refund, when we do not.\r\n\r\n    Always within 30 days.\n\n\n';
            expect(hashNormalizedBody(reflowed)).toBe(hashNormalizedBody(original));
        });

        it('gives a one-character change a different hash', () => {
            expect(hashNormalizedBody('Always within 30 days.')).not.toBe(
                hashNormalizedBody('Always within 31 days.'),
            );
        });

        it('gives a BOM-prefixed body the same hash as the plain body', () => {
            expect(hashNormalizedBody('﻿body')).toBe(hashNormalizedBody('body'));
        });

        it('hashes an absent body like an empty one', () => {
            expect(hashNormalizedBody(null)).toBe(hashNormalizedBody(''));
        });
    });
});
