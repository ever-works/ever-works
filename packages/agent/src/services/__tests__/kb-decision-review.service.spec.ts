import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import type { KbDocumentBodyDto } from '@ever-works/contracts';
import { KB_STORAGE_PLUGIN, KnowledgeBaseService } from '../knowledge-base.service';
import { KB_EMBED_DOCUMENT_DISPATCHER } from '../../tasks/kb-embed-document-dispatcher';
import { WorkKnowledgeDocumentRepository } from '../../database/repositories/work-knowledge-document.repository';
import { WorkKnowledgeUploadRepository } from '../../database/repositories/work-knowledge-upload.repository';
import { WorkKnowledgeTagRepository } from '../../database/repositories/work-knowledge-tag.repository';
import { WorkKnowledgeCitationRepository } from '../../database/repositories/work-knowledge-citation.repository';
import { WorkOwnershipService } from '../work-ownership.service';
import { ActivityLogService } from '../../activity-log/activity-log.service';
import { WorkKnowledgeDocument } from '../../entities/work-knowledge-document.entity';
import {
    KbDecisionStatus,
    KbDocumentClass,
    KbDocumentSource,
    KbDocumentStatus,
    KbReviewState,
} from '../../entities/kb-types';
import { formatKbContext } from '../kb-prompt-formatter';
import { buildKbContextBundle } from '../kb-context-bundle';

const WORK_ID = '00000000-0000-0000-0000-000000000001';
const USER_ID = '00000000-0000-0000-0000-000000000002';
const DOC_ID = '00000000-0000-0000-0000-000000000010';
const SURVIVOR_ID = '00000000-0000-0000-0000-000000000011';

function buildDocument(overrides: Partial<WorkKnowledgeDocument> = {}): WorkKnowledgeDocument {
    return {
        id: DOC_ID,
        workId: WORK_ID,
        organizationId: null,
        path: 'decision/context-store.md',
        slug: 'context-store',
        title: 'Context lives in files',
        description: null,
        kbDocumentClass: KbDocumentClass.DECISION,
        tags: null,
        categories: null,
        status: KbDocumentStatus.ACTIVE,
        locked: false,
        lockMode: null,
        language: 'en',
        wordCount: 0,
        tokenCount: 0,
        source: KbDocumentSource.USER,
        sourceUploadId: null,
        sourceUrl: null,
        generatedByAgentRunId: null,
        createdById: USER_ID,
        updatedById: USER_ID,
        lastIndexedAt: null,
        lastCommitSha: null,
        metadata: { body: 'We keep context in files.' },
        consolidation: null,
        decision: { status: KbDecisionStatus.PROPOSED },
        reviewState: null,
        createdAt: new Date('2026-07-01T12:00:00Z'),
        updatedAt: new Date('2026-07-01T12:00:00Z'),
        ...overrides,
    } as WorkKnowledgeDocument;
}

function buildBodyDto(overrides: Partial<KbDocumentBodyDto> = {}): KbDocumentBodyDto {
    return {
        id: overrides.id ?? DOC_ID,
        workId: WORK_ID,
        organizationId: null,
        path: overrides.path ?? 'decision/context-store.md',
        slug: overrides.slug ?? 'context-store',
        title: overrides.title ?? 'Context lives in files',
        description: null,
        class: overrides.class ?? 'decision',
        tags: [],
        categories: [],
        status: 'active',
        locked: false,
        lockMode: null,
        language: 'en',
        wordCount: null,
        tokenCount: null,
        source: 'user',
        sourceUploadId: null,
        sourceUrl: null,
        generatedByAgentRunId: null,
        createdById: null,
        updatedById: null,
        createdAt: '2026-07-01T12:00:00.000Z',
        updatedAt: '2026-07-01T12:00:00.000Z',
        lastCommitSha: null,
        lastIndexedAt: null,
        body: overrides.body ?? 'decision body',
        assets: [],
        ...overrides,
    } as KbDocumentBodyDto;
}

