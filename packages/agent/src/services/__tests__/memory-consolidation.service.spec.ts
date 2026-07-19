/**
 * Unit tests for `MemoryConsolidationService` — orchestration only (the
 * scoring/grouping math is covered by `memory-consolidation.spec.ts`).
 * Repository, KB service and AI facade are mocked; assertions focus on
 * the run invariants: dry-run writes nothing, apply persists markers,
 * keyless installs skip synthesis with a note, already-superseded docs
 * stay superseded, and stale promotion markers are cleared.
 */
import {
    MemoryConsolidationService,
    CONSOLIDATION_MAX_SYNTHESES,
} from '../memory-consolidation.service';
import { WorkKnowledgeDocument } from '../../entities/work-knowledge-document.entity';
import { KbDocumentClass, KbDocumentSource, KbDocumentStatus } from '../../entities/kb-types';

const ORG_ID = 'org-1';
const USER_ID = 'user-1';
const SCOPE = { organizationId: ORG_ID, userId: USER_ID };

let docCounter = 0;

function makeDoc(overrides: Partial<WorkKnowledgeDocument> = {}): WorkKnowledgeDocument {
    docCounter++;
    const id = overrides.id ?? `doc-${String(docCounter).padStart(3, '0')}`;
    return {
        id,
        workId: 'work-1',
        organizationId: null,
        path: `freeform/${id}.md`,
        slug: id,
        title: `Document ${id}`,
        description: null,
        kbDocumentClass: KbDocumentClass.FREEFORM,
        tags: [],
        categories: null,
        status: KbDocumentStatus.ACTIVE,
        locked: false,
        lockMode: null,
        language: 'en',
        source: KbDocumentSource.USER,
        metadata: { body: `Unique body for ${id} ${'filler '.repeat(20)}${id}` },
        consolidation: null,
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
        updatedAt: new Date('2026-06-15T00:00:00.000Z'),
        ...overrides,
    } as WorkKnowledgeDocument;
}

/** A trio of near-duplicates (same title) with distinct update times. */
function makeDupTrio(
    title: string,
    kbDocumentClass: KbDocumentClass = KbDocumentClass.FREEFORM,
): WorkKnowledgeDocument[] {
    return [
        makeDoc({ title, kbDocumentClass, updatedAt: new Date('2026-06-10T00:00:00.000Z') }),
        makeDoc({ title, kbDocumentClass, updatedAt: new Date('2026-06-12T00:00:00.000Z') }),
        makeDoc({ title, kbDocumentClass, updatedAt: new Date('2026-06-14T00:00:00.000Z') }),
    ];
}

function buildMocks(items: WorkKnowledgeDocument[], total?: number) {
    const documentRepository = {
        listForOrgAggregate: jest.fn().mockResolvedValue({ items, total: total ?? items.length }),
        update: jest.fn().mockResolvedValue(null),
        findOrgByPath: jest.fn().mockResolvedValue(null),
    };
    const kb = {
        createOrgDocument: jest.fn().mockResolvedValue({ id: 'synth-doc-1' }),
    };
    const workRepository = {
        findIdNamesByOrganization: jest
            .fn()
            .mockResolvedValue([{ id: 'work-1', name: 'Work One' }]),
    };
    const aiFacade = {
        isConfigured: jest.fn().mockReturnValue(false),
        createChatCompletion: jest.fn().mockResolvedValue({
            id: 'resp-1',
            model: 'test-model',
            created: 0,
            choices: [{ message: { role: 'assistant', content: 'Merged synthesis paragraph.' } }],
        }),
    };
    const service = new MemoryConsolidationService(
        documentRepository as never,
        kb as never,
        workRepository as never,
        aiFacade as never,
    );
    return { service, documentRepository, kb, workRepository, aiFacade };
}

beforeEach(() => {
    docCounter = 0;
});

