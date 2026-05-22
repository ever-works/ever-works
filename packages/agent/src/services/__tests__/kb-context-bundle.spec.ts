import { buildKbContextBundle } from '../kb-context-bundle';
import type { KbDocumentBodyDto } from '@ever-works/contracts';

/**
 * Test helper — same shape as the `kb-prompt-formatter` helper so the
 * two specs read the same. Override only the fields the test cares about.
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
        createdAt: overrides.createdAt ?? '2026-05-23T00:00:00.000Z',
        updatedAt: overrides.updatedAt ?? '2026-05-23T00:00:00.000Z',
        lastCommitSha: overrides.lastCommitSha ?? null,
        body: overrides.body ?? 'default body',
        assets: overrides.assets ?? [],
    } as KbDocumentBodyDto;
}

describe('buildKbContextBundle', () => {
    describe('boundary cases', () => {
        it('returns an empty bundle when both inputs are empty', () => {
            const bundle = buildKbContextBundle([], []);
            expect(bundle.alwaysInjected).toEqual([]);
            expect(bundle.queryRetrieved).toEqual([]);
            expect(bundle.format()).toBe('<kb>\n</kb>');
        });

        it('handles alwaysInjected-only input', () => {
            const doc = buildDoc({
                id: 'a',
                title: 'Voice',
                slug: 'voice',
                class: 'brand',
                body: 'short',
            });
            const bundle = buildKbContextBundle([doc], []);
            expect(bundle.alwaysInjected).toHaveLength(1);
            expect(bundle.queryRetrieved).toHaveLength(0);
            expect(bundle.format()).toBe('<kb>\n## Voice (kb:brand/voice)\nshort\n</kb>');
        });

        it('handles queryRetrieved-only input', () => {
            const doc = buildDoc({
                id: 'q',
                title: 'Research note',
                slug: 'note',
                class: 'research',
                body: 'detail',
            });
            const bundle = buildKbContextBundle([], [doc]);
            expect(bundle.alwaysInjected).toHaveLength(0);
            expect(bundle.queryRetrieved).toHaveLength(1);
            expect(bundle.format()).toBe(
                '<kb>\n## Research note (kb:research/note)\ndetail\n</kb>',
            );
        });
    });

    describe('priority + dedup', () => {
        it('emits alwaysInjected first, then queryRetrieved', () => {
            const always = buildDoc({
                id: 'a',
                title: 'Brand',
                slug: 'brand',
                class: 'brand',
                body: 'a',
            });
            const query = buildDoc({
                id: 'b',
                title: 'Research',
                slug: 'r',
                class: 'research',
                body: 'b',
            });
            const out = buildKbContextBundle([always], [query]).format();
            const aIdx = out.indexOf('## Brand (');
            const bIdx = out.indexOf('## Research (');
            expect(aIdx).toBeGreaterThanOrEqual(0);
            expect(bIdx).toBeGreaterThan(aIdx);
        });

        it('drops queryRetrieved entries that duplicate alwaysInjected by id', () => {
            const shared = buildDoc({
                id: 'shared',
                title: 'Voice',
                slug: 'voice',
                class: 'brand',
                body: 'always-version',
            });
            const sharedFromQuery = buildDoc({
                id: 'shared',
                title: 'Voice (semantic)',
                slug: 'voice',
                class: 'brand',
                body: 'query-version — should be dropped',
            });
            const extraQuery = buildDoc({
                id: 'extra',
                title: 'Extra',
                slug: 'extra',
                class: 'research',
                body: 'extra',
            });
            const bundle = buildKbContextBundle([shared], [sharedFromQuery, extraQuery]);

            expect(bundle.queryRetrieved.map((d) => d.id)).toEqual(['extra']);
            const out = bundle.format();
            // Always-injected copy survives, query-version is gone.
            expect(out).toContain('always-version');
            expect(out).not.toContain('should be dropped');
        });

        it('dedupes queryRetrieved entries that repeat within the list itself', () => {
            const a = buildDoc({ id: 'x', title: 'A', slug: 'a', class: 'research', body: 'A1' });
            const aAgain = buildDoc({
                id: 'x',
                title: 'A again',
                slug: 'a',
                class: 'research',
                body: 'A2',
            });
            const bundle = buildKbContextBundle([], [a, aAgain]);
            expect(bundle.queryRetrieved.map((d) => d.id)).toEqual(['x']);
            // First wins (deterministic).
            expect(bundle.queryRetrieved[0].title).toBe('A');
        });

        it('preserves input order within each list (deterministic)', () => {
            const a = buildDoc({ id: '1', title: 'Z', slug: 'z', class: 'brand', body: 'z' });
            const b = buildDoc({ id: '2', title: 'A', slug: 'a', class: 'brand', body: 'a' });
            const c = buildDoc({ id: '3', title: 'M', slug: 'm', class: 'research', body: 'm' });
            const d = buildDoc({ id: '4', title: 'B', slug: 'b', class: 'research', body: 'b' });

            const out = buildKbContextBundle([a, b], [c, d]).format();
            const zIdx = out.indexOf('## Z (');
            const aIdx = out.indexOf('## A (');
            const mIdx = out.indexOf('## M (');
            const bIdx = out.indexOf('## B (');
            // alwaysInjected order: Z, A — then queryRetrieved: M, B.
            expect(zIdx).toBeLessThan(aIdx);
            expect(aIdx).toBeLessThan(mIdx);
            expect(mIdx).toBeLessThan(bIdx);
        });
    });

    describe('immutability', () => {
        it('returns frozen alwaysInjected + queryRetrieved arrays', () => {
            const doc = buildDoc({ id: 'a' });
            const bundle = buildKbContextBundle([doc], []);
            expect(Object.isFrozen(bundle.alwaysInjected)).toBe(true);
            expect(Object.isFrozen(bundle.queryRetrieved)).toBe(true);
        });

        it('does not mutate caller-owned input arrays', () => {
            const always: KbDocumentBodyDto[] = [buildDoc({ id: 'a' })];
            const query: KbDocumentBodyDto[] = [buildDoc({ id: 'b' })];
            const alwaysLenBefore = always.length;
            const queryLenBefore = query.length;
            buildKbContextBundle(always, query);
            expect(always.length).toBe(alwaysLenBefore);
            expect(query.length).toBe(queryLenBefore);
        });
    });

    describe('format options', () => {
        it('forwards maxChars to formatKbContext (truncation honoured)', () => {
            const doc = buildDoc({
                id: 'big',
                title: 'Big',
                slug: 'big',
                class: 'brand',
                body: 'X'.repeat(500),
            });
            const bundle = buildKbContextBundle([doc], []);
            const truncated = bundle.format({ maxChars: 100 });
            expect(truncated.length).toBeLessThanOrEqual(100);
            expect(truncated).toContain('[…truncated]');
        });
    });
});