describe('KnowledgeBaseService — decision docs + review states (Wave 5 M4-M7)', () => {
    let service: KnowledgeBaseService;
    let docRepo: jest.Mocked<WorkKnowledgeDocumentRepository>;

    beforeEach(async () => {
        const docRepoMock: Partial<jest.Mocked<WorkKnowledgeDocumentRepository>> = {
            findById: jest.fn(),
            findByPath: jest.fn(),
            findOrgById: jest.fn(),
            findOrgByPath: jest.fn(),
            findByWorkOrPath: jest.fn(),
            list: jest.fn().mockResolvedValue({ items: [], total: 0 }),
            pathExists: jest.fn().mockResolvedValue(false),
            create: jest.fn(),
            update: jest.fn(),
            delete: jest.fn().mockResolvedValue(true),
            setLock: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                KnowledgeBaseService,
                { provide: WorkKnowledgeDocumentRepository, useValue: docRepoMock },
                {
                    provide: WorkKnowledgeUploadRepository,
                    useValue: { findById: jest.fn(), create: jest.fn(), update: jest.fn() },
                },
                {
                    provide: WorkKnowledgeTagRepository,
                    useValue: {
                        list: jest.fn().mockResolvedValue([]),
                        findBySlug: jest.fn(),
                        upsertBySlug: jest.fn(),
                    },
                },
                {
                    provide: WorkKnowledgeCitationRepository,
                    useValue: { listForDocument: jest.fn().mockResolvedValue([]) },
                },
                {
                    provide: WorkOwnershipService,
                    useValue: {
                        ensureCanView: jest.fn().mockResolvedValue({ role: 'editor' }),
                        ensureCanEdit: jest.fn().mockResolvedValue({ role: 'editor' }),
                    },
                },
                {
                    provide: KB_STORAGE_PLUGIN,
                    useValue: {
                        providerName: 'local-fs',
                        putObject: jest.fn(),
                        getObject: jest.fn(),
                        deleteObject: jest.fn(),
                        isAvailable: jest.fn().mockResolvedValue(true),
                    },
                },
                { provide: ActivityLogService, useValue: { log: jest.fn() } },
                {
                    provide: KB_EMBED_DOCUMENT_DISPATCHER,
                    useValue: { dispatchKbEmbedDocument: jest.fn().mockResolvedValue('run-id') },
                },
            ],
        }).compile();

        service = module.get(KnowledgeBaseService);
        docRepo = module.get(WorkKnowledgeDocumentRepository);
    });

    // ─── M4 — status machine ───────────────────────────────────────────

    describe('transitionDecisionStatus — legal transitions', () => {
        it('proposed → accepted succeeds and flips reviewState to accepted', async () => {
            const doc = buildDocument({
                decision: { status: KbDecisionStatus.PROPOSED },
                reviewState: KbReviewState.PROPOSED,
            });
            docRepo.findById.mockResolvedValue(doc);
            docRepo.update.mockImplementation(async (id, patch) => ({ ...doc, ...patch }));

            const result = await service.transitionDecisionStatus(
                WORK_ID,
                DOC_ID,
                USER_ID,
                KbDecisionStatus.ACCEPTED,
            );

            expect(result.decision?.status).toBe('accepted');
            expect(result.reviewState).toBe('accepted');
            expect(docRepo.update).toHaveBeenCalledWith(
                DOC_ID,
                expect.objectContaining({
                    decision: expect.objectContaining({ status: KbDecisionStatus.ACCEPTED }),
                    reviewState: KbReviewState.ACCEPTED,
                }),
            );
        });

        it('accepted → superseded records the chain links on both documents', async () => {
            const doc = buildDocument({ decision: { status: KbDecisionStatus.ACCEPTED } });
            const survivor = buildDocument({
                id: SURVIVOR_ID,
                slug: 'context-store-v2',
                decision: { status: KbDecisionStatus.ACCEPTED },
            });
            docRepo.findById.mockImplementation(async (_workId, id) =>
                id === SURVIVOR_ID ? survivor : doc,
            );
            docRepo.update.mockImplementation(async (id, patch) =>
                id === SURVIVOR_ID ? { ...survivor, ...patch } : { ...doc, ...patch },
            );

            const result = await service.transitionDecisionStatus(
                WORK_ID,
                DOC_ID,
                USER_ID,
                KbDecisionStatus.SUPERSEDED,
                { supersededByDocId: SURVIVOR_ID, rationale: 'replaced by v2' },
            );

            expect(result.decision).toMatchObject({
                status: 'superseded',
                supersededByDocId: SURVIVOR_ID,
                supersededBySlug: 'context-store-v2',
                rationale: 'replaced by v2',
            });
            // Reverse link written on the survivor, status untouched.
            expect(docRepo.update).toHaveBeenCalledWith(
                SURVIVOR_ID,
                expect.objectContaining({
                    decision: expect.objectContaining({
                        status: KbDecisionStatus.ACCEPTED,
                        supersedesDocId: DOC_ID,
                    }),
                }),
            );
        });

        it('superseded → archived succeeds', async () => {
            const doc = buildDocument({ decision: { status: KbDecisionStatus.SUPERSEDED } });
            docRepo.findById.mockResolvedValue(doc);
            docRepo.update.mockImplementation(async (id, patch) => ({ ...doc, ...patch }));

            const result = await service.transitionDecisionStatus(
                WORK_ID,
                DOC_ID,
                USER_ID,
                KbDecisionStatus.ARCHIVED,
            );
            expect(result.decision?.status).toBe('archived');
        });

        it('proposed → archived succeeds (rejecting a proposal)', async () => {
            const doc = buildDocument({ decision: { status: KbDecisionStatus.PROPOSED } });
            docRepo.findById.mockResolvedValue(doc);
            docRepo.update.mockImplementation(async (id, patch) => ({ ...doc, ...patch }));

            const result = await service.transitionDecisionStatus(
                WORK_ID,
                DOC_ID,
                USER_ID,
                KbDecisionStatus.ARCHIVED,
            );
            expect(result.decision?.status).toBe('archived');
        });
    });

    describe('transitionDecisionStatus — illegal transitions → 409', () => {
        it.each([
            [KbDecisionStatus.ACCEPTED, KbDecisionStatus.PROPOSED],
            [KbDecisionStatus.ARCHIVED, KbDecisionStatus.ACCEPTED],
            [KbDecisionStatus.SUPERSEDED, KbDecisionStatus.ACCEPTED],
            [KbDecisionStatus.ACCEPTED, KbDecisionStatus.ACCEPTED],
        ])('%s → %s is rejected with ConflictException', async (current, next) => {
            const doc = buildDocument({ decision: { status: current } });
            docRepo.findById.mockResolvedValue(doc);

            await expect(
                service.transitionDecisionStatus(WORK_ID, DOC_ID, USER_ID, next),
            ).rejects.toBeInstanceOf(ConflictException);
            expect(docRepo.update).not.toHaveBeenCalled();
        });

        it('a non-decision document is rejected with BadRequestException', async () => {
            const doc = buildDocument({
                kbDocumentClass: KbDocumentClass.FREEFORM,
                decision: null,
            });
            docRepo.findById.mockResolvedValue(doc);

            await expect(
                service.transitionDecisionStatus(
                    WORK_ID,
                    DOC_ID,
                    USER_ID,
                    KbDecisionStatus.ACCEPTED,
                ),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('superseding by itself is rejected with BadRequestException', async () => {
            const doc = buildDocument({ decision: { status: KbDecisionStatus.ACCEPTED } });
            docRepo.findById.mockResolvedValue(doc);

            await expect(
                service.transitionDecisionStatus(
                    WORK_ID,
                    DOC_ID,
                    USER_ID,
                    KbDecisionStatus.SUPERSEDED,
                    { supersededByDocId: DOC_ID },
                ),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('a missing superseding document is rejected with NotFoundException', async () => {
            const doc = buildDocument({ decision: { status: KbDecisionStatus.ACCEPTED } });
            docRepo.findById.mockImplementation(async (_workId, id) =>
                id === DOC_ID ? doc : null,
            );

            await expect(
                service.transitionDecisionStatus(
                    WORK_ID,
                    DOC_ID,
                    USER_ID,
                    KbDecisionStatus.SUPERSEDED,
                    { supersededByDocId: SURVIVOR_ID },
                ),
            ).rejects.toBeInstanceOf(NotFoundException);
        });
    });

    // ─── M7 — review-state defaults on creation ────────────────────────

    describe('review-state defaults on creation', () => {
        beforeEach(() => {
            docRepo.create.mockImplementation(async (data) =>
                buildDocument(data as Partial<WorkKnowledgeDocument>),
            );
        });

        it('agent-authored documents land as proposed', async () => {
            await service.createDocument({
                workId: WORK_ID,
                userId: USER_ID,
                path: 'research/agent-note.md',
                title: 'Agent note',
                class: KbDocumentClass.RESEARCH,
                body: 'learned something',
                source: KbDocumentSource.AGENT,
            });

            expect(docRepo.create).toHaveBeenCalledWith(
                expect.objectContaining({ reviewState: KbReviewState.PROPOSED }),
            );
        });

        it('human-authored documents land as accepted', async () => {
            await service.createDocument({
                workId: WORK_ID,
                userId: USER_ID,
                path: 'freeform/note.md',
                title: 'Note',
                class: KbDocumentClass.FREEFORM,
                body: 'a note',
            });

            expect(docRepo.create).toHaveBeenCalledWith(
                expect.objectContaining({ reviewState: KbReviewState.ACCEPTED }),
            );
        });

        it('decision documents are born with decision.status=proposed', async () => {
            await service.createDocument({
                workId: WORK_ID,
                userId: USER_ID,
                path: 'decision/new-call.md',
                title: 'New call',
                class: KbDocumentClass.DECISION,
                body: 'we decided',
            });

            expect(docRepo.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    decision: { status: KbDecisionStatus.PROPOSED },
                }),
            );
        });
    });

    // ─── M7 — review actions ───────────────────────────────────────────

    describe('acceptDocument', () => {
        it('flips reviewState to accepted and accepts a proposed decision', async () => {
            const doc = buildDocument({
                reviewState: KbReviewState.PROPOSED,
                decision: { status: KbDecisionStatus.PROPOSED },
            });
            docRepo.findById.mockResolvedValue(doc);
            docRepo.update.mockImplementation(async (id, patch) => ({ ...doc, ...patch }));

            const result = await service.acceptDocument(WORK_ID, DOC_ID, USER_ID);

            expect(result.reviewState).toBe('accepted');
            expect(result.decision?.status).toBe('accepted');
        });

        it('does not touch the decision status of an already-accepted decision', async () => {
            const doc = buildDocument({
                reviewState: KbReviewState.PROPOSED,
                decision: { status: KbDecisionStatus.ACCEPTED },
            });
            docRepo.findById.mockResolvedValue(doc);
            docRepo.update.mockImplementation(async (id, patch) => ({ ...doc, ...patch }));

            await service.acceptDocument(WORK_ID, DOC_ID, USER_ID);

            const patch = docRepo.update.mock.calls[0][1] as Partial<WorkKnowledgeDocument>;
            expect(patch.reviewState).toBe(KbReviewState.ACCEPTED);
            expect(patch.decision).toBeUndefined();
        });
    });

    describe('archiveDocument', () => {
        it('archives the doc + decision status without ever deleting', async () => {
            const doc = buildDocument({ decision: { status: KbDecisionStatus.ACCEPTED } });
            docRepo.findById.mockResolvedValue(doc);
            docRepo.update.mockImplementation(async (id, patch) => ({ ...doc, ...patch }));

            const result = await service.archiveDocument(WORK_ID, DOC_ID, USER_ID);

            expect(result.status).toBe('archived');
            expect(result.decision?.status).toBe('archived');
            expect(docRepo.delete).not.toHaveBeenCalled();
        });
    });

    // ─── M5 + M7 — context injection ───────────────────────────────────

    describe('resolveContext — injection exclusion + decisions section', () => {
        it('excludes proposed (unreviewed) docs from the always-injected set', async () => {
            const acceptedDoc = buildDocument({
                id: 'accepted-1',
                kbDocumentClass: KbDocumentClass.BRAND,
                decision: null,
                reviewState: KbReviewState.ACCEPTED,
            });
            const proposedDoc = buildDocument({
                id: 'proposed-1',
                kbDocumentClass: KbDocumentClass.BRAND,
                decision: null,
                reviewState: KbReviewState.PROPOSED,
            });
            docRepo.list.mockImplementation(async (filter: { classes?: KbDocumentClass[] }) => {
                if (filter.classes?.includes(KbDocumentClass.DECISION)) {
                    return { items: [], total: 0 };
                }
                return { items: [acceptedDoc, proposedDoc], total: 2 };
            });

            const bundle = await service.resolveContext(WORK_ID);

            expect(bundle.alwaysInjected.map((d) => d.id)).toEqual(['accepted-1']);
        });

        it('includes only ACCEPTED decisions in the decisions slot', async () => {
            const accepted = buildDocument({
                id: 'dec-accepted',
                decision: { status: KbDecisionStatus.ACCEPTED },
            });
            const proposed = buildDocument({
                id: 'dec-proposed',
                decision: { status: KbDecisionStatus.PROPOSED },
            });
            const superseded = buildDocument({
                id: 'dec-superseded',
                decision: { status: KbDecisionStatus.SUPERSEDED },
            });
            const archivedDecision = buildDocument({
                id: 'dec-archived',
                decision: { status: KbDecisionStatus.ARCHIVED },
            });
            const unreviewed = buildDocument({
                id: 'dec-unreviewed',
                decision: { status: KbDecisionStatus.ACCEPTED },
                reviewState: KbReviewState.PROPOSED,
            });
            docRepo.list.mockImplementation(async (filter: { classes?: KbDocumentClass[] }) => {
                if (filter.classes?.includes(KbDocumentClass.DECISION)) {
                    return {
                        items: [accepted, proposed, superseded, archivedDecision, unreviewed],
                        total: 5,
                    };
                }
                return { items: [], total: 0 };
            });

            const bundle = await service.resolveContext(WORK_ID);

            expect(bundle.decisions.map((d) => d.id)).toEqual(['dec-accepted']);
        });

        it('drops proposed docs from query retrieval and ranks decisions around generics', async () => {
            const generic = buildDocument({
                id: 'generic-1',
                kbDocumentClass: KbDocumentClass.RESEARCH,
                slug: 'note',
                decision: null,
            });
            const acceptedDecision = buildDocument({
                id: 'dec-1',
                decision: { status: KbDecisionStatus.ACCEPTED },
            });
            const historicalDecision = buildDocument({
                id: 'dec-2',
                slug: 'old-call',
                decision: {
                    status: KbDecisionStatus.SUPERSEDED,
                    supersededByDocId: 'dec-1',
                    supersededBySlug: 'context-store',
                },
            });
            const proposedDoc = buildDocument({
                id: 'proposed-1',
                kbDocumentClass: KbDocumentClass.RESEARCH,
                decision: null,
                reviewState: KbReviewState.PROPOSED,
            });
            const byId = new Map([
                [generic.id, generic],
                [acceptedDecision.id, acceptedDecision],
                [historicalDecision.id, historicalDecision],
                [proposedDoc.id, proposedDoc],
            ]);
            docRepo.list.mockResolvedValue({ items: [], total: 0 });
            docRepo.findById.mockImplementation(async (_workId, id) => byId.get(id) ?? null);
            jest.spyOn(service, 'semanticSearch').mockResolvedValue([
                { documentId: 'proposed-1' },
                { documentId: 'generic-1' },
                { documentId: 'dec-2' },
                { documentId: 'dec-1' },
            ] as never);

            const bundle = await service.resolveContext(WORK_ID, { query: 'context storage' });

            // proposed-1 excluded; accepted decision first, generic second,
            // historical decision demoted to the tail.
            expect(bundle.queryRetrieved.map((d) => d.id)).toEqual(['dec-1', 'generic-1', 'dec-2']);
        });
    });
});

// ─── M5 — per-class rendering in the <kb> block ───────────────────────

describe('formatKbContext — decision rendering (Wave 5 M5)', () => {
    it('renders an accepted decision with a status prefix under the labelled section', () => {
        const block = formatKbContext([
            buildBodyDto({
                decision: { status: 'accepted', rationale: 'files beat databases here' },
                body: 'Context stays in files.',
            }),
        ]);

        expect(block).toContain('# Decisions — settled calls; do not reverse without flagging');
        expect(block).toContain(
            '## [decision: accepted] Context lives in files (kb:decision/context-store)',
        );
        expect(block).toContain('Rationale: files beat databases here');
        expect(block).toContain('Context stays in files.');
    });

    it('labels a superseded decision historical and promotes the replacement citation', () => {
        const block = formatKbContext([
            buildBodyDto({
                slug: 'old-call',
                title: 'Old call',
                decision: {
                    status: 'superseded',
                    supersededByDocId: SURVIVOR_ID,
                    supersededBySlug: 'new-call',
                },
            }),
        ]);

        expect(block).toContain(
            '## [decision: superseded — historical; replaced by kb:decision/new-call] Old call (kb:decision/old-call)',
        );
    });

    it('labels an archived decision historical without a replacement', () => {
        const block = formatKbContext([buildBodyDto({ decision: { status: 'archived' } })]);

        expect(block).toContain('## [decision: archived — historical]');
        expect(block).not.toContain('replaced by');
    });

    it('emits the decisions section label exactly once for multiple decisions', () => {
        const block = formatKbContext([
            buildBodyDto({ id: 'd1', slug: 'one', decision: { status: 'accepted' } }),
            buildBodyDto({ id: 'd2', slug: 'two', decision: { status: 'accepted' } }),
        ]);

        const labels = block.match(/# Decisions — settled calls/g) ?? [];
        expect(labels).toHaveLength(1);
    });

    it('leaves non-decision docs untouched (no section label, no prefix)', () => {
        const block = formatKbContext([
            buildBodyDto({ class: 'brand', slug: 'voice', title: 'Voice', decision: null }),
        ]);

        expect(block).toBe('<kb>\n## Voice (kb:brand/voice)\ndecision body\n</kb>');
    });
});

describe('buildKbContextBundle — decisions slot (Wave 5 M5)', () => {
    it('groups decisions between always-injected and generic query docs in format()', () => {
        const always = buildBodyDto({ id: 'a1', class: 'brand', slug: 'voice', title: 'Voice' });
        const decision = buildBodyDto({
            id: 'd1',
            slug: 'call',
            title: 'The call',
            decision: { status: 'accepted' },
        });
        const generic = buildBodyDto({
            id: 'q1',
            class: 'research',
            slug: 'note',
            title: 'Note',
        });
        const historical = buildBodyDto({
            id: 'q2',
            slug: 'old',
            title: 'Old',
            decision: { status: 'superseded' },
        });

        const bundle = buildKbContextBundle([always], [generic, historical], [decision]);
        const block = bundle.format();

        const order = [
            block.indexOf('(kb:brand/voice)'),
            block.indexOf('[decision: accepted]'),
            block.indexOf('[decision: superseded — historical]'),
            block.indexOf('(kb:research/note)'),
        ];
        expect(order.every((i) => i >= 0)).toBe(true);
        // always-injected → decisions section (accepted, then historical
        // query hit) → generic query docs.
        expect([...order].sort((a, b) => a - b)).toEqual(order);
    });

    it('dedupes queryRetrieved against the decisions slot by id', () => {
        const decision = buildBodyDto({ id: 'd1', decision: { status: 'accepted' } });
        const bundle = buildKbContextBundle([], [decision], [decision]);

        expect(bundle.decisions).toHaveLength(1);
        expect(bundle.queryRetrieved).toHaveLength(0);
    });

    it('keeps the empty-bundle contract when no decisions exist', () => {
        const bundle = buildKbContextBundle([], [], []);
        expect(bundle.decisions).toEqual([]);
        expect(bundle.format()).toBe('<kb>\n</kb>');
    });
});