describe('MemoryConsolidationService.runConsolidation', () => {
    it('uses the aggregateOrgMemory scope plumbing (org Work ids + org-scoped rows)', async () => {
        const { service, documentRepository, workRepository } = buildMocks([makeDoc()]);
        await service.runConsolidation(SCOPE, { apply: false });

        expect(workRepository.findIdNamesByOrganization).toHaveBeenCalledWith(ORG_ID);
        expect(documentRepository.listForOrgAggregate).toHaveBeenCalledWith(
            expect.objectContaining({ workIds: ['work-1'], organizationId: ORG_ID }),
        );
    });

    it('degrades to org-scoped rows only when WorkRepository is not wired', async () => {
        const items = [makeDoc({ workId: null, organizationId: ORG_ID })];
        const documentRepository = {
            listForOrgAggregate: jest.fn().mockResolvedValue({ items, total: 1 }),
            update: jest.fn(),
            findOrgByPath: jest.fn().mockResolvedValue(null),
        };
        const service = new MemoryConsolidationService(
            documentRepository as never,
            { createOrgDocument: jest.fn() } as never,
        );

        const report = await service.runConsolidation(SCOPE, { apply: false });

        expect(documentRepository.listForOrgAggregate).toHaveBeenCalledWith(
            expect.objectContaining({ workIds: [], organizationId: ORG_ID }),
        );
        expect(report.scanned).toBe(1);
    });

    describe('dry-run (apply: false, the default)', () => {
        it('computes the full report but writes NOTHING', async () => {
            const [older, mid, newest] = makeDupTrio('Brand Voice');
            const extra = makeDoc({ title: 'Standalone' });
            const { service, documentRepository, kb, aiFacade } = buildMocks([
                older,
                mid,
                newest,
                extra,
            ]);

            const report = await service.runConsolidation(SCOPE, { apply: false });

            expect(report.dryRun).toBe(true);
            expect(report.scanned).toBe(4);
            expect(report.superseded).toBe(2);
            expect(report.details.supersededPairs).toEqual(
                expect.arrayContaining([
                    [mid.id, newest.id],
                    [older.id, newest.id],
                ]),
            );
            // Survivor + standalone are promotion candidates (≤ top-20).
            expect(report.promoted).toBe(2);
            expect(report.details.promotedIds).toEqual(
                expect.arrayContaining([newest.id, extra.id]),
            );
            expect(report.notes.some((n) => n.toLowerCase().includes('dry run'))).toBe(true);

            expect(documentRepository.update).not.toHaveBeenCalled();
            expect(kb.createOrgDocument).not.toHaveBeenCalled();
            expect(aiFacade.createChatCompletion).not.toHaveBeenCalled();
        });

        it('defaults to dry-run when no options are passed', async () => {
            const { service, documentRepository } = buildMocks([makeDoc()]);
            const report = await service.runConsolidation(SCOPE);
            expect(report.dryRun).toBe(true);
            expect(documentRepository.update).not.toHaveBeenCalled();
        });

        it('predicts the synthesis count without creating documents (provider configured)', async () => {
            const trio = makeDupTrio('Privacy Policy', KbDocumentClass.LEGAL);
            const { service, aiFacade, kb } = buildMocks(trio);
            aiFacade.isConfigured.mockReturnValue(true);

            const report = await service.runConsolidation(SCOPE, { apply: false });

            expect(report.synthesized).toBe(1);
            expect(report.details.synthesizedIds).toEqual([]);
            expect(kb.createOrgDocument).not.toHaveBeenCalled();
            expect(aiFacade.createChatCompletion).not.toHaveBeenCalled();
        });

        it('notes the scan truncation when the org has more documents than the cap', async () => {
            const { service } = buildMocks([makeDoc()], 5000);
            const report = await service.runConsolidation(SCOPE, { apply: false });
            expect(report.scanned).toBe(1);
            expect(report.notes.some((n) => n.includes('5000'))).toBe(true);
        });
    });

    describe('apply: true', () => {
        it('persists superseded markers on losers, pointing at the newest survivor', async () => {
            const [older, mid, newest] = makeDupTrio('Brand Voice');
            const { service, documentRepository } = buildMocks([older, mid, newest]);

            const report = await service.runConsolidation(SCOPE, { apply: true });

            expect(report.dryRun).toBe(false);
            expect(report.superseded).toBe(2);
            for (const loser of [older, mid]) {
                expect(documentRepository.update).toHaveBeenCalledWith(loser.id, {
                    consolidation: expect.objectContaining({
                        state: 'superseded',
                        supersededById: newest.id,
                        reason: `near-duplicate of ${newest.title}`,
                        runAt: expect.any(String),
                    }),
                });
            }
            const marker = documentRepository.update.mock.calls.find(([id]) => id === older.id)?.[1]
                .consolidation;
            expect(Number.isNaN(Date.parse(marker.runAt))).toBe(false);
        });

        it('persists promoted markers (with score) on the top-N', async () => {
            const doc = makeDoc({ title: 'Keeper' });
            const { service, documentRepository } = buildMocks([doc]);

            const report = await service.runConsolidation(SCOPE, { apply: true });

            expect(report.promoted).toBe(1);
            expect(documentRepository.update).toHaveBeenCalledWith(doc.id, {
                consolidation: expect.objectContaining({
                    state: 'promoted',
                    score: expect.any(Number),
                    reason: expect.stringContaining('promotion score'),
                    runAt: expect.any(String),
                }),
            });
        });

        it('never resurrects an already-superseded document', async () => {
            const survivor = makeDoc({
                title: 'Style Guide',
                updatedAt: new Date('2026-06-14T00:00:00.000Z'),
            });
            const alreadySuperseded = makeDoc({
                title: 'Style Guide',
                updatedAt: new Date('2026-06-16T00:00:00.000Z'),
                consolidation: {
                    state: 'superseded',
                    supersededById: 'old-survivor',
                    reason: 'near-duplicate of something older',
                    runAt: '2026-05-01T00:00:00.000Z',
                },
            });
            const { service, documentRepository } = buildMocks([survivor, alreadySuperseded]);

            const report = await service.runConsolidation(SCOPE, { apply: true });

            // The superseded doc is newer, but it must NOT become a survivor
            // (excluded from grouping) and must NOT be promoted or rewritten.
            const touchedIds = documentRepository.update.mock.calls.map(([id]) => id);
            expect(touchedIds).not.toContain(alreadySuperseded.id);
            expect(report.details.promotedIds).not.toContain(alreadySuperseded.id);
            expect(report.superseded).toBe(0);
        });

        it('clears the promoted marker of docs that fell out of the top-N', async () => {
            // 21 candidates: the stale one is old + empty, so it scores last
            // and misses the top-20 cut.
            const strong = Array.from({ length: 20 }, (_, i) =>
                makeDoc({
                    title: `Strong ${i}`,
                    tags: ['a', 'b', 'c'],
                    updatedAt: new Date('2026-06-20T00:00:00.000Z'),
                }),
            );
            const stale = makeDoc({
                title: 'Faded glory',
                metadata: { body: '' },
                updatedAt: new Date('2020-01-01T00:00:00.000Z'),
                consolidation: {
                    state: 'promoted',
                    score: 90,
                    reason: 'promotion score 90 — earlier run',
                    runAt: '2026-05-01T00:00:00.000Z',
                },
            });
            const { service, documentRepository } = buildMocks([...strong, stale]);

            const report = await service.runConsolidation(SCOPE, { apply: true });

            expect(report.promoted).toBe(20);
            expect(report.details.promotedIds).not.toContain(stale.id);
            expect(documentRepository.update).toHaveBeenCalledWith(stale.id, {
                consolidation: null,
            });
        });

        it('re-stamps a still-deserving promoted doc instead of clearing it', async () => {
            const keeper = makeDoc({
                title: 'Evergreen',
                consolidation: {
                    state: 'promoted',
                    score: 50,
                    reason: 'promotion score 50 — earlier run',
                    runAt: '2026-05-01T00:00:00.000Z',
                },
            });
            const { service, documentRepository } = buildMocks([keeper]);

            await service.runConsolidation(SCOPE, { apply: true });

            expect(documentRepository.update).toHaveBeenCalledWith(keeper.id, {
                consolidation: expect.objectContaining({ state: 'promoted' }),
            });
            expect(documentRepository.update).not.toHaveBeenCalledWith(keeper.id, {
                consolidation: null,
            });
        });
    });

    describe('LLM synthesis', () => {
        it('skips synthesis entirely on keyless installs, with an explanatory note', async () => {
            const trio = makeDupTrio('Privacy Policy', KbDocumentClass.LEGAL);
            const { service, aiFacade, kb } = buildMocks(trio);
            aiFacade.isConfigured.mockReturnValue(false);

            const report = await service.runConsolidation(SCOPE, { apply: true });

            expect(report.synthesized).toBe(0);
            expect(report.notes.some((n) => n.includes('No AI provider'))).toBe(true);
            expect(aiFacade.createChatCompletion).not.toHaveBeenCalled();
            expect(kb.createOrgDocument).not.toHaveBeenCalled();
        });

        it('synthesizes a 3+ duplicate group into one new org document', async () => {
            const trio = makeDupTrio('Privacy Policy', KbDocumentClass.LEGAL);
            const newest = trio[2];
            const { service, documentRepository, kb, aiFacade } = buildMocks(trio);
            aiFacade.isConfigured.mockReturnValue(true);

            const report = await service.runConsolidation(SCOPE, { apply: true });

            expect(report.synthesized).toBe(1);
            expect(report.details.synthesizedIds).toEqual(['synth-doc-1']);
            expect(aiFacade.createChatCompletion).toHaveBeenCalledTimes(1);
            expect(kb.createOrgDocument).toHaveBeenCalledWith(
                ORG_ID,
                USER_ID,
                expect.objectContaining({
                    title: `Synthesis: ${newest.title}`,
                    class: KbDocumentClass.LEGAL,
                    body: 'Merged synthesis paragraph.',
                    tags: ['synthesis'],
                }),
            );
            expect(documentRepository.update).toHaveBeenCalledWith('synth-doc-1', {
                consolidation: expect.objectContaining({
                    state: 'promoted',
                    reason: 'synthesized from 3 documents',
                }),
            });
        });

        it('does not synthesize pairs (groups need 3+ documents)', async () => {
            const pair = makeDupTrio('Privacy Policy', KbDocumentClass.LEGAL).slice(0, 2);
            const { service, aiFacade } = buildMocks(pair);
            aiFacade.isConfigured.mockReturnValue(true);

            const report = await service.runConsolidation(SCOPE, { apply: true });

            expect(report.synthesized).toBe(0);
            expect(aiFacade.createChatCompletion).not.toHaveBeenCalled();
        });

        it('caps syntheses per run at CONSOLIDATION_MAX_SYNTHESES', async () => {
            const items = Array.from({ length: CONSOLIDATION_MAX_SYNTHESES + 2 }, (_, i) =>
                makeDupTrio(`Legal Topic ${i}`, KbDocumentClass.LEGAL),
            ).flat();
            const { service, aiFacade } = buildMocks(items);
            aiFacade.isConfigured.mockReturnValue(true);

            const report = await service.runConsolidation(SCOPE, { apply: true });

            expect(aiFacade.createChatCompletion).toHaveBeenCalledTimes(
                CONSOLIDATION_MAX_SYNTHESES,
            );
            expect(report.synthesized).toBe(CONSOLIDATION_MAX_SYNTHESES);
        });

        it('skips groups whose survivor class cannot be an org-level document', async () => {
            const trio = makeDupTrio('Research Dump', KbDocumentClass.RESEARCH);
            const { service, aiFacade, kb } = buildMocks(trio);
            aiFacade.isConfigured.mockReturnValue(true);

            const report = await service.runConsolidation(SCOPE, { apply: true });

            expect(report.synthesized).toBe(0);
            expect(report.notes.some((n) => n.includes('inheritable classes'))).toBe(true);
            expect(kb.createOrgDocument).not.toHaveBeenCalled();
        });

        it('skips groups that already have a synthesis document (idempotent reruns)', async () => {
            const trio = makeDupTrio('Privacy Policy', KbDocumentClass.LEGAL);
            const { service, documentRepository, aiFacade, kb } = buildMocks(trio);
            aiFacade.isConfigured.mockReturnValue(true);
            documentRepository.findOrgByPath.mockResolvedValue(
                makeDoc({ title: 'Synthesis: old' }),
            );

            const report = await service.runConsolidation(SCOPE, { apply: true });

            expect(report.synthesized).toBe(0);
            expect(report.notes.some((n) => n.includes('already have a synthesis'))).toBe(true);
            expect(kb.createOrgDocument).not.toHaveBeenCalled();
        });

        it('NEVER fails the run when the LLM call throws — deterministic results stand', async () => {
            const trio = makeDupTrio('Privacy Policy', KbDocumentClass.LEGAL);
            const { service, documentRepository, aiFacade, kb } = buildMocks(trio);
            aiFacade.isConfigured.mockReturnValue(true);
            aiFacade.createChatCompletion.mockRejectedValue(new Error('provider exploded'));

            const report = await service.runConsolidation(SCOPE, { apply: true });

            expect(report.synthesized).toBe(0);
            expect(report.superseded).toBe(2);
            expect(report.notes.some((n) => n.includes('provider exploded'))).toBe(true);
            expect(kb.createOrgDocument).not.toHaveBeenCalled();
            // Deterministic markers were still written.
            expect(documentRepository.update).toHaveBeenCalled();
        });

        it('treats an empty LLM response as a per-group failure, not a run failure', async () => {
            const trio = makeDupTrio('Privacy Policy', KbDocumentClass.LEGAL);
            const { service, aiFacade, kb } = buildMocks(trio);
            aiFacade.isConfigured.mockReturnValue(true);
            aiFacade.createChatCompletion.mockResolvedValue({
                id: 'resp-1',
                model: 'test-model',
                created: 0,
                choices: [{ message: { role: 'assistant', content: '   ' } }],
            });

            const report = await service.runConsolidation(SCOPE, { apply: true });

            expect(report.synthesized).toBe(0);
            expect(report.notes.some((n) => n.includes('empty synthesis'))).toBe(true);
            expect(kb.createOrgDocument).not.toHaveBeenCalled();
        });
    });
});
