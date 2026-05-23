import { describe, expect, it } from 'vitest';
import { parseKbCitations, type KbCitation } from './parse-kb-citations';

describe('parseKbCitations (web port — row 35d)', () => {
    describe('boundary cases', () => {
        it('returns [] for empty string', () => {
            expect(parseKbCitations('')).toEqual([]);
        });

        it('returns [] for whitespace-only input', () => {
            expect(parseKbCitations('   \n\t  ')).toEqual([]);
        });

        it('returns [] when there are no citations', () => {
            expect(parseKbCitations('the assistant says hello, no citations here')).toEqual([]);
        });

        it('returns [] for non-string input (defensive)', () => {
            expect(parseKbCitations(null as unknown as string)).toEqual([]);
            expect(parseKbCitations(undefined as unknown as string)).toEqual([]);
        });
    });

    describe('single citation (canonical whitelist)', () => {
        it('extracts a citation at start of message', () => {
            const out = parseKbCitations('kb:brand/voice is the source');
            expect(out).toHaveLength(1);
            expect(out[0]).toMatchObject({
                raw: 'kb:brand/voice',
                cls: 'brand',
                slug: 'voice',
                startOffset: 0,
                endOffset: 14,
            });
        });

        it('extracts a citation with class/slug in the middle of prose', () => {
            const text = 'See kb:brand/voice for tone guidance.';
            const out = parseKbCitations(text);
            expect(out).toHaveLength(1);
            expect(out[0].cls).toBe('brand');
            expect(out[0].slug).toBe('voice');
            expect(text.slice(out[0].startOffset, out[0].endOffset)).toBe(out[0].raw);
        });

        it.each([
            ['brand', 'voice'],
            ['legal', 'terms'],
            ['seo', 'meta'],
            ['style', 'headlines'],
            ['glossary', 'jargon'],
            ['competitors', 'list'],
            ['personas', 'icp'],
            ['research', 'q1-2026'],
            ['output', 'report-v1'],
            ['freeform', 'notes'],
        ])('accepts canonical class "%s" with slug "%s"', (cls, slug) => {
            const out = parseKbCitations(`kb:${cls}/${slug}`);
            expect(out).toHaveLength(1);
            expect(out[0].cls).toBe(cls);
            expect(out[0].slug).toBe(slug);
        });

        it('accepts nested-path slugs (e.g. research/v2.1/draft)', () => {
            const out = parseKbCitations('kb:research/v2.1/draft says so');
            expect(out).toHaveLength(1);
            expect(out[0].slug).toBe('v2.1/draft');
        });
    });

    describe('multiple citations', () => {
        it('extracts every citation in textual order', () => {
            const text = 'see kb:brand/voice and kb:legal/terms together';
            const out = parseKbCitations(text);
            expect(out).toHaveLength(2);
            expect(out[0].cls).toBe('brand');
            expect(out[1].cls).toBe('legal');
            expect(out[0].startOffset).toBeLessThan(out[1].startOffset);
        });

        it('handles back-to-back citations separated by punctuation', () => {
            const out = parseKbCitations('kb:brand/voice, kb:legal/terms.');
            expect(out).toHaveLength(2);
        });

        it('handles citations of the same doc multiple times (no parser dedup)', () => {
            const out = parseKbCitations('kb:brand/voice ... kb:brand/voice again');
            expect(out).toHaveLength(2);
        });
    });

    describe('rejection paths', () => {
        it('rejects @kb: prefix (that is row 34a mention syntax, not citation)', () => {
            const out = parseKbCitations('see @kb:brand/voice please');
            expect(out).toEqual([]);
        });

        it('rejects unknown class names (hallucinated by LLM)', () => {
            const out = parseKbCitations('kb:unknown/whatever and kb:bogus/x');
            expect(out).toEqual([]);
        });

        it('rejects word-char prefixes (acme/kb:foo is part of a longer token)', () => {
            const out = parseKbCitations('user1kb:brand/voice');
            expect(out).toEqual([]);
        });

        it('rejects citations where the slug starts with whitespace', () => {
            const out = parseKbCitations('kb:brand/ voice');
            expect(out).toEqual([]);
        });
    });

    describe('accept paths (non-word prefixes)', () => {
        it('accepts citations after `.` / `/` / start-of-string / whitespace / paren', () => {
            const accepts = [
                'kb:brand/voice', // start
                '.kb:brand/voice', // dot
                '/kb:brand/voice', // slash
                ' kb:brand/voice', // space
                '(kb:brand/voice', // open paren
            ];
            for (const text of accepts) {
                const out = parseKbCitations(text);
                expect(out).toHaveLength(1);
                expect(out[0].cls).toBe('brand');
            }
        });
    });

    describe('trailing punctuation handling', () => {
        it('strips trailing `.` from the slug (sentence-final period)', () => {
            const text = 'see kb:brand/voice.';
            const out = parseKbCitations(text);
            expect(out).toHaveLength(1);
            expect(out[0].slug).toBe('voice');
            // Citation starts at index 4 (after "see ") and runs for
            // `kb:brand/voice`.length (14 chars). The trailing period
            // gets stripped, so the endOffset stops at the period — not
            // past it.
            expect(out[0].startOffset).toBe(4);
            expect(out[0].endOffset).toBe(4 + 'kb:brand/voice'.length);
            expect(text.slice(out[0].startOffset, out[0].endOffset)).toBe('kb:brand/voice');
        });

        it('strips trailing `-` / `_` / `/`', () => {
            const out = parseKbCitations(
                'see kb:brand/voice- and kb:legal/terms_ and kb:seo/meta/',
            );
            expect(out).toHaveLength(3);
            expect(out[0].slug).toBe('voice');
            expect(out[1].slug).toBe('terms');
            expect(out[2].slug).toBe('meta');
        });

        it('preserves mid-slug dots (versioned slugs)', () => {
            const out = parseKbCitations('see kb:research/v2.1 today');
            expect(out).toHaveLength(1);
            expect(out[0].slug).toBe('v2.1');
        });
    });

    describe('determinism', () => {
        it('returns identical results on repeated calls', () => {
            const text = 'kb:brand/voice and kb:legal/terms.';
            const a: KbCitation[] = parseKbCitations(text);
            const b: KbCitation[] = parseKbCitations(text);
            expect(a).toEqual(b);
        });

        it('slice invariant — text.slice(start, end) === raw for every match', () => {
            const text = '... kb:brand/voice, kb:research/v2.1, kb:legal/terms.';
            const out = parseKbCitations(text);
            for (const c of out) {
                expect(text.slice(c.startOffset, c.endOffset)).toBe(c.raw);
            }
        });
    });

    describe('multiline + realistic', () => {
        it('extracts citations across newlines', () => {
            const text = 'first line kb:brand/voice\nsecond line kb:legal/terms';
            const out = parseKbCitations(text);
            expect(out).toHaveLength(2);
        });

        it('handles a realistic assistant message with markdown + citations', () => {
            const text = [
                'According to our **brand voice** guide (kb:brand/voice), we should be friendly.',
                '',
                'For the legal disclaimer, see kb:legal/terms.',
                '',
                'And the research from Q1 is at kb:research/q1-2026.',
            ].join('\n');
            const out = parseKbCitations(text);
            expect(out).toHaveLength(3);
            expect(out.map((c) => c.slug)).toEqual(['voice', 'terms', 'q1-2026']);
        });
    });
});
