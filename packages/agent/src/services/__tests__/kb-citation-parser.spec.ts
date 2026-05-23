import { parseKbCitations, type KbCitation } from '../kb-citation-parser';

describe('parseKbCitations', () => {
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

    describe('single citation (canonical whitelist classes)', () => {
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
            // Slice invariant.
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

        it('accepts mid-slug dots (version-style references survive)', () => {
            const out = parseKbCitations('kb:research/v2.1_final-draft');
            expect(out).toHaveLength(1);
            expect(out[0].slug).toBe('research/v2.1_final-draft'.split('/')[1]);
            // The grammar puts the entire slug capture (after the first `/`)
            // into `slug`, so version-style intra-slug dots survive.
            expect(out[0].slug).toBe('v2.1_final-draft');
        });

        it('accepts nested-path slugs (slug allows internal `/`)', () => {
            const out = parseKbCitations('see kb:brand/voice/lighthearted');
            expect(out).toHaveLength(1);
            expect(out[0].cls).toBe('brand');
            expect(out[0].slug).toBe('voice/lighthearted');
        });
    });

    describe('multiple citations', () => {
        it('extracts every citation in textual order with correct offsets', () => {
            const text = 'compare kb:brand/voice and kb:legal/terms please';
            const out = parseKbCitations(text);
            expect(out).toHaveLength(2);
            expect(out.map((c) => c.slug)).toEqual(['voice', 'terms']);
            expect(out[0].endOffset).toBeLessThan(out[1].startOffset);
            for (const c of out) {
                expect(text.slice(c.startOffset, c.endOffset)).toBe(c.raw);
            }
        });

        it('reports adjacent citations (whitespace-separated) independently', () => {
            const out = parseKbCitations('kb:brand/a kb:legal/b kb:style/c');
            expect(out.map((c) => `${c.cls}/${c.slug}`)).toEqual(['brand/a', 'legal/b', 'style/c']);
        });

        it('reports the same (cls, slug) cited multiple times as separate matches', () => {
            // Dedup is the consumer's responsibility (row 35b's resolver
            // groups by doc id). The parser stays faithful to source
            // textual order.
            const out = parseKbCitations('first kb:brand/voice then later kb:brand/voice');
            expect(out).toHaveLength(2);
            expect(out[0].startOffset).not.toBe(out[1].startOffset);
        });
    });

    describe('rejects non-citations + class whitelist', () => {
        it('REJECTS `@kb:` mentions (those are row 34a, not row 35a)', () => {
            // The leading `@` is the user-input mention marker; the
            // hover-card is for the bare assistant-side `kb:` token only.
            expect(parseKbCitations('@kb:brand/voice')).toEqual([]);
            expect(parseKbCitations('see @kb:brand/voice please')).toEqual([]);
        });

        it('REJECTS classes outside KB_DOCUMENT_CLASSES whitelist', () => {
            // Hallucinated classes from a confused LLM shouldn't surface
            // in the hover-card UI.
            expect(parseKbCitations('kb:knowledge/foo')).toEqual([]);
            expect(parseKbCitations('kb:nonexistent/whatever')).toEqual([]);
            expect(parseKbCitations('kb:BRAND/voice')).toEqual([]); // case-sensitive
        });

        it('REJECTS `kb:` glued to a word character (whole-token boundary)', () => {
            // Lookbehind blocks word-char (letter / digit / underscore)
            // immediately before `kb:` so we don't match inside the
            // middle of a token. Punctuation like `.` or `/` is fine
            // (URL fragments + sentence-final still produce citations).
            expect(parseKbCitations('user1kb:brand/voice')).toEqual([]);
            expect(parseKbCitations('abckb:brand/voice')).toEqual([]);
            expect(parseKbCitations('Akb:brand/voice')).toEqual([]);
            expect(parseKbCitations('_kb:brand/voice')).toEqual([]);
        });

        it('ACCEPTS `kb:` preceded by punctuation or whitespace or start-of-string', () => {
            expect(parseKbCitations('kb:brand/voice')).toHaveLength(1);
            expect(parseKbCitations(' kb:brand/voice')).toHaveLength(1);
            expect(parseKbCitations('(kb:brand/voice)')).toHaveLength(1);
            // `.` is not a word char — matches (sentence-final period
            // edge case + URL paths both produce citations).
            expect(parseKbCitations('.kb:brand/voice')).toHaveLength(1);
            // `/` likewise — common in URLs and the LLM might emit
            // `see /kb:brand/voice` style references.
            expect(parseKbCitations('/kb:brand/voice')).toHaveLength(1);
        });

        it('REJECTS `kb:` without a slug (class-only)', () => {
            expect(parseKbCitations('kb:brand')).toEqual([]);
            expect(parseKbCitations('kb:brand/')).toEqual([]);
        });
    });

    describe('punctuation handling', () => {
        it('strips trailing period from the slug (sentence-final)', () => {
            const out = parseKbCitations('See kb:brand/voice.');
            expect(out).toHaveLength(1);
            expect(out[0].slug).toBe('voice');
            expect(out[0].raw).toBe('kb:brand/voice');
        });

        it('strips trailing comma + semicolon + question mark / etc.', () => {
            const cases: Array<[string, string]> = [
                ['kb:brand/voice,', 'voice'],
                ['kb:brand/voice;', 'voice'],
                ['kb:brand/voice!', 'voice'],
                ['kb:brand/voice?', 'voice'],
                ['kb:brand/voice"', 'voice'],
                ['(kb:brand/voice)', 'voice'],
            ];
            for (const [text, expectedSlug] of cases) {
                const out = parseKbCitations(text);
                expect(out).toHaveLength(1);
                expect(out[0].slug).toBe(expectedSlug);
            }
        });

        it('preserves mid-slug dots even when trailing dot is stripped', () => {
            const out = parseKbCitations('see kb:research/v2.1.');
            expect(out).toHaveLength(1);
            expect(out[0].slug).toBe('v2.1');
        });
    });

    describe('determinism + immutability', () => {
        it('returns a fresh array on each call', () => {
            const a = parseKbCitations('kb:brand/voice');
            const b = parseKbCitations('kb:brand/voice');
            expect(a).not.toBe(b);
            expect(a).toEqual(b);
        });

        it('multiple calls on the same text yield identical results (no regex.lastIndex leak)', () => {
            const text = 'kb:brand/a kb:legal/b kb:style/c';
            const first = parseKbCitations(text);
            const second = parseKbCitations(text);
            const third = parseKbCitations(text);
            expect(first).toEqual(second);
            expect(second).toEqual(third);
            expect(first.map((c: KbCitation) => `${c.cls}/${c.slug}`)).toEqual([
                'brand/a',
                'legal/b',
                'style/c',
            ]);
        });
    });

    describe('multiline + realistic outputs', () => {
        it('extracts citations across multiple lines', () => {
            const text =
                'For the headline tone, see kb:brand/voice.\n' +
                'For the legal copy, check kb:legal/disclaimer.\n' +
                'For style: kb:style/headlines.';
            const out = parseKbCitations(text);
            expect(out.map((c) => `${c.cls}/${c.slug}`)).toEqual([
                'brand/voice',
                'legal/disclaimer',
                'style/headlines',
            ]);
            for (const c of out) {
                expect(text.slice(c.startOffset, c.endOffset)).toBe(c.raw);
            }
        });

        it('handles a realistic assistant message with mixed cited + un-cited prose', () => {
            const msg =
                "Sure — I'll draft the headline using kb:brand/voice for tone " +
                'and double-check the disclaimer wording against kb:legal/disclaimer. ' +
                'I drew the title-case rule from kb:style/headlines.';
            const out = parseKbCitations(msg);
            expect(out.map((c) => `${c.cls}/${c.slug}`)).toEqual([
                'brand/voice',
                'legal/disclaimer',
                'style/headlines',
            ]);
        });
    });
});
