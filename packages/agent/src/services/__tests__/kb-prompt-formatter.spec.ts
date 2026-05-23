import { formatKbContext } from '../kb-prompt-formatter';
import type { KbDocumentBodyDto } from '@ever-works/contracts';

/**
 * Test helper: build a KbDocumentBodyDto with sensible defaults; tests
 * override the bits they care about.
 */
function buildDoc(overrides: Partial<KbDocumentBodyDto> = {}): KbDocumentBodyDto {
    return {
        id: overrides.id ?? 'doc-id',
        workId: overrides.workId ?? 'work-1',
        organizationId: overrides.organizationId ?? null,
        path: overrides.path ?? 'brand/voice.md',
        slug: overrides.slug ?? 'voice',
        title: overrides.title ?? 'Brand voice',
        description: overrides.description ?? null,
        class: overrides.class ?? 'brand',
        tags: overrides.tags ?? [],
        categories: overrides.categories ?? [],
        status: overrides.status ?? 'active',
        locked: overrides.locked ?? false,
        lockMode: overrides.lockMode ?? null,
        language: overrides.language ?? 'en',
        wordCount: overrides.wordCount ?? null,
        tokenCount: overrides.tokenCount ?? null,
        source: overrides.source ?? 'user',
        sourceUploadId: overrides.sourceUploadId ?? null,
        sourceUrl: overrides.sourceUrl ?? null,
        generatedByAgentRunId: overrides.generatedByAgentRunId ?? null,
        createdById: overrides.createdById ?? null,
        updatedById: overrides.updatedById ?? null,
        createdAt: overrides.createdAt ?? '2026-05-22T00:00:00.000Z',
        updatedAt: overrides.updatedAt ?? '2026-05-22T00:00:00.000Z',
        lastCommitSha: overrides.lastCommitSha ?? null,
        body: overrides.body ?? 'default body',
        assets: overrides.assets ?? [],
    } as KbDocumentBodyDto;
}

describe('formatKbContext', () => {
    describe('boundary cases', () => {
        it('returns minimal <kb></kb> shell for empty input', () => {
            expect(formatKbContext([])).toBe('<kb>\n</kb>');
        });

        it('throws RangeError on negative maxChars', () => {
            expect(() => formatKbContext([], { maxChars: -1 })).toThrow(RangeError);
        });

        it('throws RangeError on non-finite maxChars', () => {
            expect(() => formatKbContext([], { maxChars: Number.NaN })).toThrow(RangeError);
            expect(() => formatKbContext([], { maxChars: Number.POSITIVE_INFINITY })).toThrow(
                RangeError,
            );
        });

        it('returns truncation-only shell when maxChars is too small for even the headings', () => {
            const doc = buildDoc({ title: 'A', body: 'hi' });
            const out = formatKbContext([doc], { maxChars: 5 });
            // Headings + frame can't fit → minimal shell + marker.
            expect(out).toContain('<kb>');
            expect(out).toContain('</kb>');
            expect(out).toContain('[…truncated]');
        });
    });

    describe('single-doc formatting', () => {
        it('wraps the doc with kb tags, heading, citation, and body', () => {
            const doc = buildDoc({
                title: 'Brand voice',
                slug: 'voice',
                class: 'brand',
                body: 'Friendly and direct.',
            });
            const out = formatKbContext([doc]);
            expect(out).toBe('<kb>\n## Brand voice (kb:brand/voice)\nFriendly and direct.\n</kb>');
        });

        it('includes empty body verbatim (still emits the heading)', () => {
            const doc = buildDoc({
                title: 'Empty',
                slug: 'empty',
                class: 'freeform',
                body: '',
            });
            const out = formatKbContext([doc]);
            expect(out).toContain('## Empty (kb:freeform/empty)');
            expect(out.startsWith('<kb>\n')).toBe(true);
            expect(out.endsWith('\n</kb>')).toBe(true);
        });
    });

    describe('multi-doc formatting', () => {
        it('joins docs with the \\n---\\n thematic break', () => {
            const docs = [
                buildDoc({ title: 'First', slug: 'first', class: 'brand', body: 'one' }),
                buildDoc({ title: 'Second', slug: 'second', class: 'legal', body: 'two' }),
            ];
            const out = formatKbContext(docs);
            expect(out).toBe(
                '<kb>\n## First (kb:brand/first)\none\n---\n## Second (kb:legal/second)\ntwo\n</kb>',
            );
        });

        it('preserves input order (deterministic — caller controls ordering)', () => {
            const docs = [
                buildDoc({ title: 'Z', slug: 'z', class: 'brand', body: 'z body' }),
                buildDoc({ title: 'A', slug: 'a', class: 'brand', body: 'a body' }),
            ];
            const out = formatKbContext(docs);
            // 'Z' must appear before 'A' in the output.
            const zIdx = out.indexOf('## Z (');
            const aIdx = out.indexOf('## A (');
            expect(zIdx).toBeGreaterThanOrEqual(0);
            expect(aIdx).toBeGreaterThan(zIdx);
        });
    });

    describe('truncation', () => {
        it('does not truncate when block fits under maxChars', () => {
            const doc = buildDoc({ title: 'Short', slug: 's', class: 'brand', body: 'tiny' });
            const out = formatKbContext([doc], { maxChars: 10_000 });
            expect(out).not.toContain('[…truncated]');
        });

        it('clips the last doc body and appends [...truncated] marker when over cap', () => {
            const docs = [
                buildDoc({ title: 'Doc A', slug: 'a', class: 'brand', body: 'AAAA'.repeat(50) }),
                buildDoc({ title: 'Doc B', slug: 'b', class: 'brand', body: 'BBBB'.repeat(50) }),
            ];
            // Pick a cap that lets the first doc fit but clips the second.
            const out = formatKbContext(docs, { maxChars: 280 });

            // Both headings still present (we never split a heading).
            expect(out).toContain('## Doc A (kb:brand/a)');
            expect(out).toContain('## Doc B (kb:brand/b)');
            // Final marker present, length respected within the budget.
            expect(out.endsWith('[…truncated]\n</kb>')).toBe(true);
            expect(out.length).toBeLessThanOrEqual(280);
        });

        it('uses the default 16000-char cap when maxChars is unspecified', () => {
            const docs = [
                buildDoc({
                    title: 'Huge',
                    slug: 'huge',
                    class: 'brand',
                    body: 'X'.repeat(20_000),
                }),
            ];
            const out = formatKbContext(docs);
            expect(out.length).toBeLessThanOrEqual(16_000);
            expect(out).toContain('[…truncated]');
        });
    });
});
