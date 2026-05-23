import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { KbMentionResolverService } from '../kb-mention-resolver.service';
import { KnowledgeBaseService } from '../knowledge-base.service';
import type { KbMention } from '../kb-mention-parser';
import type { KbCitation } from '../kb-citation-parser';
import type { KbDocumentBodyDto, KbDocumentClass } from '@ever-works/contracts';

const WORK_ID = 'work-1';
const USER_ID = 'user-1';

function mention(reference: string, startOffset = 0): KbMention {
    const raw = `@kb:${reference}`;
    return { raw, reference, startOffset, endOffset: startOffset + raw.length };
}

function citation(cls: KbDocumentClass, slug: string, startOffset = 0): KbCitation {
    const raw = `kb:${cls}/${slug}`;
    return {
        raw,
        cls,
        slug,
        startOffset,
        endOffset: startOffset + raw.length,
    };
}

function buildDoc(overrides: Partial<KbDocumentBodyDto> = {}): KbDocumentBodyDto {
    return {
        id: overrides.id ?? 'doc-1',
        workId: overrides.workId ?? WORK_ID,
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
        body: overrides.body ?? 'body',
        assets: overrides.assets ?? [],
    } as KbDocumentBodyDto;
}

describe('KbMentionResolverService', () => {
    let service: KbMentionResolverService;
    let kbService: { getDocument: jest.Mock };

    beforeEach(async () => {
        kbService = { getDocument: jest.fn() };
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                KbMentionResolverService,
                { provide: KnowledgeBaseService, useValue: kbService },
            ],
        }).compile();
        service = module.get(KbMentionResolverService);
    });

    describe('boundary cases', () => {
        it('returns [] for empty mentions list (skips KB calls)', async () => {
            const out = await service.resolveMentions(WORK_ID, USER_ID, []);
            expect(out).toEqual([]);
            expect(kbService.getDocument).not.toHaveBeenCalled();
        });
    });

    describe('happy path resolution', () => {
        it('resolves a single class/slug reference to a document', async () => {
            const doc = buildDoc({ id: 'd1', path: 'brand/voice.md', slug: 'voice' });
            kbService.getDocument.mockResolvedValueOnce(doc);

            const out = await service.resolveMentions(WORK_ID, USER_ID, [mention('brand/voice')]);
            expect(out).toHaveLength(1);
            expect(out[0].document).toBe(doc);
            expect(out[0].mention.reference).toBe('brand/voice');
            // SYSTEM-userId boundary: the gate uses the *user* — we pass it through.
            expect(kbService.getDocument).toHaveBeenCalledWith(WORK_ID, 'brand/voice', USER_ID);
        });

        it('retries with `.md` suffix when the direct lookup misses', async () => {
            const doc = buildDoc({ id: 'd1', path: 'brand/voice.md' });
            kbService.getDocument
                .mockRejectedValueOnce(new NotFoundException('not found'))
                .mockResolvedValueOnce(doc);

            const out = await service.resolveMentions(WORK_ID, USER_ID, [mention('brand/voice')]);
            expect(out[0].document).toBe(doc);
            expect(kbService.getDocument).toHaveBeenNthCalledWith(
                1,
                WORK_ID,
                'brand/voice',
                USER_ID,
            );
            expect(kbService.getDocument).toHaveBeenNthCalledWith(
                2,
                WORK_ID,
                'brand/voice.md',
                USER_ID,
            );
        });

        it('does NOT retry with `.md` when the reference already has an extension', async () => {
            kbService.getDocument.mockRejectedValueOnce(new NotFoundException('not found'));

            const out = await service.resolveMentions(WORK_ID, USER_ID, [
                mention('brand/voice.md'),
            ]);
            expect(out[0].document).toBeNull();
            // Only the direct call — no retry.
            expect(kbService.getDocument).toHaveBeenCalledTimes(1);
        });

        it('does NOT retry with `.md` when the reference contains a dot (likely versioned slug)', async () => {
            kbService.getDocument.mockRejectedValueOnce(new NotFoundException('not found'));

            const out = await service.resolveMentions(WORK_ID, USER_ID, [mention('research/v2.1')]);
            expect(out[0].document).toBeNull();
            expect(kbService.getDocument).toHaveBeenCalledTimes(1);
        });

        it('preserves mention order across multiple resolutions', async () => {
            const d1 = buildDoc({ id: 'd1', path: 'brand/voice.md' });
            const d2 = buildDoc({ id: 'd2', path: 'legal/terms.md' });
            kbService.getDocument.mockResolvedValueOnce(d1).mockResolvedValueOnce(d2);

            const out = await service.resolveMentions(WORK_ID, USER_ID, [
                mention('brand/voice', 0),
                mention('legal/terms', 20),
            ]);
            expect(out.map((r) => r.document?.id)).toEqual(['d1', 'd2']);
        });
    });

    describe('graceful misses', () => {
        it('returns null doc for unresolved references (NotFoundException after .md retry)', async () => {
            kbService.getDocument
                .mockRejectedValueOnce(new NotFoundException('not found'))
                .mockRejectedValueOnce(new NotFoundException('not found'));

            const out = await service.resolveMentions(WORK_ID, USER_ID, [mention('ghost')]);
            expect(out).toHaveLength(1);
            expect(out[0].document).toBeNull();
        });

        it('returns null doc on ForbiddenException (access denied — no leak)', async () => {
            kbService.getDocument.mockRejectedValueOnce(new ForbiddenException('nope'));

            const out = await service.resolveMentions(WORK_ID, USER_ID, [mention('brand/voice')]);
            expect(out[0].document).toBeNull();
        });

        it('returns null doc on unexpected errors (DB outage etc. — no throw bubbles up)', async () => {
            kbService.getDocument.mockRejectedValueOnce(new Error('connection refused'));

            const out = await service.resolveMentions(WORK_ID, USER_ID, [mention('brand/voice')]);
            expect(out[0].document).toBeNull();
        });

        it('mixes resolvable + missing in a single batch', async () => {
            const d1 = buildDoc({ id: 'd1' });
            kbService.getDocument
                .mockResolvedValueOnce(d1)
                // ghost — both attempts miss
                .mockRejectedValueOnce(new NotFoundException('miss'))
                .mockRejectedValueOnce(new NotFoundException('miss'));

            const out = await service.resolveMentions(WORK_ID, USER_ID, [
                mention('brand/voice', 0),
                mention('ghost', 20),
            ]);
            expect(out.map((r) => r.document?.id ?? null)).toEqual(['d1', null]);
        });
    });

    describe('dedup by document.id', () => {
        it('collapses two mentions of the same doc to one resolved entry (first occurrence wins)', async () => {
            const doc = buildDoc({ id: 'd1' });
            kbService.getDocument.mockResolvedValueOnce(doc).mockResolvedValueOnce(doc);

            const out = await service.resolveMentions(WORK_ID, USER_ID, [
                mention('brand/voice', 0),
                mention('brand/voice', 50),
            ]);
            expect(out).toHaveLength(1);
            expect(out[0].mention.startOffset).toBe(0);
        });

        it('does NOT dedup null misses (each unresolved mention stays in the result)', async () => {
            // Two distinct ghosts — each gets a not-found pair (direct + retry).
            kbService.getDocument
                .mockRejectedValueOnce(new NotFoundException('miss'))
                .mockRejectedValueOnce(new NotFoundException('miss'))
                .mockRejectedValueOnce(new NotFoundException('miss'))
                .mockRejectedValueOnce(new NotFoundException('miss'));

            const out = await service.resolveMentions(WORK_ID, USER_ID, [
                mention('ghost-a', 0),
                mention('ghost-b', 20),
            ]);
            expect(out).toHaveLength(2);
            expect(out.every((r) => r.document === null)).toBe(true);
        });
    });

    // EW-641 Phase 2/c row 35b — bridges row 35a `parseKbCitations`
    // output to the existing `resolveMentions` machinery so the
    // `<CitationHover>` UI (row 35c) gets a `ResolvedKbCitation[]`
    // shape to render. Each citation is synthesized into a
    // `KbMention` (`reference = ${cls}/${slug}`); dedup behavior is
    // inherited from `resolveMentions`.
    describe('resolveCitations (row 35b)', () => {
        it('returns [] for an empty citation list (skips KB calls)', async () => {
            const out = await service.resolveCitations(WORK_ID, USER_ID, []);
            expect(out).toEqual([]);
            expect(kbService.getDocument).not.toHaveBeenCalled();
        });

        it('resolves a single citation to a document and pairs it back to the originating citation', async () => {
            const doc = buildDoc({ id: 'd1', path: 'brand/voice.md', slug: 'voice' });
            kbService.getDocument.mockResolvedValueOnce(doc);

            const c = citation('brand', 'voice', 12);
            const out = await service.resolveCitations(WORK_ID, USER_ID, [c]);

            expect(out).toHaveLength(1);
            expect(out[0].citation).toBe(c);
            expect(out[0].document).toBe(doc);
            // Citation `kb:brand/voice` → synthesized reference `brand/voice`
            // — `getDocument` receives the same path it would for the
            // row 34a `@kb:brand/voice` user-input mention.
            expect(kbService.getDocument).toHaveBeenCalledWith(WORK_ID, 'brand/voice', USER_ID);
        });

        it('preserves textual order across multiple citations', async () => {
            const d1 = buildDoc({ id: 'd1', path: 'brand/voice.md' });
            const d2 = buildDoc({ id: 'd2', path: 'legal/terms.md' });
            kbService.getDocument.mockResolvedValueOnce(d1).mockResolvedValueOnce(d2);

            const c1 = citation('brand', 'voice', 0);
            const c2 = citation('legal', 'terms', 30);
            const out = await service.resolveCitations(WORK_ID, USER_ID, [c1, c2]);

            expect(out).toHaveLength(2);
            expect(out[0].citation).toBe(c1);
            expect(out[0].document).toBe(d1);
            expect(out[1].citation).toBe(c2);
            expect(out[1].document).toBe(d2);
        });

        it('returns null doc for an unknown citation (preserves the citation row)', async () => {
            // Direct miss → `.md` retry miss (synthesized reference
            // `brand/ghost` has no dot, so the `.md` retry fires).
            kbService.getDocument
                .mockRejectedValueOnce(new NotFoundException('miss'))
                .mockRejectedValueOnce(new NotFoundException('miss'));

            const c = citation('brand', 'ghost');
            const out = await service.resolveCitations(WORK_ID, USER_ID, [c]);

            expect(out).toHaveLength(1);
            expect(out[0].citation).toBe(c);
            expect(out[0].document).toBeNull();
        });

        it('dedupes by document.id when two citations point at the same doc (first occurrence wins)', async () => {
            const doc = buildDoc({ id: 'd1', path: 'brand/voice.md' });
            kbService.getDocument.mockResolvedValueOnce(doc).mockResolvedValueOnce(doc);

            const c1 = citation('brand', 'voice', 0);
            const c2 = citation('brand', 'voice', 50);
            const out = await service.resolveCitations(WORK_ID, USER_ID, [c1, c2]);

            // Inherits `resolveMentions` dedup: second occurrence drops.
            expect(out).toHaveLength(1);
            expect(out[0].citation).toBe(c1);
            expect(out[0].document).toBe(doc);
        });

        it('mixes resolvable + missing in a single batch and keeps both citation rows', async () => {
            const d1 = buildDoc({ id: 'd1' });
            kbService.getDocument
                .mockResolvedValueOnce(d1)
                // ghost — direct miss + .md retry miss
                .mockRejectedValueOnce(new NotFoundException('miss'))
                .mockRejectedValueOnce(new NotFoundException('miss'));

            const c1 = citation('brand', 'voice', 0);
            const c2 = citation('legal', 'ghost', 30);
            const out = await service.resolveCitations(WORK_ID, USER_ID, [c1, c2]);

            expect(out).toHaveLength(2);
            expect(out[0].citation).toBe(c1);
            expect(out[0].document).toBe(d1);
            expect(out[1].citation).toBe(c2);
            expect(out[1].document).toBeNull();
        });
    });
});
