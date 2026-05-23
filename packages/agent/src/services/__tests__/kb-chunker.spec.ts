import { chunkMarkdown } from '../kb-chunker';

describe('chunkMarkdown', () => {
    describe('boundary cases', () => {
        it('returns [] for empty input', () => {
            expect(chunkMarkdown('')).toEqual([]);
        });

        it('returns [] for whitespace-only input', () => {
            expect(chunkMarkdown('   \n\n\t\n')).toEqual([]);
        });

        it('throws on non-positive maxTokens', () => {
            expect(() => chunkMarkdown('hi', { maxTokens: 0 })).toThrow(RangeError);
            expect(() => chunkMarkdown('hi', { maxTokens: -1 })).toThrow(RangeError);
        });

        it('throws on overlap >= maxTokens', () => {
            expect(() => chunkMarkdown('hi', { maxTokens: 10, overlap: 10 })).toThrow(RangeError);
            expect(() => chunkMarkdown('hi', { maxTokens: 10, overlap: 11 })).toThrow(RangeError);
        });

        it('throws on negative overlap', () => {
            expect(() => chunkMarkdown('hi', { overlap: -1 })).toThrow(RangeError);
        });
    });

    describe('single-section bodies (no H2/H3)', () => {
        it('returns one chunk with undefined headingPath when no H2/H3 present', () => {
            const body = 'just some prose\nacross a couple lines\n';
            const chunks = chunkMarkdown(body);
            expect(chunks).toHaveLength(1);
            expect(chunks[0]).toEqual({
                index: 0,
                content: body,
                headingPath: undefined,
                charStart: 0,
                charEnd: body.length,
            });
        });

        it('treats H1 as content (not a split point)', () => {
            const body = '# The Title\n\nSome intro text under the H1.\n';
            const chunks = chunkMarkdown(body);
            expect(chunks).toHaveLength(1);
            expect(chunks[0].headingPath).toBeUndefined();
            expect(chunks[0].content).toBe(body);
        });
    });

    describe('heading-aware splits', () => {
        it('splits at H2 boundaries and attaches headingPath', () => {
            const body = '# Title\nintro paragraph\n\n## Brand voice\nbody A\n\n## Legal\nbody B\n';
            const chunks = chunkMarkdown(body);
            expect(chunks).toHaveLength(3);
            // Leading section before any H2: no headingPath
            expect(chunks[0].headingPath).toBeUndefined();
            expect(chunks[0].content).toContain('# Title');
            expect(chunks[0].content).toContain('intro paragraph');
            // Each H2 gets its own chunk including the heading line.
            expect(chunks[1].headingPath).toEqual(['Brand voice']);
            expect(chunks[1].content.startsWith('## Brand voice')).toBe(true);
            expect(chunks[1].content).toContain('body A');
            expect(chunks[2].headingPath).toEqual(['Legal']);
            expect(chunks[2].content.startsWith('## Legal')).toBe(true);
            expect(chunks[2].content).toContain('body B');
        });

        it('nests H3 under the active H2 in headingPath', () => {
            const body =
                '## Brand voice\nintro\n\n### Examples\nexample A\n\n### Counterexamples\nexample B\n\n## Legal\nlegal text\n';
            const chunks = chunkMarkdown(body);
            // Sections: H2 Brand voice (intro), H3 Examples, H3 Counterexamples,
            // H2 Legal — 4 chunks.
            expect(chunks).toHaveLength(4);
            expect(chunks[0].headingPath).toEqual(['Brand voice']);
            expect(chunks[1].headingPath).toEqual(['Brand voice', 'Examples']);
            expect(chunks[2].headingPath).toEqual(['Brand voice', 'Counterexamples']);
            expect(chunks[3].headingPath).toEqual(['Legal']);
        });

        it('clears the H3 from headingPath when a new H2 opens', () => {
            const body = '## A\nbody\n\n### A1\nbody\n\n## B\nbody under B without any H3\n';
            const chunks = chunkMarkdown(body);
            expect(chunks).toHaveLength(3);
            expect(chunks[0].headingPath).toEqual(['A']);
            expect(chunks[1].headingPath).toEqual(['A', 'A1']);
            // H3 must NOT leak into the next H2's section.
            expect(chunks[2].headingPath).toEqual(['B']);
        });

        it('treats H3 without a preceding H2 as a top-level heading', () => {
            const body = '### Loose H3\nbody under loose H3\n';
            const chunks = chunkMarkdown(body);
            expect(chunks).toHaveLength(1);
            expect(chunks[0].headingPath).toEqual(['Loose H3']);
        });
    });

    describe('fenced code block masking', () => {
        it('ignores ## inside a backtick fence', () => {
            const body = [
                '## Real heading',
                'body',
                '',
                '```ts',
                '// the next line LOOKS like a heading but is in code',
                '## not a heading',
                '```',
                'still in Real heading section',
                '',
            ].join('\n');
            const chunks = chunkMarkdown(body);
            // One chunk only — the fenced `## not a heading` must not
            // open a new section.
            expect(chunks).toHaveLength(1);
            expect(chunks[0].headingPath).toEqual(['Real heading']);
            expect(chunks[0].content).toContain('## not a heading');
            expect(chunks[0].content).toContain('still in Real heading section');
        });

        it('ignores ### inside a tilde fence', () => {
            const body = ['~~~markdown', '### nope', '~~~', '## actual heading', 'body'].join('\n');
            const chunks = chunkMarkdown(body);
            // Sections: leading body (fenced block has no heading) + H2.
            expect(chunks.map((c) => c.headingPath)).toEqual([undefined, ['actual heading']]);
        });

        it('does not close a backtick fence with tildes', () => {
            const body = ['```', '## fake heading', '~~~', 'still in fence', '```'].join('\n');
            const chunks = chunkMarkdown(body);
            // Everything between the ``` markers is a single block; no headings.
            expect(chunks).toHaveLength(1);
            expect(chunks[0].headingPath).toBeUndefined();
        });
    });

    describe('sliding window fallback', () => {
        it('subdivides an oversized section with overlap', () => {
            // 600 chars ≈ 150 tokens. With maxTokens=40 (160 chars window)
            // and overlap=10 (40 char overlap, step 120 chars), expect
            // multiple chunks.
            const body = '## Big section\n' + 'a'.repeat(600);
            const chunks = chunkMarkdown(body, { maxTokens: 40, overlap: 10 });
            expect(chunks.length).toBeGreaterThan(1);

            // Every chunk inherits the section's headingPath.
            for (const c of chunks) expect(c.headingPath).toEqual(['Big section']);

            // Chunks step forward by (40-10)*4 = 120 chars but window
            // size is 40*4 = 160 chars — so chunks[1].charStart should
            // be chunks[0].charStart + 120 and they should overlap by
            // 40 chars.
            const step = chunks[1].charStart - chunks[0].charStart;
            expect(step).toBe(120);
            const overlap = chunks[0].charEnd - chunks[1].charStart;
            expect(overlap).toBe(40);

            // Last chunk's charEnd must equal the section's actual end.
            const last = chunks[chunks.length - 1];
            expect(last.charEnd).toBe(body.length);
        });

        it('keeps each sub-chunk under the cap', () => {
            const body = '## Big\n' + 'x'.repeat(2_000);
            const chunks = chunkMarkdown(body, { maxTokens: 50, overlap: 5 });
            for (const c of chunks) {
                // window = 50 * 4 = 200 chars; final chunk may be shorter.
                expect(c.content.length).toBeLessThanOrEqual(200);
            }
        });

        it('preserves a small section verbatim alongside an oversized neighbour', () => {
            const small = '## Small\nshort body\n';
            const huge = '## Huge\n' + 'y'.repeat(4_000);
            const body = small + huge;
            const chunks = chunkMarkdown(body, { maxTokens: 50, overlap: 5 });
            // First chunk is the small section as a single chunk.
            expect(chunks[0].headingPath).toEqual(['Small']);
            expect(chunks[0].content).toBe(small);
            // The rest are sub-chunks of the huge section.
            for (let i = 1; i < chunks.length; i++) {
                expect(chunks[i].headingPath).toEqual(['Huge']);
            }
            expect(chunks.length).toBeGreaterThan(2);
        });
    });

    describe('offsets and ordering', () => {
        it('emits monotonically increasing index values starting at 0', () => {
            const body = '## A\n' + 'a'.repeat(200) + '\n\n## B\nB body\n';
            const chunks = chunkMarkdown(body, { maxTokens: 20, overlap: 5 });
            for (let i = 0; i < chunks.length; i++) {
                expect(chunks[i].index).toBe(i);
            }
        });

        it('charStart/charEnd reconstruct the original body for single-section docs', () => {
            const body = 'no headings here\njust prose\n';
            const [chunk] = chunkMarkdown(body);
            expect(body.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.content);
        });

        it('charStart of section N+1 equals charEnd of section N (no gaps)', () => {
            const body = '## A\nbody A\n\n## B\nbody B\n\n## C\nbody C\n';
            const chunks = chunkMarkdown(body);
            for (let i = 1; i < chunks.length; i++) {
                expect(chunks[i].charStart).toBe(chunks[i - 1].charEnd);
            }
        });
    });
});
