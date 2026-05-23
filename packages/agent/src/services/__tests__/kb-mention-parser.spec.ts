import { parseKbMentions, type KbMention } from '../kb-mention-parser';

describe('parseKbMentions', () => {
    describe('boundary cases', () => {
        it('returns [] for empty string', () => {
            expect(parseKbMentions('')).toEqual([]);
        });

        it('returns [] for whitespace-only input', () => {
            expect(parseKbMentions('   \n\t  ')).toEqual([]);
        });

        it('returns [] when there are no mentions', () => {
            expect(parseKbMentions('just a normal message without mentions')).toEqual([]);
        });

        it('returns [] for non-string input (defensive)', () => {
            // The signature is `string`, but JS callers might pass null/undefined.
            // The function should defensively return [] rather than throw.
            expect(parseKbMentions(null as unknown as string)).toEqual([]);
            expect(parseKbMentions(undefined as unknown as string)).toEqual([]);
        });
    });

    describe('single mention', () => {
        it('extracts a bare slug reference at start of message', () => {
            const out = parseKbMentions('@kb:voice please summarise');
            expect(out).toHaveLength(1);
            expect(out[0]).toMatchObject({
                raw: '@kb:voice',
                reference: 'voice',
                startOffset: 0,
                endOffset: 9,
            });
        });

        it('extracts a class/slug path reference (row 31 citation format)', () => {
            const out = parseKbMentions('check @kb:brand/voice for tone');
            expect(out).toHaveLength(1);
            expect(out[0]).toMatchObject({
                raw: '@kb:brand/voice',
                reference: 'brand/voice',
            });
            const { startOffset, endOffset, raw } = out[0];
            expect('check @kb:brand/voice for tone'.slice(startOffset, endOffset)).toBe(raw);
        });

        it('accepts kebab-case + dots + underscores in references', () => {
            const out = parseKbMentions('@kb:research/v2.1_final-draft');
            expect(out).toHaveLength(1);
            expect(out[0].reference).toBe('research/v2.1_final-draft');
        });

        it('extracts a UUID-style id reference', () => {
            const id = '00000000-0000-0000-0000-000000000001';
            const out = parseKbMentions(`see @kb:${id}`);
            expect(out).toHaveLength(1);
            expect(out[0].reference).toBe(id);
        });
    });

    describe('multiple mentions', () => {
        it('extracts every mention in textual order with correct offsets', () => {
            const text = 'compare @kb:brand/voice and @kb:legal/terms please';
            const out = parseKbMentions(text);
            expect(out).toHaveLength(2);
            expect(out[0].reference).toBe('brand/voice');
            expect(out[1].reference).toBe('legal/terms');
            // Offsets are in left-to-right order and slice back to raw.
            expect(out[0].endOffset).toBeLessThan(out[1].startOffset);
            expect(text.slice(out[0].startOffset, out[0].endOffset)).toBe(out[0].raw);
            expect(text.slice(out[1].startOffset, out[1].endOffset)).toBe(out[1].raw);
        });

        it('reports adjacent (whitespace-separated) mentions independently', () => {
            const out = parseKbMentions('@kb:a @kb:b @kb:c');
            expect(out.map((m) => m.reference)).toEqual(['a', 'b', 'c']);
        });

        it("reports repeated references separately (dedup is row 34b's job)", () => {
            const out = parseKbMentions('@kb:voice ... @kb:voice');
            expect(out).toHaveLength(2);
            expect(out[0].reference).toBe('voice');
            expect(out[1].reference).toBe('voice');
            expect(out[0].startOffset).not.toBe(out[1].startOffset);
        });
    });

    describe('punctuation + boundary handling', () => {
        it('does NOT include trailing comma/period in the reference', () => {
            const out = parseKbMentions('see @kb:voice, then @kb:legal.');
            expect(out).toHaveLength(2);
            expect(out[0].reference).toBe('voice');
            expect(out[1].reference).toBe('legal');
        });

        it('does NOT include trailing closing paren / bracket / brace', () => {
            const cases: Array<[string, string]> = [
                ['(@kb:voice)', 'voice'],
                ['[@kb:voice]', 'voice'],
                ['{@kb:voice}', 'voice'],
            ];
            for (const [text, expectedRef] of cases) {
                const out = parseKbMentions(text);
                expect(out).toHaveLength(1);
                expect(out[0].reference).toBe(expectedRef);
            }
        });

        it('does NOT include trailing quote / colon / semicolon / exclaim / question', () => {
            const cases: Array<[string, string]> = [
                ['@kb:voice"', 'voice'],
                ["@kb:voice'", 'voice'],
                ['@kb:voice:', 'voice'],
                ['@kb:voice;', 'voice'],
                ['@kb:voice!', 'voice'],
                ['@kb:voice?', 'voice'],
            ];
            for (const [text, expectedRef] of cases) {
                const out = parseKbMentions(text);
                expect(out).toHaveLength(1);
                expect(out[0].reference).toBe(expectedRef);
            }
        });

        it('does NOT match `@kb:` when preceded by a word character (whole-word boundary)', () => {
            // The lookbehind prevents matches inside the middle of words
            // like email-fragments or URL-paths.
            expect(parseKbMentions('foo@kb:bar')).toEqual([]);
            expect(parseKbMentions('user1@kb:something')).toEqual([]);
            expect(parseKbMentions('A@kb:bar')).toEqual([]);
        });

        it('matches `@kb:` when preceded by punctuation or whitespace or start-of-string', () => {
            expect(parseKbMentions('@kb:bar')).toHaveLength(1);
            expect(parseKbMentions(' @kb:bar')).toHaveLength(1);
            expect(parseKbMentions('(@kb:bar')).toHaveLength(1);
            expect(parseKbMentions('.@kb:bar')).toHaveLength(1);
        });

        it('requires the reference to immediately follow `@kb:` (no space)', () => {
            expect(parseKbMentions('@kb: voice')).toEqual([]);
            expect(parseKbMentions('@kb:  brand/voice')).toEqual([]);
        });

        it('does NOT match `@kb` without the trailing colon', () => {
            expect(parseKbMentions('@kb voice')).toEqual([]);
            expect(parseKbMentions('@kb-voice')).toEqual([]);
        });
    });

    describe('determinism + immutability', () => {
        it('returns a fresh array on each call (no shared mutable state)', () => {
            const a = parseKbMentions('@kb:voice');
            const b = parseKbMentions('@kb:voice');
            expect(a).not.toBe(b);
            expect(a).toEqual(b);
        });

        it('multiple calls on the same text yield identical results (no regex.lastIndex leak)', () => {
            const text = '@kb:a @kb:b @kb:c';
            const first = parseKbMentions(text);
            const second = parseKbMentions(text);
            const third = parseKbMentions(text);
            expect(first).toEqual(second);
            expect(second).toEqual(third);
            expect(first.map((m: KbMention) => m.reference)).toEqual(['a', 'b', 'c']);
        });
    });

    describe('multiline + larger inputs', () => {
        it('extracts mentions across multiple lines', () => {
            const text =
                'first line mentions @kb:brand/voice\n' +
                'second line skips it\n' +
                'third has @kb:legal/terms';
            const out = parseKbMentions(text);
            expect(out.map((m) => m.reference)).toEqual(['brand/voice', 'legal/terms']);
        });

        it('handles a realistic conversation message with mixed content', () => {
            const msg =
                'Hey — when you write the headline, please use @kb:brand/voice ' +
                'for tone and double-check the disclaimer wording against @kb:legal/disclaimer. ' +
                'Also see @kb:style/headlines for the title-case rule.';
            const out = parseKbMentions(msg);
            expect(out.map((m) => m.reference)).toEqual([
                'brand/voice',
                'legal/disclaimer',
                'style/headlines',
            ]);
            // Every offset slices back to its `raw`.
            for (const m of out) {
                expect(msg.slice(m.startOffset, m.endOffset)).toBe(m.raw);
            }
        });
    });
});
