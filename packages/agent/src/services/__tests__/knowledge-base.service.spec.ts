import {
    BadRequestException,
    ForbiddenException,
    NotFoundException,
    ServiceUnavailableException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { KB_STORAGE_PLUGIN, KnowledgeBaseService } from '../knowledge-base.service';
import { KB_EMBED_DOCUMENT_DISPATCHER } from '../../tasks/kb-embed-document-dispatcher';
import { KB_ORG_OVERLAY_FANOUT_DISPATCHER } from '../../tasks/kb-org-overlay-fanout-dispatcher';
import { KB_MIRROR_DOCUMENT_DISPATCHER } from '../../tasks/kb-mirror-document-dispatcher';
import { KB_NORMALIZE_MEDIA_DISPATCHER } from '../../tasks/kb-normalize-media-dispatcher';
import { RuntimeBindingStamperService } from '../../tasks/runtime-binding-stamper.service';
import { OrganizationRepository } from '../../database/repositories/organization.repository';
import { WorkRepository } from '../../database/repositories/work.repository';
import { KnowledgeBaseBufferExtractorService } from '../knowledge-base-buffer-extractor.service';
import { WorkKnowledgeDocumentRepository } from '../../database/repositories/work-knowledge-document.repository';
import { WorkKnowledgeUploadRepository } from '../../database/repositories/work-knowledge-upload.repository';
import { WorkKnowledgeTagRepository } from '../../database/repositories/work-knowledge-tag.repository';
import { WorkKnowledgeCitationRepository } from '../../database/repositories/work-knowledge-citation.repository';
import { WorkOwnershipService } from '../work-ownership.service';
import { ActivityLogService } from '../../activity-log/activity-log.service';
import { ActivityActionType } from '../../entities/activity-log.types';
import { WorkKnowledgeDocument } from '../../entities/work-knowledge-document.entity';
import { WorkKnowledgeUpload } from '../../entities/work-knowledge-upload.entity';
import {
    KbDocumentClass,
    KbDocumentSource,
    KbDocumentStatus,
    KbLockMode,
    KbUploadExtractionStatus,
} from '../../entities/kb-types';

const WORK_ID = '00000000-0000-0000-0000-000000000001';
const ORG_ID = '00000000-0000-0000-0000-0000000000aa';
const USER_ID = '00000000-0000-0000-0000-000000000002';

function buildDocument(overrides: Partial<WorkKnowledgeDocument> = {}): WorkKnowledgeDocument {
    return {
        id: '00000000-0000-0000-0000-000000000010',
        workId: WORK_ID,
        organizationId: null,
        path: 'brand/voice.md',
        slug: 'voice',
        title: 'Brand voice',
        description: null,
        kbDocumentClass: 'brand' as KbDocumentClass,
        tags: null,
        categories: null,
        status: 'active' as KbDocumentStatus,
        locked: false,
        lockMode: null,
        language: 'en',
        wordCount: 0,
        tokenCount: 0,
        source: 'user' as KbDocumentSource,
        sourceUploadId: null,
        sourceUrl: null,
        generatedByAgentRunId: null,
        createdById: USER_ID,
        updatedById: USER_ID,
        lastIndexedAt: null,
        lastCommitSha: null,
        metadata: null,
        createdAt: new Date('2026-05-21T12:00:00Z'),
        updatedAt: new Date('2026-05-21T12:00:00Z'),
        ...overrides,
    } as WorkKnowledgeDocument;
}

describe('KnowledgeBaseService', () => {
    let service: KnowledgeBaseService;
    let docRepo: jest.Mocked<WorkKnowledgeDocumentRepository>;
    let uploadRepo: jest.Mocked<WorkKnowledgeUploadRepository>;
    let tagRepo: jest.Mocked<WorkKnowledgeTagRepository>;
    let ownership: jest.Mocked<WorkOwnershipService>;
    let storage: jest.Mocked<{
        providerName: string;
        putObject: jest.Mock;
        getObject: jest.Mock;
        deleteObject: jest.Mock;
        isAvailable: jest.Mock;
    }>;
    let activityLog: jest.Mocked<{ log: jest.Mock }>;
    let embedDispatcher: jest.Mocked<{ dispatchKbEmbedDocument: jest.Mock }>;

    beforeEach(async () => {
        const docRepoMock: Partial<jest.Mocked<WorkKnowledgeDocumentRepository>> = {
            findById: jest.fn(),
            findByPath: jest.fn(),
            findOrgById: jest.fn(),
            findOrgByPath: jest.fn(),
            findByWorkOrPath: jest.fn(),
            list: jest.fn(),
            listInheritableForOrg: jest.fn(),
            listWorkOverridesForClasses: jest.fn(),
            pathExists: jest.fn().mockResolvedValue(false),
            create: jest.fn(),
            update: jest.fn(),
            delete: jest.fn().mockResolvedValue(true),
            setLock: jest.fn(),
        };

        const uploadRepoMock: Partial<jest.Mocked<WorkKnowledgeUploadRepository>> = {
            findById: jest.fn(),
            findBySha256: jest.fn().mockResolvedValue(null),
            list: jest.fn().mockResolvedValue([]),
            listPaged: jest.fn().mockResolvedValue({ items: [], total: 0 }),
            create: jest.fn(),
            update: jest.fn(),
            delete: jest.fn(),
        };

        const tagRepoMock: Partial<jest.Mocked<WorkKnowledgeTagRepository>> = {
            list: jest.fn().mockResolvedValue([]),
            findBySlug: jest.fn(),
            findById: jest.fn(),
            create: jest.fn(),
            upsertBySlug: jest.fn(),
            update: jest.fn(),
            delete: jest.fn(),
        };

        const ownershipMock: Partial<jest.Mocked<WorkOwnershipService>> = {
            ensureCanView: jest.fn().mockResolvedValue({ role: 'editor' } as any),
            ensureCanEdit: jest.fn().mockResolvedValue({ role: 'editor' } as any),
        };

        const storageMock = {
            providerName: 'local-fs',
            putObject: jest.fn(),
            getObject: jest.fn(),
            deleteObject: jest.fn(),
            isAvailable: jest.fn().mockResolvedValue(true),
        };

        const activityLogMock = { log: jest.fn() };

        const embedDispatcherMock = {
            dispatchKbEmbedDocument: jest.fn().mockResolvedValue('run-id'),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                KnowledgeBaseService,
                { provide: WorkKnowledgeDocumentRepository, useValue: docRepoMock },
                { provide: WorkKnowledgeUploadRepository, useValue: uploadRepoMock },
                { provide: WorkKnowledgeTagRepository, useValue: tagRepoMock },
                {
                    provide: WorkKnowledgeCitationRepository,
                    useValue: { listForDocument: jest.fn().mockResolvedValue([]) },
                },
                { provide: WorkOwnershipService, useValue: ownershipMock },
                { provide: KB_STORAGE_PLUGIN, useValue: storageMock },
                { provide: ActivityLogService, useValue: activityLogMock },
                { provide: KB_EMBED_DOCUMENT_DISPATCHER, useValue: embedDispatcherMock },
            ],
        }).compile();

        service = module.get(KnowledgeBaseService);
        docRepo = module.get(WorkKnowledgeDocumentRepository);
        uploadRepo = module.get(WorkKnowledgeUploadRepository);
        tagRepo = module.get(WorkKnowledgeTagRepository);
        ownership = module.get(WorkOwnershipService);
        storage = module.get(KB_STORAGE_PLUGIN);
        activityLog = module.get(ActivityLogService);
        embedDispatcher = module.get(KB_EMBED_DOCUMENT_DISPATCHER);
    });

    describe('listDocuments', () => {
        it('returns mapped DTOs for the caller', async () => {
            docRepo.list.mockResolvedValue({ items: [buildDocument()], total: 1 });

            const result = await service.listDocuments(WORK_ID, USER_ID);

            expect(ownership.ensureCanView).toHaveBeenCalledWith(WORK_ID, USER_ID);
            expect(result.total).toBe(1);
            expect(result.items[0]).toMatchObject({
                id: expect.any(String),
                path: 'brand/voice.md',
                class: 'brand',
            });
        });

        it('forwards filters to the repository', async () => {
            docRepo.list.mockResolvedValue({ items: [], total: 0 });

            await service.listDocuments(WORK_ID, USER_ID, {
                class: 'legal' as KbDocumentClass,
                tag: 'gdpr',
                locked: true,
                limit: 10,
            });

            expect(docRepo.list).toHaveBeenCalledWith(
                expect.objectContaining({
                    workId: WORK_ID,
                    classes: ['legal'],
                    tag: 'gdpr',
                    locked: true,
                    limit: 10,
                }),
            );
        });

        it('falls back to lexical-only when q is set but semantic returns nothing (no embedder configured)', async () => {
            // Default test module doesn't wire `aiFacade` / `chunkRepository`,
            // so semanticSearch returns []. The RRF blend short-circuits
            // and the row-30c path delivers lexical-only with the
            // requested limit/offset preserved.
            const docs = [
                buildDocument({ id: 'd1', title: 'first' }),
                buildDocument({ id: 'd2', title: 'second' }),
            ];
            docRepo.list.mockResolvedValue({ items: docs, total: 2 });

            const result = await service.listDocuments(WORK_ID, USER_ID, {
                q: 'voice',
                limit: 10,
            });

            // q was passed through to the repo (lexical leg).
            expect(docRepo.list).toHaveBeenCalledWith(expect.objectContaining({ q: 'voice' }));
            expect(result.items.map((d) => d.id)).toEqual(['d1', 'd2']);
            expect(result.total).toBe(2);
        });

        it('treats whitespace-only q as no q (preserves existing list behavior)', async () => {
            docRepo.list.mockResolvedValue({ items: [], total: 0 });

            await service.listDocuments(WORK_ID, USER_ID, { q: '   \t  ' });

            // The repo call should receive q: undefined (not the whitespace string),
            // matching the existing pre-row-30c contract.
            expect(docRepo.list).toHaveBeenCalledWith(expect.objectContaining({ q: undefined }));
        });
    });

    describe('getDocument', () => {
        it('returns the body DTO when found', async () => {
            const doc = buildDocument({
                metadata: { body: '# Voice\n\nFriendly and direct.' },
            });
            docRepo.findByWorkOrPath.mockResolvedValue(doc);

            const result = await service.getDocument(WORK_ID, doc.id, USER_ID);

            expect(result.body).toContain('Friendly and direct');
            expect(result.assets).toEqual([]);
        });

        it('throws NotFoundException when missing', async () => {
            docRepo.findByWorkOrPath.mockResolvedValue(null);

            await expect(service.getDocument(WORK_ID, 'missing', USER_ID)).rejects.toBeInstanceOf(
                NotFoundException,
            );
        });
    });

    // EW-641 Phase 2/e row 38c-2 — read the body of an org-scope doc
    // that the user's Work inherits from. Used by the workbench detail
    // page as a fallback when the per-Work getDocument 404s.
    describe('getInheritedDocument', () => {
        it('uses findOrgByPath when idOrPath looks like a path (contains "/" or ends in .md)', async () => {
            const orgDoc = buildDocument({
                id: 'org-doc-1',
                workId: null,
                organizationId: ORG_ID,
                path: 'legal/privacy.md',
                slug: 'privacy',
                kbDocumentClass: 'legal' as KbDocumentClass,
                metadata: { body: 'Verbatim privacy text.' },
            });
            docRepo.findOrgByPath.mockResolvedValue(orgDoc);

            const result = await service.getInheritedDocument(
                WORK_ID,
                ORG_ID,
                'legal/privacy.md',
                USER_ID,
            );

            expect(ownership.ensureCanView).toHaveBeenCalledWith(WORK_ID, USER_ID);
            expect(docRepo.findOrgByPath).toHaveBeenCalledWith(ORG_ID, 'legal/privacy.md');
            expect(docRepo.findOrgById).not.toHaveBeenCalled();
            expect(result.id).toBe('org-doc-1');
            expect(result.workId).toBeNull();
            expect(result.organizationId).toBe(ORG_ID);
            expect(result.body).toContain('Verbatim privacy text');
        });

        it('uses findOrgById when idOrPath is a bare id (no "/" or .md)', async () => {
            const orgDoc = buildDocument({
                id: 'org-doc-2',
                workId: null,
                organizationId: ORG_ID,
                path: 'style/voice.md',
                kbDocumentClass: 'style' as KbDocumentClass,
            });
            docRepo.findOrgById.mockResolvedValue(orgDoc);

            await service.getInheritedDocument(WORK_ID, ORG_ID, 'org-doc-2', USER_ID);

            expect(docRepo.findOrgById).toHaveBeenCalledWith(ORG_ID, 'org-doc-2');
            expect(docRepo.findOrgByPath).not.toHaveBeenCalled();
        });

        it('throws NotFoundException when no org-scope row matches the path', async () => {
            docRepo.findOrgByPath.mockResolvedValue(null);

            await expect(
                service.getInheritedDocument(WORK_ID, ORG_ID, 'legal/missing.md', USER_ID),
            ).rejects.toBeInstanceOf(NotFoundException);
        });

        it('throws NotFoundException when no org-scope row matches the id', async () => {
            docRepo.findOrgById.mockResolvedValue(null);

            await expect(
                service.getInheritedDocument(WORK_ID, ORG_ID, 'nonexistent-id', USER_ID),
            ).rejects.toBeInstanceOf(NotFoundException);
        });

        it('enforces canView on the Work (same gate as getDocument)', async () => {
            ownership.ensureCanView.mockRejectedValueOnce(new ForbiddenException('no access'));

            await expect(
                service.getInheritedDocument(WORK_ID, ORG_ID, 'legal/privacy.md', USER_ID),
            ).rejects.toBeInstanceOf(ForbiddenException);

            // No DB lookup ran because the gate rejected first.
            expect(docRepo.findOrgByPath).not.toHaveBeenCalled();
            expect(docRepo.findOrgById).not.toHaveBeenCalled();
        });
    });

    describe('getDocumentBodyForEmbedding', () => {
        it('returns the body DTO without invoking ensureCanView (system-op)', async () => {
            const doc = buildDocument({
                metadata: { body: '# Voice\n\nFriendly and direct.' },
            });
            docRepo.findByWorkOrPath.mockResolvedValue(doc);

            const result = await service.getDocumentBodyForEmbedding(WORK_ID, doc.id);

            expect(result?.body).toContain('Friendly and direct');
            // Embed task is system-triggered — must NOT call ensureCanView.
            expect(ownership.ensureCanView).not.toHaveBeenCalled();
        });

        it('returns null on missing doc (race-with-delete, not throw)', async () => {
            docRepo.findByWorkOrPath.mockResolvedValue(null);

            const result = await service.getDocumentBodyForEmbedding(WORK_ID, 'missing-id');

            expect(result).toBeNull();
            expect(ownership.ensureCanView).not.toHaveBeenCalled();
        });
    });

    describe('semanticSearch', () => {
        // The default test module doesn't wire `chunkRepository` or
        // `aiFacade` — same shape as an OSS deployment with no
        // embedding configured. These tests pin the lexical-only
        // graceful-fallback paths. End-to-end semantic + RRF blend is
        // covered by row 47's A22 e2e (embedding within 60s).

        it('returns [] when chunk repo / AI facade are not wired', async () => {
            const result = await service.semanticSearch(WORK_ID, 'hello', 5);
            expect(result).toEqual([]);
        });

        it('returns [] for empty/whitespace query (embedder not called)', async () => {
            const result = await service.semanticSearch(WORK_ID, '   \n  ', 5);
            expect(result).toEqual([]);
        });

        it('returns [] for limit <= 0', async () => {
            const result = await service.semanticSearch(WORK_ID, 'hi', 0);
            expect(result).toEqual([]);
        });
    });

    describe('resolveContext', () => {
        // EW-641 Phase 2/b row 32a — the bundle the pipeline plugin
        // invocation reads (row 32b wires it in). The default test
        // module doesn't wire `chunkRepository` / `aiFacade`, so
        // `semanticSearch` returns []; the bundle therefore only ever
        // contains the always-injected docs unless we reflect a stub
        // in (mirror's the `mirrorService` pattern above).

        it('returns alwaysInjected docs without query (semantic not consulted)', async () => {
            const brandDoc = buildDocument({
                id: 'b-1',
                kbDocumentClass: 'brand' as KbDocumentClass,
                path: 'brand/voice.md',
                slug: 'voice',
                title: 'Brand voice',
                metadata: { body: 'Friendly.' },
            });
            const legalDoc = buildDocument({
                id: 'l-1',
                kbDocumentClass: 'legal' as KbDocumentClass,
                path: 'legal/terms.md',
                slug: 'terms',
                title: 'Terms',
                metadata: { body: 'Verbatim.' },
            });
            docRepo.list.mockResolvedValue({ items: [brandDoc, legalDoc], total: 2 });

            const bundle = await service.resolveContext(WORK_ID);

            // System op — must NOT call ensureCanView (pipeline plugin
            // is the trust boundary).
            expect(ownership.ensureCanView).not.toHaveBeenCalled();

            expect(bundle.alwaysInjected.map((d) => d.id)).toEqual(['b-1', 'l-1']);
            expect(bundle.queryRetrieved).toEqual([]);

            // Always-injected whitelist + active-only filter is what the
            // service forwards to the repo.
            expect(docRepo.list).toHaveBeenCalledWith(
                expect.objectContaining({
                    workId: WORK_ID,
                    classes: expect.arrayContaining(['brand', 'legal', 'style', 'glossary']),
                    statuses: ['active'],
                }),
            );

            const rendered = bundle.format();
            expect(rendered).toContain('<kb>');
            expect(rendered).toContain('## Brand voice (kb:brand/voice)');
            expect(rendered).toContain('## Terms (kb:legal/terms)');
            expect(rendered).toContain('</kb>');
        });

        it('returns alwaysInjected only when query is set but embedder is unavailable', async () => {
            const brandDoc = buildDocument({
                id: 'b-2',
                kbDocumentClass: 'brand' as KbDocumentClass,
                metadata: { body: 'B body' },
            });
            docRepo.list.mockResolvedValue({ items: [brandDoc], total: 1 });

            const bundle = await service.resolveContext(WORK_ID, { query: 'hello world' });

            // No embedder/chunkRepo wired in the default module ⇒
            // semanticSearch returns []; queryRetrieved degrades to [].
            expect(bundle.queryRetrieved).toEqual([]);
            expect(bundle.alwaysInjected).toHaveLength(1);
        });

        it('treats whitespace-only query as no query (semantic skipped)', async () => {
            docRepo.list.mockResolvedValue({ items: [], total: 0 });
            // Sentinel — if semantic were consulted we'd see a mocked
            // call below. The default module has no `chunkRepository`,
            // so reflect a strict stub in and assert it stays untouched.
            const chunkRepoStub = { findNearestByEmbedding: jest.fn() };
            (service as unknown as { chunkRepository: typeof chunkRepoStub }).chunkRepository =
                chunkRepoStub;

            await service.resolveContext(WORK_ID, { query: '   \n  ' });

            expect(chunkRepoStub.findNearestByEmbedding).not.toHaveBeenCalled();
        });

        it('layers queryRetrieved (semantic hits) on top of alwaysInjected, dedup by id', async () => {
            const sharedId = '00000000-0000-0000-0000-0000000000aa';
            const sharedAlways = buildDocument({
                id: sharedId,
                kbDocumentClass: 'brand' as KbDocumentClass,
                path: 'brand/voice.md',
                slug: 'voice',
                title: 'Brand voice',
                metadata: { body: 'Always copy' },
            });
            const semanticOnly = buildDocument({
                id: 'semantic-only',
                kbDocumentClass: 'research' as KbDocumentClass,
                path: 'research/note.md',
                slug: 'note',
                title: 'Research note',
                metadata: { body: 'Semantic body' },
            });

            // Stub out semantic deps so semanticSearch returns chunks.
            const aiFacadeStub = {
                embed: jest.fn().mockResolvedValue({ embeddings: [[0.1, 0.2, 0.3]] }),
            };
            const chunkRepoStub = {
                findNearestByEmbedding: jest.fn().mockResolvedValue([
                    {
                        id: 'c1',
                        workId: WORK_ID,
                        documentId: sharedId,
                        chunkIndex: 0,
                        content: 'chunk a',
                        distance: 0.1,
                    },
                    {
                        id: 'c2',
                        workId: WORK_ID,
                        documentId: 'semantic-only',
                        chunkIndex: 0,
                        content: 'chunk b',
                        distance: 0.2,
                    },
                ]),
            };
            (service as unknown as { chunkRepository: typeof chunkRepoStub }).chunkRepository =
                chunkRepoStub;
            (service as unknown as { aiFacade: typeof aiFacadeStub }).aiFacade = aiFacadeStub;

            // First call (alwaysInjected fetch) returns sharedAlways.
            docRepo.list.mockResolvedValue({ items: [sharedAlways], total: 1 });
            // For the per-id semantic materialization, findById serves
            // both ids — including the dup we'll drop.
            docRepo.findById.mockImplementation(async (_workId: string, docId: string) => {
                if (docId === sharedId) return sharedAlways;
                if (docId === 'semantic-only') return semanticOnly;
                return null;
            });

            const bundle = await service.resolveContext(WORK_ID, {
                query: 'voice tone',
                limit: 5,
            });

            // alwaysInjected wins the dedup: only the semantic-only doc
            // survives in queryRetrieved.
            expect(bundle.alwaysInjected.map((d) => d.id)).toEqual([sharedId]);
            expect(bundle.queryRetrieved.map((d) => d.id)).toEqual(['semantic-only']);

            const rendered = bundle.format();
            // Both docs rendered, in priority order.
            const brandIdx = rendered.indexOf('## Brand voice (kb:brand/voice)');
            const researchIdx = rendered.indexOf('## Research note (kb:research/note)');
            expect(brandIdx).toBeGreaterThanOrEqual(0);
            expect(researchIdx).toBeGreaterThan(brandIdx);
            // The semantic body of the dup is NOT in the rendered output
            // (alwaysInjected copy is what got emitted).
            expect(rendered).toContain('Always copy');
        });

        // ── Consolidation supersession (memory M1) ─────────────────────
        // The consolidation apply pass marks near-duplicate losers
        // `consolidation.state='superseded'` but leaves status ACTIVE
        // (never-delete invariant). resolveContext must not serve those
        // archived docs as current truth.

        function stubSemanticHit(docIds: string[]) {
            const aiFacadeStub = {
                embed: jest.fn().mockResolvedValue({ embeddings: [[0.1, 0.2, 0.3]] }),
            };
            const chunkRepoStub = {
                findNearestByEmbedding: jest.fn().mockResolvedValue(
                    docIds.map((documentId, i) => ({
                        id: `c${i}`,
                        workId: WORK_ID,
                        documentId,
                        chunkIndex: 0,
                        content: `chunk ${i}`,
                        distance: 0.1 * (i + 1),
                    })),
                ),
            };
            (service as unknown as { chunkRepository: typeof chunkRepoStub }).chunkRepository =
                chunkRepoStub;
            (service as unknown as { aiFacade: typeof aiFacadeStub }).aiFacade = aiFacadeStub;
        }

        it('excludes consolidation-superseded docs from alwaysInjected (survivor stays)', async () => {
            const survivor = buildDocument({
                id: 'surv-1',
                kbDocumentClass: 'brand' as KbDocumentClass,
                metadata: { body: 'Current truth' },
            });
            const loser = buildDocument({
                id: 'lose-1',
                kbDocumentClass: 'brand' as KbDocumentClass,
                metadata: { body: 'Archived near-dup' },
                consolidation: {
                    state: 'superseded',
                    supersededById: 'surv-1',
                    reason: 'near-duplicate of Current truth',
                    runAt: '2026-07-23T00:00:00.000Z',
                },
            });
            docRepo.list.mockResolvedValue({ items: [survivor, loser], total: 2 });

            const bundle = await service.resolveContext(WORK_ID);

            expect(bundle.alwaysInjected.map((d) => d.id)).toEqual(['surv-1']);
            expect(bundle.format()).not.toContain('Archived near-dup');
        });

        it('serves a promoted doc normally (only superseded is demoted)', async () => {
            const promoted = buildDocument({
                id: 'promo-1',
                kbDocumentClass: 'brand' as KbDocumentClass,
                metadata: { body: 'Promoted body' },
                consolidation: {
                    state: 'promoted',
                    score: 42,
                    reason: 'promotion score 42',
                    runAt: '2026-07-23T00:00:00.000Z',
                },
            });
            docRepo.list.mockResolvedValue({ items: [promoted], total: 1 });

            const bundle = await service.resolveContext(WORK_ID);

            expect(bundle.alwaysInjected.map((d) => d.id)).toEqual(['promo-1']);
        });

        it('substitutes the survivor when semantic retrieval hits a superseded doc', async () => {
            const survivor = buildDocument({
                id: 'surv-2',
                kbDocumentClass: 'research' as KbDocumentClass,
                path: 'research/current.md',
                slug: 'current',
                title: 'Current finding',
                metadata: { body: 'Live finding' },
            });
            const loser = buildDocument({
                id: 'lose-2',
                kbDocumentClass: 'research' as KbDocumentClass,
                metadata: { body: 'Stale finding' },
                consolidation: {
                    state: 'superseded',
                    supersededById: 'surv-2',
                    reason: 'near-duplicate',
                    runAt: '2026-07-23T00:00:00.000Z',
                },
            });
            // Chunk embeddings outlive consolidation: the hit lands on
            // the LOSER. Also hit the survivor directly to prove the
            // substitution dedupes to a single entry.
            stubSemanticHit(['lose-2', 'surv-2']);
            docRepo.list.mockResolvedValue({ items: [], total: 0 });
            docRepo.findById.mockImplementation(async (_workId: string, docId: string) => {
                if (docId === 'lose-2') return loser;
                if (docId === 'surv-2') return survivor;
                return null;
            });

            const bundle = await service.resolveContext(WORK_ID, { query: 'finding' });

            expect(bundle.queryRetrieved.map((d) => d.id)).toEqual(['surv-2']);
            const rendered = bundle.format();
            expect(rendered).toContain('Live finding');
            expect(rendered).not.toContain('Stale finding');
        });

        it('over-fetches chunk hits so converging chains do not under-fill the doc limit', async () => {
            const survivor = buildDocument({
                id: 'conv-surv',
                kbDocumentClass: 'research' as KbDocumentClass,
                metadata: { body: 'Converged survivor' },
            });
            const loserA = buildDocument({
                id: 'conv-a',
                kbDocumentClass: 'research' as KbDocumentClass,
                consolidation: {
                    state: 'superseded',
                    supersededById: 'conv-surv',
                    reason: 'x',
                    runAt: '2026-07-23T00:00:00.000Z',
                },
            });
            const loserB = buildDocument({
                id: 'conv-b',
                kbDocumentClass: 'research' as KbDocumentClass,
                consolidation: {
                    state: 'superseded',
                    supersededById: 'conv-surv',
                    reason: 'x',
                    runAt: '2026-07-23T00:00:00.000Z',
                },
            });
            const distinct = buildDocument({
                id: 'conv-c',
                kbDocumentClass: 'research' as KbDocumentClass,
                metadata: { body: 'Distinct third doc' },
            });
            // limit=2, but the top-2 hits converge on ONE survivor. The 2×
            // over-fetch surfaces the third hit so the limit is still met.
            stubSemanticHit(['conv-a', 'conv-b', 'conv-c']);
            docRepo.list.mockResolvedValue({ items: [], total: 0 });
            docRepo.findById.mockImplementation(async (_workId: string, docId: string) => {
                if (docId === 'conv-a') return loserA;
                if (docId === 'conv-b') return loserB;
                if (docId === 'conv-surv') return survivor;
                if (docId === 'conv-c') return distinct;
                return null;
            });

            const bundle = await service.resolveContext(WORK_ID, { query: 'q', limit: 2 });

            expect(bundle.queryRetrieved.map((d) => d.id)).toEqual(['conv-surv', 'conv-c']);
            // The widened chunk fetch is what makes the backfill possible.
            const chunkRepo = (
                service as unknown as {
                    chunkRepository: { findNearestByEmbedding: jest.Mock };
                }
            ).chunkRepository;
            expect(chunkRepo.findNearestByEmbedding).toHaveBeenCalledWith(
                WORK_ID,
                expect.anything(),
                4,
            );
        });

        it('caps the supersession walk (a pathological chain cannot stall resolution)', async () => {
            // 20-link acyclic chain: doc-0 → doc-1 → … → doc-19 (live).
            const chain = new Map<string, ReturnType<typeof buildDocument>>();
            for (let i = 0; i < 20; i++) {
                const id = `chain-${i}`;
                chain.set(
                    id,
                    buildDocument({
                        id,
                        kbDocumentClass: 'research' as KbDocumentClass,
                        metadata: { body: `link ${i}` },
                        consolidation:
                            i < 19
                                ? {
                                      state: 'superseded',
                                      supersededById: `chain-${i + 1}`,
                                      reason: 'x',
                                      runAt: '2026-07-23T00:00:00.000Z',
                                  }
                                : null,
                    }),
                );
            }
            stubSemanticHit(['chain-0']);
            docRepo.list.mockResolvedValue({ items: [], total: 0 });
            docRepo.findById.mockImplementation(
                async (_workId: string, docId: string) => chain.get(docId) ?? null,
            );

            const bundle = await service.resolveContext(WORK_ID, { query: 'q' });

            // The walk gives up at the hop cap instead of serving the
            // archive or walking all 20 links — bounded DB cost.
            expect(bundle.queryRetrieved).toEqual([]);
            expect(docRepo.findById.mock.calls.length).toBeLessThanOrEqual(8);
        });

        it('drops a superseded hit whose chain dead-ends or cycles (never serves the archive)', async () => {
            const cycleA = buildDocument({
                id: 'cyc-a',
                kbDocumentClass: 'research' as KbDocumentClass,
                metadata: { body: 'Cycle A' },
                consolidation: {
                    state: 'superseded',
                    supersededById: 'cyc-b',
                    reason: 'x',
                    runAt: '2026-07-23T00:00:00.000Z',
                },
            });
            const cycleB = buildDocument({
                id: 'cyc-b',
                kbDocumentClass: 'research' as KbDocumentClass,
                metadata: { body: 'Cycle B' },
                consolidation: {
                    state: 'superseded',
                    supersededById: 'cyc-a',
                    reason: 'x',
                    runAt: '2026-07-23T00:00:00.000Z',
                },
            });
            const noSurvivor = buildDocument({
                id: 'dead-1',
                kbDocumentClass: 'research' as KbDocumentClass,
                metadata: { body: 'Dead end' },
                consolidation: {
                    state: 'superseded',
                    supersededById: 'gone-1',
                    reason: 'x',
                    runAt: '2026-07-23T00:00:00.000Z',
                },
            });
            stubSemanticHit(['cyc-a', 'dead-1']);
            docRepo.list.mockResolvedValue({ items: [], total: 0 });
            docRepo.findById.mockImplementation(async (_workId: string, docId: string) => {
                if (docId === 'cyc-a') return cycleA;
                if (docId === 'cyc-b') return cycleB;
                if (docId === 'dead-1') return noSurvivor;
                return null;
            });

            const bundle = await service.resolveContext(WORK_ID, { query: 'anything' });

            expect(bundle.queryRetrieved).toEqual([]);
            const rendered = bundle.format();
            expect(rendered).not.toContain('Cycle A');
            expect(rendered).not.toContain('Dead end');
        });
    });

    describe('getDocumentHistory', () => {
        it('returns an empty history when the mirror service is not wired', async () => {
            const doc = buildDocument();
            docRepo.findByWorkOrPath.mockResolvedValue(doc);
            // The default test module doesn't wire `KnowledgeBaseGitMirrorService`,
            // so the stub should short-circuit to `{ items: [] }` rather than
            // throw — operators on OSS deployments without git-provider plugin
            // still see the dialog, just empty.
            const result = await service.getDocumentHistory(WORK_ID, doc.id, USER_ID);
            expect(result).toEqual({ items: [] });
        });

        it('throws NotFoundException when the document is missing', async () => {
            docRepo.findByWorkOrPath.mockResolvedValue(null);
            await expect(
                service.getDocumentHistory(WORK_ID, 'missing', USER_ID),
            ).rejects.toBeInstanceOf(NotFoundException);
        });

        it('enforces canView (the same gate as listDocuments / getDocument)', async () => {
            const doc = buildDocument();
            docRepo.findByWorkOrPath.mockResolvedValue(doc);
            ownership.ensureCanView.mockRejectedValueOnce(new ForbiddenException('nope'));
            await expect(
                service.getDocumentHistory(WORK_ID, doc.id, USER_ID),
            ).rejects.toBeInstanceOf(ForbiddenException);
        });

        it('clamps the limit to [1, 100] and forwards it to the mirror service', async () => {
            const doc = buildDocument();
            docRepo.findByWorkOrPath.mockResolvedValue(doc);
            const mirror = { listDocumentHistory: jest.fn().mockResolvedValue([]) };
            // Reflection-assign the mirror service onto the existing
            // singleton — the NestJS testing module doesn't provide one
            // (it's `@Optional()` in the constructor), and rebuilding a
            // full module just to inject a 1-method stub would dwarf
            // the test it's there to support.
            (service as unknown as { mirrorService: typeof mirror }).mirrorService = mirror;

            await service.getDocumentHistory(WORK_ID, doc.id, USER_ID, { limit: 999 });
            expect(mirror.listDocumentHistory).toHaveBeenCalledWith(WORK_ID, doc.id, 100);

            mirror.listDocumentHistory.mockClear();
            await service.getDocumentHistory(WORK_ID, doc.id, USER_ID, { limit: 0 });
            expect(mirror.listDocumentHistory).toHaveBeenCalledWith(WORK_ID, doc.id, 1);

            mirror.listDocumentHistory.mockClear();
            await service.getDocumentHistory(WORK_ID, doc.id, USER_ID);
            expect(mirror.listDocumentHistory).toHaveBeenCalledWith(WORK_ID, doc.id, 25);
        });

        it('copies the mirror service result into a mutable items array', async () => {
            const doc = buildDocument();
            docRepo.findByWorkOrPath.mockResolvedValue(doc);
            const commits = Object.freeze([
                {
                    sha: 'abc1234',
                    message: 'edit voice',
                    authorName: 'Ada',
                    authoredAt: '2026-05-22T00:00:00Z',
                },
            ]);
            const mirror = { listDocumentHistory: jest.fn().mockResolvedValue(commits) };
            (service as unknown as { mirrorService: typeof mirror }).mirrorService = mirror;

            const result = await service.getDocumentHistory(WORK_ID, doc.id, USER_ID);
            expect(result.items).toEqual(commits);
            // Should be a copy — pushing to it doesn't throw on a frozen source.
            expect(() => result.items.push(commits[0])).not.toThrow();
        });
    });

    describe('createDocument', () => {
        it('persists with derived slug + word/token counts', async () => {
            docRepo.pathExists.mockResolvedValue(false);
            const persisted = buildDocument({
                path: 'brand/voice.md',
                slug: 'voice',
                wordCount: 5,
                tokenCount: 5,
                metadata: { body: 'Hello world from the brand voice doc.' },
            });
            docRepo.create.mockResolvedValue(persisted);

            const result = await service.createDocument({
                workId: WORK_ID,
                userId: USER_ID,
                path: 'brand/voice.md',
                title: 'Brand voice',
                class: 'brand' as KbDocumentClass,
                body: 'Hello world from the brand voice doc.',
                tags: ['brand'],
            });

            expect(ownership.ensureCanEdit).toHaveBeenCalledWith(WORK_ID, USER_ID);
            expect(docRepo.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    workId: WORK_ID,
                    organizationId: null,
                    path: 'brand/voice.md',
                    slug: 'voice',
                    kbDocumentClass: 'brand',
                }),
            );
            expect(tagRepo.upsertBySlug).toHaveBeenCalledWith(WORK_ID, 'brand', 'brand');
            expect(result.body).toContain('Hello world');
        });

        it('suffixes the path on collision', async () => {
            docRepo.pathExists
                .mockResolvedValueOnce(true)
                .mockResolvedValueOnce(true)
                .mockResolvedValueOnce(false);
            docRepo.create.mockImplementation(async (data) => buildDocument({ ...data }));

            await service.createDocument({
                workId: WORK_ID,
                userId: USER_ID,
                path: 'brand/voice.md',
                title: 'Brand voice',
                class: 'brand' as KbDocumentClass,
                body: 'body',
            });

            const call = docRepo.create.mock.calls[0]?.[0] as { path?: string };
            expect(call.path).toBe('brand/voice-3.md');
        });

        it('enqueues the embed task with the new docId after create', async () => {
            docRepo.pathExists.mockResolvedValue(false);
            const persisted = buildDocument({ id: 'doc-99', metadata: { body: 'hi' } });
            docRepo.create.mockResolvedValue(persisted);

            await service.createDocument({
                workId: WORK_ID,
                userId: USER_ID,
                path: 'brand/v.md',
                title: 'v',
                class: 'brand' as KbDocumentClass,
                body: 'hi',
            });

            // EW-742 P3.2 T22 — payload now always includes the
            // (providerId, credentialVersion) pair. When the stamper +
            // workRepository aren't wired (this test fixture), both are
            // null and the worker falls back to the instance default
            // (byte-identical to the pre-overlay path).
            expect(embedDispatcher.dispatchKbEmbedDocument).toHaveBeenCalledWith({
                workId: WORK_ID,
                documentId: 'doc-99',
                providerId: null,
                credentialVersion: null,
            });
        });
    });

    describe('updateDocument', () => {
        it('refuses to update a fully-locked doc', async () => {
            docRepo.findById.mockResolvedValue(
                buildDocument({ locked: true, lockMode: 'full' as KbLockMode }),
            );

            await expect(
                service.updateDocument(WORK_ID, 'docid', USER_ID, { title: 'new' }),
            ).rejects.toBeInstanceOf(ForbiddenException);
        });

        it('updates word/token counts when body changes', async () => {
            const existing = buildDocument({ metadata: { body: 'old' } });
            docRepo.findById.mockResolvedValue(existing);
            docRepo.update.mockResolvedValue({
                ...existing,
                metadata: { body: 'a new body with more words' },
                wordCount: 6,
                tokenCount: 7,
            });

            const result = await service.updateDocument(WORK_ID, existing.id, USER_ID, {
                body: 'a new body with more words',
            });

            expect(docRepo.update).toHaveBeenCalled();
            expect(result.body).toBe('a new body with more words');
        });

        it('enqueues embed task when body changes', async () => {
            const existing = buildDocument({ id: 'doc-50', metadata: { body: 'old' } });
            docRepo.findById.mockResolvedValue(existing);
            docRepo.update.mockResolvedValue({
                ...existing,
                metadata: { body: 'new body' },
            });

            await service.updateDocument(WORK_ID, existing.id, USER_ID, { body: 'new body' });

            expect(embedDispatcher.dispatchKbEmbedDocument).toHaveBeenCalledWith({
                workId: WORK_ID,
                documentId: 'doc-50',
                providerId: null,
                credentialVersion: null,
            });
        });

        it('skips embed enqueue when only title/tags/etc change (body unchanged)', async () => {
            const existing = buildDocument({ id: 'doc-50', metadata: { body: 'same' } });
            docRepo.findById.mockResolvedValue(existing);
            docRepo.update.mockResolvedValue({ ...existing, title: 'New title' });

            await service.updateDocument(WORK_ID, existing.id, USER_ID, { title: 'New title' });

            expect(embedDispatcher.dispatchKbEmbedDocument).not.toHaveBeenCalled();
        });
    });

    describe('lockDocument / unlockDocument', () => {
        it('requires manager+ role', async () => {
            (ownership.ensureCanEdit as jest.Mock).mockResolvedValue({ role: 'editor' });
            docRepo.findById.mockResolvedValue(buildDocument());

            await expect(
                service.lockDocument(WORK_ID, 'docid', USER_ID, 'full' as KbLockMode),
            ).rejects.toBeInstanceOf(ForbiddenException);
        });

        it('persists lock + mode when manager', async () => {
            (ownership.ensureCanEdit as jest.Mock).mockResolvedValue({ role: 'manager' });
            const doc = buildDocument();
            docRepo.findById.mockResolvedValue(doc);
            docRepo.setLock.mockResolvedValue({
                ...doc,
                locked: true,
                lockMode: 'full' as KbLockMode,
            });

            const result = await service.lockDocument(
                WORK_ID,
                doc.id,
                USER_ID,
                'full' as KbLockMode,
            );

            expect(docRepo.setLock).toHaveBeenCalledWith(doc.id, true, 'full');
            expect(result.locked).toBe(true);
            expect(result.lockMode).toBe('full');
        });
    });

    describe('createOrgDocument', () => {
        it('rejects non-inheritable classes', async () => {
            await expect(
                service.createOrgDocument(ORG_ID, USER_ID, {
                    path: 'brand/voice.md',
                    title: 'Brand voice',
                    class: 'brand' as KbDocumentClass,
                    body: 'body',
                }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('accepts legal / style / seo', async () => {
            docRepo.create.mockImplementation(async (data) =>
                buildDocument({ ...data, workId: null, organizationId: ORG_ID }),
            );

            const result = await service.createOrgDocument(ORG_ID, USER_ID, {
                path: 'legal/privacy.md',
                title: 'Privacy policy',
                class: 'legal' as KbDocumentClass,
                body: 'verbatim privacy text',
            });

            expect(result.organizationId).toBe(ORG_ID);
            expect(result.workId).toBeNull();
            expect(result.class).toBe('legal');
        });
    });

    // EW-641 Phase 2/e row 37d — org-overlay fanout enqueue from
    // `createOrgDocument`. The base test module doesn't wire the
    // fanout dispatcher or `WorkRepository`, so these cases build a
    // fresh service with those providers and assert the row-37d
    // contract end-to-end (resolver → dispatcher).
    describe('createOrgDocument — org-overlay fanout enqueue (row 37d)', () => {
        type FanoutCall = {
            organizationId: string;
            documentId: string;
            workIds: ReadonlyArray<string>;
            operation: 'upsert' | 'delete';
            path: string;
            class: string;
        };

        async function buildWithFanout(opts: {
            workIds?: string[];
            findThrows?: boolean;
            dispatchThrows?: boolean;
        }) {
            const workIds = opts.workIds ?? ['work-a', 'work-b'];
            const workRepoMock = {
                findIdsByOrganization: opts.findThrows
                    ? jest.fn().mockRejectedValue(new Error('db boom'))
                    : jest.fn().mockResolvedValue(workIds),
            };
            const fanoutDispatcher = {
                dispatchKbOrgOverlayFanout: opts.dispatchThrows
                    ? jest.fn().mockRejectedValue(new Error('trigger boom'))
                    : jest.fn().mockResolvedValue('run-id'),
            };
            const mirrorDispatcher = {
                dispatchKbMirrorDocument: jest.fn().mockResolvedValue('mirror-run-id'),
            };

            const module: TestingModule = await Test.createTestingModule({
                providers: [
                    KnowledgeBaseService,
                    { provide: WorkKnowledgeDocumentRepository, useValue: docRepo },
                    { provide: WorkKnowledgeUploadRepository, useValue: uploadRepo },
                    { provide: WorkKnowledgeTagRepository, useValue: tagRepo },
                    {
                        provide: WorkKnowledgeCitationRepository,
                        useValue: { listForDocument: jest.fn().mockResolvedValue([]) },
                    },
                    { provide: WorkOwnershipService, useValue: ownership },
                    { provide: KB_STORAGE_PLUGIN, useValue: storage },
                    { provide: ActivityLogService, useValue: activityLog },
                    { provide: KB_EMBED_DOCUMENT_DISPATCHER, useValue: embedDispatcher },
                    { provide: KB_MIRROR_DOCUMENT_DISPATCHER, useValue: mirrorDispatcher },
                    { provide: KB_ORG_OVERLAY_FANOUT_DISPATCHER, useValue: fanoutDispatcher },
                    { provide: WorkRepository, useValue: workRepoMock },
                ],
            }).compile();

            return {
                service: module.get(KnowledgeBaseService),
                fanoutDispatcher,
                mirrorDispatcher,
                workRepoMock,
            };
        }

        it('enqueues fanout with resolved workIds for an inheritable org doc', async () => {
            const {
                service: svc,
                fanoutDispatcher,
                mirrorDispatcher,
                workRepoMock,
            } = await buildWithFanout({ workIds: ['work-a', 'work-b'] });
            docRepo.create.mockImplementation(async (data) =>
                buildDocument({
                    ...data,
                    id: 'org-doc-1',
                    workId: null,
                    organizationId: ORG_ID,
                }),
            );

            await svc.createOrgDocument(ORG_ID, USER_ID, {
                path: 'legal/privacy.md',
                title: 'Privacy policy',
                class: 'legal' as KbDocumentClass,
                body: 'verbatim',
            });

            expect(workRepoMock.findIdsByOrganization).toHaveBeenCalledWith(ORG_ID);
            expect(fanoutDispatcher.dispatchKbOrgOverlayFanout).toHaveBeenCalledTimes(1);
            const call = fanoutDispatcher.dispatchKbOrgOverlayFanout.mock.calls[0][0] as FanoutCall;
            expect(call.organizationId).toBe(ORG_ID);
            expect(call.documentId).toBe('org-doc-1');
            expect(call.workIds).toEqual(['work-a', 'work-b']);
            expect(call.operation).toBe('upsert');
            expect(call.path).toBe('legal/privacy.md');
            expect(call.class).toBe('legal');
            // Per-Work `kb-mirror-document` MUST NOT fire for an org-scope
            // row — that path writes to `.content/kb/<path>` (work-owned)
            // and would collide with overlay precedence semantics.
            expect(mirrorDispatcher.dispatchKbMirrorDocument).not.toHaveBeenCalled();
        });

        it('skips fanout dispatch when the org has zero Works', async () => {
            const {
                service: svc,
                fanoutDispatcher,
                workRepoMock,
            } = await buildWithFanout({ workIds: [] });
            docRepo.create.mockImplementation(async (data) =>
                buildDocument({ ...data, workId: null, organizationId: ORG_ID }),
            );

            await svc.createOrgDocument(ORG_ID, USER_ID, {
                path: 'legal/privacy.md',
                title: 'Privacy policy',
                class: 'legal' as KbDocumentClass,
                body: 'body',
            });

            expect(workRepoMock.findIdsByOrganization).toHaveBeenCalledWith(ORG_ID);
            expect(fanoutDispatcher.dispatchKbOrgOverlayFanout).not.toHaveBeenCalled();
        });

        it('swallows WorkRepository errors so the API write still succeeds', async () => {
            const { service: svc, fanoutDispatcher } = await buildWithFanout({
                findThrows: true,
            });
            docRepo.create.mockImplementation(async (data) =>
                buildDocument({ ...data, workId: null, organizationId: ORG_ID }),
            );

            // Should not throw — `enqueueOrgOverlayFanout` is fire-and-forget.
            await expect(
                svc.createOrgDocument(ORG_ID, USER_ID, {
                    path: 'legal/privacy.md',
                    title: 'Privacy policy',
                    class: 'legal' as KbDocumentClass,
                    body: 'body',
                }),
            ).resolves.toBeDefined();

            expect(fanoutDispatcher.dispatchKbOrgOverlayFanout).not.toHaveBeenCalled();
        });

        it('swallows dispatcher errors so the API write still succeeds', async () => {
            const { service: svc, fanoutDispatcher } = await buildWithFanout({
                workIds: ['work-a'],
                dispatchThrows: true,
            });
            docRepo.create.mockImplementation(async (data) =>
                buildDocument({ ...data, workId: null, organizationId: ORG_ID }),
            );

            await expect(
                svc.createOrgDocument(ORG_ID, USER_ID, {
                    path: 'legal/privacy.md',
                    title: 'Privacy policy',
                    class: 'legal' as KbDocumentClass,
                    body: 'body',
                }),
            ).resolves.toBeDefined();

            expect(fanoutDispatcher.dispatchKbOrgOverlayFanout).toHaveBeenCalledTimes(1);
        });

        it('still creates the doc when neither dispatcher nor repo are wired (degraded)', async () => {
            // Uses the base `service` from the outer beforeEach — it has
            // neither KB_ORG_OVERLAY_FANOUT_DISPATCHER nor WorkRepository
            // wired. The mutation must still succeed (Phase 3 reconciliation
            // catches drift).
            docRepo.create.mockImplementation(async (data) =>
                buildDocument({ ...data, workId: null, organizationId: ORG_ID }),
            );

            const result = await service.createOrgDocument(ORG_ID, USER_ID, {
                path: 'legal/privacy.md',
                title: 'Privacy policy',
                class: 'legal' as KbDocumentClass,
                body: 'body',
            });

            expect(result.organizationId).toBe(ORG_ID);
        });

        it('does NOT enqueue fanout from createDocument (Work-scope path)', async () => {
            const {
                service: svc,
                fanoutDispatcher,
                mirrorDispatcher,
            } = await buildWithFanout({ workIds: ['work-a', 'work-b'] });
            docRepo.create.mockImplementation(async (data) =>
                buildDocument({ ...data, id: 'work-doc-1' }),
            );

            await svc.createDocument({
                workId: WORK_ID,
                userId: USER_ID,
                path: 'brand/voice.md',
                title: 'Brand voice',
                class: 'brand' as KbDocumentClass,
                body: 'work-scoped body',
            });

            // Work-scope rows use the per-Work mirror path only — never
            // the org-overlay fanout (verifies the call-site is org-only).
            expect(fanoutDispatcher.dispatchKbOrgOverlayFanout).not.toHaveBeenCalled();
            expect(mirrorDispatcher.dispatchKbMirrorDocument).toHaveBeenCalledTimes(1);
        });
    });

    describe('resolveInheritableDocuments', () => {
        it('merges org docs with Work overrides by path', async () => {
            const orgPrivacy = buildDocument({
                id: 'org-privacy',
                workId: null,
                organizationId: ORG_ID,
                path: 'legal/privacy.md',
                title: 'Org privacy',
                kbDocumentClass: 'legal' as KbDocumentClass,
            });
            const orgTerms = buildDocument({
                id: 'org-terms',
                workId: null,
                organizationId: ORG_ID,
                path: 'legal/terms.md',
                title: 'Org terms',
                kbDocumentClass: 'legal' as KbDocumentClass,
            });
            const workPrivacy = buildDocument({
                id: 'work-privacy',
                workId: WORK_ID,
                organizationId: null,
                path: 'legal/privacy.md',
                title: 'Work privacy override',
                kbDocumentClass: 'legal' as KbDocumentClass,
            });

            docRepo.listInheritableForOrg.mockResolvedValue([orgPrivacy, orgTerms]);
            docRepo.listWorkOverridesForClasses.mockResolvedValue([workPrivacy]);

            const result = await service.resolveInheritableDocuments(WORK_ID, ORG_ID, [
                'legal' as KbDocumentClass,
            ]);

            const byPath = new Map(result.map((d) => [d.path, d]));
            expect(byPath.get('legal/privacy.md')?.title).toBe('Work privacy override');
            expect(byPath.get('legal/terms.md')?.title).toBe('Org terms');
            expect(result).toHaveLength(2);
        });

        it('returns empty when no inheritable classes match', async () => {
            const result = await service.resolveInheritableDocuments(WORK_ID, ORG_ID, [
                'brand' as KbDocumentClass,
            ]);
            expect(result).toEqual([]);
        });
    });

    describe('createUpload', () => {
        function buildUploadInput(
            overrides: Partial<{ buffer: Buffer; mimeType: string; originalFilename: string }> = {},
        ) {
            return {
                workId: WORK_ID,
                userId: USER_ID,
                file: {
                    buffer: Buffer.from('# brand voice\n\nbody'),
                    originalFilename: 'voice.md',
                    mimeType: 'text/markdown',
                    size: 18,
                    ...overrides,
                },
                targetClass: 'brand' as KbDocumentClass,
                tags: ['brand'],
            };
        }

        function buildUpload(overrides: Partial<WorkKnowledgeUpload> = {}): WorkKnowledgeUpload {
            return {
                id: '00000000-0000-0000-0000-000000000020',
                workId: WORK_ID,
                storageProvider: 'local-fs',
                storagePath: 'kb-originals/brand/abc.md',
                originalFilename: 'voice.md',
                mimeType: 'text/markdown',
                fileSize: 18,
                sha256: 'abc',
                extractionStatus: 'pending' as KbUploadExtractionStatus,
                extractionStartedAt: null,
                extractionFinishedAt: null,
                extractionError: null,
                extractedDocumentId: null,
                normalizedFormat: null,
                extractionPluginId: null,
                uploadedById: USER_ID,
                tags: ['brand'],
                categories: null,
                metadata: null,
                createdAt: new Date(),
                updatedAt: new Date(),
            } as WorkKnowledgeUpload;
        }

        it('text-passthrough: persists bytes, creates upload + doc, emits activity log events', async () => {
            storage.putObject.mockResolvedValue({ key: 'kb-originals/brand/abc.md', url: '' });
            const uploadRow = buildUpload();
            uploadRepo.create.mockResolvedValue(uploadRow);
            uploadRepo.update.mockResolvedValue({
                ...uploadRow,
                extractionStatus: 'succeeded' as KbUploadExtractionStatus,
            });
            const docRow = buildDocument({
                id: '00000000-0000-0000-0000-000000000030',
                path: 'brand/voice.md',
            });
            docRepo.create.mockResolvedValue(docRow);
            docRepo.findById.mockResolvedValue(docRow);

            const result = await service.createUpload(buildUploadInput());

            expect(storage.putObject).toHaveBeenCalledWith(
                expect.objectContaining({
                    filename: expect.stringContaining('kb-originals/brand/'),
                    mimeType: 'text/markdown',
                }),
            );
            expect(uploadRepo.create).toHaveBeenCalled();
            expect(docRepo.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    path: 'brand/voice.md',
                    kbDocumentClass: 'brand',
                    source: 'imported',
                    sourceUploadId: uploadRow.id,
                }),
            );
            expect(result.document?.id).toBe(docRow.id);

            const kinds = activityLog.log.mock.calls.map(
                (c) => (c[0] as { actionType: string }).actionType,
            );
            expect(kinds).toEqual(
                expect.arrayContaining([
                    ActivityActionType.KB_UPLOAD_CREATED,
                    ActivityActionType.KB_UPLOAD_EXTRACTED,
                    ActivityActionType.KB_DOCUMENT_CREATED,
                ]),
            );
        });

        it('dedup: returns existing row + emits kb_upload_deduped, no storage write', async () => {
            const existing = buildUpload({ sha256: 'reuse-sha' });
            uploadRepo.findBySha256.mockResolvedValueOnce(existing);

            const result = await service.createUpload(buildUploadInput());

            expect(storage.putObject).not.toHaveBeenCalled();
            expect(uploadRepo.create).not.toHaveBeenCalled();
            expect(docRepo.create).not.toHaveBeenCalled();
            expect(result.upload).toBe(existing);
            expect(result.document).toBeNull();
            expect(activityLog.log).toHaveBeenCalledWith(
                expect.objectContaining({ actionType: ActivityActionType.KB_UPLOAD_DEDUPED }),
            );
        });

        it('HTML upload: routes through KnowledgeBaseBufferExtractorService and creates a doc', async () => {
            // Build a fresh service WITH the buffer extractor wired so
            // we exercise the new Phase 1B/c routing branch.
            const module2: TestingModule = await Test.createTestingModule({
                providers: [
                    KnowledgeBaseService,
                    { provide: WorkKnowledgeDocumentRepository, useValue: docRepo },
                    { provide: WorkKnowledgeUploadRepository, useValue: uploadRepo },
                    { provide: WorkKnowledgeTagRepository, useValue: tagRepo },
                    {
                        provide: WorkKnowledgeCitationRepository,
                        useValue: { listForDocument: jest.fn().mockResolvedValue([]) },
                    },
                    { provide: WorkOwnershipService, useValue: ownership },
                    { provide: KB_STORAGE_PLUGIN, useValue: storage },
                    { provide: ActivityLogService, useValue: activityLog },
                    KnowledgeBaseBufferExtractorService,
                ],
            }).compile();
            const wired = module2.get(KnowledgeBaseService);

            storage.putObject.mockResolvedValue({ key: 'kb-originals/research/abc.html', url: '' });
            const uploadRow = buildUpload({
                mimeType: 'text/html',
                originalFilename: 'briefing.html',
            });
            uploadRepo.create.mockResolvedValue(uploadRow);
            uploadRepo.update.mockResolvedValue({
                ...uploadRow,
                extractionStatus: 'succeeded' as KbUploadExtractionStatus,
            });
            const docRow = buildDocument({
                id: '00000000-0000-0000-0000-000000000040',
                path: 'research/briefing.md',
                kbDocumentClass: 'research' as KbDocumentClass,
            });
            docRepo.create.mockResolvedValue(docRow);
            docRepo.findById.mockResolvedValue(docRow);

            const result = await wired.createUpload({
                workId: WORK_ID,
                userId: USER_ID,
                file: {
                    buffer: Buffer.from('<h1>Briefing</h1><p>Quarterly review notes.</p>', 'utf-8'),
                    originalFilename: 'briefing.html',
                    mimeType: 'text/html',
                    size: 46,
                },
                targetClass: 'research' as KbDocumentClass,
                tags: ['briefing'],
            });

            expect(result.document?.id).toBe(docRow.id);
            expect(docRepo.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    path: 'research/briefing.md',
                    kbDocumentClass: 'research',
                    source: 'imported',
                }),
            );
            const extractedCall = activityLog.log.mock.calls.find(
                (c) =>
                    (c[0] as { actionType: string }).actionType ===
                    ActivityActionType.KB_UPLOAD_EXTRACTED,
            );
            expect(extractedCall?.[0].details?.extractedVia).toBe('html-turndown');
        });

        it('non-viewable MIME (octet-stream): marks upload skipped, no stub doc', async () => {
            storage.putObject.mockResolvedValue({ key: 'kb-originals/freeform/abc.bin', url: '' });
            const uploadRow = buildUpload({
                mimeType: 'application/octet-stream',
                originalFilename: 'spec.bin',
            });
            uploadRepo.create.mockResolvedValue(uploadRow);
            const skippedRow = {
                ...uploadRow,
                extractionStatus: 'skipped' as KbUploadExtractionStatus,
            };
            uploadRepo.update.mockResolvedValue(skippedRow);
            // The terminal-state re-read at the bottom of createUpload —
            // ensures `result.upload` reflects the post-extract status
            // ('skipped'), not the create-time status ('running').
            uploadRepo.findById.mockResolvedValueOnce(skippedRow);

            const result = await service.createUpload({
                ...buildUploadInput({
                    mimeType: 'application/octet-stream',
                    originalFilename: 'spec.bin',
                }),
                targetClass: undefined,
            });

            expect(result.document).toBeNull();
            // Without the terminal re-read the response would carry the
            // 'running' row from uploadRepo.create — the e2e A16 suite
            // (kb-extraction-retry.spec.ts:81) asserts on this field
            // directly, no settle-poll.
            expect(result.upload.extractionStatus).toBe('skipped');
            expect(uploadRepo.update).toHaveBeenCalledWith(
                uploadRow.id,
                expect.objectContaining({ extractionStatus: 'skipped' }),
            );
            expect(uploadRepo.findById).toHaveBeenCalledWith(WORK_ID, uploadRow.id);
            // octet-stream has no row-21b viewer → no stub document created.
            expect(docRepo.create).not.toHaveBeenCalled();
            const kinds = activityLog.log.mock.calls.map(
                (c) => (c[0] as { actionType: string }).actionType,
            );
            expect(kinds).toContain(ActivityActionType.KB_UPLOAD_EXTRACTION_SKIPPED);
            expect(kinds).not.toContain(ActivityActionType.KB_DOCUMENT_CREATED);
        });

        it('viewable binary with no extractor route (image): SKIPPED branch creates a viewable stub doc', async () => {
            storage.putObject.mockResolvedValue({ key: 'kb-originals/freeform/abc.png', url: '' });
            const uploadRow = buildUpload({
                mimeType: 'image/png',
                originalFilename: 'diagram.png',
                storagePath: 'kb-originals/freeform/abc.png',
            });
            uploadRepo.create.mockResolvedValue(uploadRow);
            const skippedRow = {
                ...uploadRow,
                extractionStatus: 'skipped' as KbUploadExtractionStatus,
                extractedDocumentId: '00000000-0000-0000-0000-000000000050',
            };
            uploadRepo.update.mockResolvedValue(skippedRow);
            uploadRepo.findById.mockResolvedValue(skippedRow);
            const stubDoc = buildDocument({
                id: '00000000-0000-0000-0000-000000000050',
                path: 'freeform/diagram.md',
                kbDocumentClass: 'freeform' as KbDocumentClass,
                source: 'imported' as KbDocumentSource,
                sourceUploadId: uploadRow.id,
            });
            docRepo.create.mockResolvedValue(stubDoc);
            docRepo.findById.mockResolvedValue(stubDoc);

            const result = await service.createUpload({
                ...buildUploadInput({ mimeType: 'image/png', originalFilename: 'diagram.png' }),
                targetClass: undefined,
            });

            // The image MIME has no text extractor → upload stays skipped,
            // but the row-21b viewer can render it, so a body-less stub doc
            // is created + linked so the viewer surfaces in the tree.
            expect(result.upload.extractionStatus).toBe('skipped');
            expect(result.document?.id).toBe(stubDoc.id);
            expect(docRepo.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    path: 'freeform/diagram.md',
                    source: 'imported',
                    sourceUploadId: uploadRow.id,
                    // createDocument nests the body under `metadata.body`,
                    // not a top-level field.
                    metadata: expect.objectContaining({ body: '' }),
                }),
            );
            expect(uploadRepo.update).toHaveBeenCalledWith(
                uploadRow.id,
                expect.objectContaining({ extractedDocumentId: stubDoc.id }),
            );
            const kinds = activityLog.log.mock.calls.map(
                (c) => (c[0] as { actionType: string }).actionType,
            );
            expect(kinds).toContain(ActivityActionType.KB_UPLOAD_EXTRACTION_SKIPPED);
            expect(kinds).toContain(ActivityActionType.KB_DOCUMENT_CREATED);
        });

        it('viewable binary whose extraction FAILS (pdf): FAILED branch creates a viewable stub doc', async () => {
            const throwingExtractor = {
                extract: jest
                    .fn()
                    .mockRejectedValue(
                        new Error('KB PDF extraction failed: Invalid PDF structure'),
                    ),
                supports: jest.fn().mockReturnValue(true),
            };
            const module3: TestingModule = await Test.createTestingModule({
                providers: [
                    KnowledgeBaseService,
                    { provide: WorkKnowledgeDocumentRepository, useValue: docRepo },
                    { provide: WorkKnowledgeUploadRepository, useValue: uploadRepo },
                    { provide: WorkKnowledgeTagRepository, useValue: tagRepo },
                    {
                        provide: WorkKnowledgeCitationRepository,
                        useValue: { listForDocument: jest.fn().mockResolvedValue([]) },
                    },
                    { provide: WorkOwnershipService, useValue: ownership },
                    { provide: KB_STORAGE_PLUGIN, useValue: storage },
                    { provide: ActivityLogService, useValue: activityLog },
                    { provide: KnowledgeBaseBufferExtractorService, useValue: throwingExtractor },
                ],
            }).compile();
            const wired = module3.get(KnowledgeBaseService);

            storage.putObject.mockResolvedValue({ key: 'kb-originals/freeform/abc.pdf', url: '' });
            const uploadRow = buildUpload({
                mimeType: 'application/pdf',
                originalFilename: 'broken.pdf',
            });
            uploadRepo.create.mockResolvedValue(uploadRow);
            const failedRow = {
                ...uploadRow,
                extractionStatus: 'failed' as KbUploadExtractionStatus,
                extractedDocumentId: '00000000-0000-0000-0000-000000000060',
            };
            uploadRepo.update.mockResolvedValue(failedRow);
            uploadRepo.findById.mockResolvedValue(failedRow);
            const stubDoc = buildDocument({
                id: '00000000-0000-0000-0000-000000000060',
                path: 'freeform/broken.md',
                kbDocumentClass: 'freeform' as KbDocumentClass,
                source: 'imported' as KbDocumentSource,
                sourceUploadId: uploadRow.id,
            });
            docRepo.create.mockResolvedValue(stubDoc);
            docRepo.findById.mockResolvedValue(stubDoc);

            const result = await wired.createUpload({
                workId: WORK_ID,
                userId: USER_ID,
                file: {
                    buffer: Buffer.from('%PDF-broken', 'utf-8'),
                    originalFilename: 'broken.pdf',
                    mimeType: 'application/pdf',
                    size: 11,
                },
                targetClass: undefined,
            });

            // Extraction threw → upload marked FAILED, but the PDF viewer
            // can still render the bytes, so a stub doc is created + linked.
            expect(result.upload.extractionStatus).toBe('failed');
            expect(result.document?.id).toBe(stubDoc.id);
            expect(docRepo.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    source: 'imported',
                    sourceUploadId: uploadRow.id,
                    metadata: expect.objectContaining({ body: '' }),
                }),
            );
            const kinds = activityLog.log.mock.calls.map(
                (c) => (c[0] as { actionType: string }).actionType,
            );
            expect(kinds).toContain(ActivityActionType.KB_UPLOAD_EXTRACTION_FAILED);
            expect(kinds).toContain(ActivityActionType.KB_DOCUMENT_CREATED);
        });

        // Security (info-leak): extractionError is a client-visible KbUploadDto
        // field. Raw extractor errors carry multi-line stack traces and internal
        // paths — the service must persist a sanitized single-line, length-capped
        // reason instead of the verbatim message.
        it('sanitizes multi-line extractor errors before persisting extractionError', async () => {
            const stackTraceError = new Error(
                'KB PDF extraction failed: Invalid PDF structure\n' +
                    '    at PdfParser.parse (/app/node_modules/internal/pdf.js:42:13)\n' +
                    `    at ${'x'.repeat(600)}`,
            );
            const throwingExtractor = {
                extract: jest.fn().mockRejectedValue(stackTraceError),
                supports: jest.fn().mockReturnValue(true),
            };
            const module4: TestingModule = await Test.createTestingModule({
                providers: [
                    KnowledgeBaseService,
                    { provide: WorkKnowledgeDocumentRepository, useValue: docRepo },
                    { provide: WorkKnowledgeUploadRepository, useValue: uploadRepo },
                    { provide: WorkKnowledgeTagRepository, useValue: tagRepo },
                    {
                        provide: WorkKnowledgeCitationRepository,
                        useValue: { listForDocument: jest.fn().mockResolvedValue([]) },
                    },
                    { provide: WorkOwnershipService, useValue: ownership },
                    { provide: KB_STORAGE_PLUGIN, useValue: storage },
                    { provide: ActivityLogService, useValue: activityLog },
                    { provide: KnowledgeBaseBufferExtractorService, useValue: throwingExtractor },
                ],
            }).compile();
            const wired = module4.get(KnowledgeBaseService);

            storage.putObject.mockResolvedValue({ key: 'kb-originals/freeform/abc.pdf', url: '' });
            const uploadRow = buildUpload({
                mimeType: 'application/pdf',
                originalFilename: 'broken.pdf',
            });
            uploadRepo.create.mockResolvedValue(uploadRow);
            const failedRow = {
                ...uploadRow,
                extractionStatus: 'failed' as KbUploadExtractionStatus,
            };
            uploadRepo.update.mockResolvedValue(failedRow);
            uploadRepo.findById.mockResolvedValue(failedRow);
            const stubDoc = buildDocument({
                id: '00000000-0000-0000-0000-000000000061',
                path: 'freeform/broken.md',
                kbDocumentClass: 'freeform' as KbDocumentClass,
                source: 'imported' as KbDocumentSource,
                sourceUploadId: uploadRow.id,
            });
            docRepo.create.mockResolvedValue(stubDoc);
            docRepo.findById.mockResolvedValue(stubDoc);

            await wired.createUpload({
                workId: WORK_ID,
                userId: USER_ID,
                file: {
                    buffer: Buffer.from('%PDF-broken', 'utf-8'),
                    originalFilename: 'broken.pdf',
                    mimeType: 'application/pdf',
                    size: 11,
                },
                targetClass: undefined,
            });

            const failedUpdate = uploadRepo.update.mock.calls.find(
                (c) => (c[1] as Partial<WorkKnowledgeUpload>).extractionStatus === 'failed',
            );
            expect(failedUpdate).toBeDefined();
            const persistedReason = (failedUpdate?.[1] as { extractionError: string })
                .extractionError;
            // Newlines collapsed to single spaces, length capped at 500.
            expect(persistedReason).not.toContain('\n');
            expect(persistedReason.length).toBeLessThanOrEqual(500);
            expect(persistedReason).toContain('KB PDF extraction failed: Invalid PDF structure');
        });

        it('viewable binary on retry: reuses the existing stub instead of duplicating', async () => {
            // `extractAndMaterialize` is also the retry-extraction workhorse.
            // When the upload already links a stub (extractedDocumentId set),
            // a second pass must reuse it — never create a duplicate doc.
            const existingStub = buildDocument({
                id: '00000000-0000-0000-0000-000000000070',
                path: 'freeform/diagram.md',
                source: 'imported' as KbDocumentSource,
            });
            docRepo.findById.mockResolvedValue(existingStub);
            const upload = {
                ...buildUpload(),
                mimeType: 'image/png',
                originalFilename: 'diagram.png',
                extractionStatus: 'skipped' as KbUploadExtractionStatus,
                extractedDocumentId: existingStub.id,
            } as WorkKnowledgeUpload;

            const result = await (
                service as unknown as {
                    extractAndMaterialize: (
                        u: WorkKnowledgeUpload,
                        input: {
                            workId: string;
                            userId: string;
                            file: { buffer: Buffer; mimeType: string; originalFilename: string };
                        },
                    ) => Promise<WorkKnowledgeDocument | null>;
                }
            ).extractAndMaterialize(upload, {
                workId: WORK_ID,
                userId: USER_ID,
                file: {
                    buffer: Buffer.from('PNGDATA', 'utf-8'),
                    mimeType: 'image/png',
                    originalFilename: 'diagram.png',
                },
            });

            expect(result).toBe(existingStub);
            expect(docRepo.create).not.toHaveBeenCalled();
            expect(docRepo.findById).toHaveBeenCalledWith(WORK_ID, existingStub.id);
        });

        it('rejects when storage plugin is not configured', async () => {
            // Re-build the service without the storage provider.
            const module: TestingModule = await Test.createTestingModule({
                providers: [
                    KnowledgeBaseService,
                    { provide: WorkKnowledgeDocumentRepository, useValue: docRepo },
                    { provide: WorkKnowledgeUploadRepository, useValue: uploadRepo },
                    { provide: WorkKnowledgeTagRepository, useValue: tagRepo },
                    {
                        provide: WorkKnowledgeCitationRepository,
                        useValue: { listForDocument: jest.fn().mockResolvedValue([]) },
                    },
                    { provide: WorkOwnershipService, useValue: ownership },
                    // No KB_STORAGE_PLUGIN provided.
                ],
            }).compile();
            const bare = module.get(KnowledgeBaseService);
            await expect(bare.createUpload(buildUploadInput())).rejects.toBeInstanceOf(
                ServiceUnavailableException,
            );
        });
    });

    describe('getUploadBytes', () => {
        function buildUpload(overrides: Partial<WorkKnowledgeUpload> = {}): WorkKnowledgeUpload {
            return {
                id: '00000000-0000-0000-0000-000000000020',
                workId: WORK_ID,
                storageProvider: 'local-fs',
                storagePath: 'kb-originals/brand/abc.pdf',
                originalFilename: 'voice.pdf',
                mimeType: 'application/pdf',
                fileSize: 4096,
                sha256: 'abc',
                extractionStatus: 'skipped' as KbUploadExtractionStatus,
                extractionStartedAt: null,
                extractionFinishedAt: null,
                extractionError: null,
                extractedDocumentId: null,
                normalizedFormat: null,
                extractionPluginId: null,
                uploadedById: USER_ID,
                tags: null,
                categories: null,
                metadata: null,
                createdAt: new Date(),
                updatedAt: new Date(),
                ...overrides,
            } as WorkKnowledgeUpload;
        }

        it('streams stored bytes for the caller with the recovered MIME type', async () => {
            const upload = buildUpload();
            uploadRepo.findById.mockResolvedValueOnce(upload);
            const buffer = Buffer.from('%PDF-1.4 fake bytes');
            storage.getObject.mockResolvedValueOnce({
                buffer,
                mimeType: 'application/pdf',
            });

            const result = await service.getUploadBytes(WORK_ID, upload.id, USER_ID);

            expect(ownership.ensureCanView).toHaveBeenCalledWith(WORK_ID, USER_ID);
            expect(storage.getObject).toHaveBeenCalledWith(upload.storagePath);
            expect(result.buffer).toBe(buffer);
            expect(result.mimeType).toBe('application/pdf');
            expect(result.filename).toBe(upload.originalFilename);
            expect(result.sizeBytes).toBe(upload.fileSize);
        });

        it('falls back to the upload row mime when storage does not surface one', async () => {
            const upload = buildUpload({
                mimeType: 'image/png',
                storagePath: 'kb-originals/img.png',
            });
            uploadRepo.findById.mockResolvedValueOnce(upload);
            storage.getObject.mockResolvedValueOnce({
                buffer: Buffer.from(''),
                mimeType: undefined as unknown as string,
            });

            const result = await service.getUploadBytes(WORK_ID, upload.id, USER_ID);
            expect(result.mimeType).toBe('image/png');
        });

        it('throws NotFoundException when the upload row is missing', async () => {
            uploadRepo.findById.mockResolvedValueOnce(null);
            await expect(
                service.getUploadBytes(WORK_ID, 'missing-id', USER_ID),
            ).rejects.toBeInstanceOf(NotFoundException);
            expect(storage.getObject).not.toHaveBeenCalled();
        });

        it('throws ServiceUnavailableException when no storage plugin is wired', async () => {
            // Re-instantiate without KB_STORAGE_PLUGIN — mirrors createUpload's bare-module test.
            const module: TestingModule = await Test.createTestingModule({
                providers: [
                    KnowledgeBaseService,
                    {
                        provide: WorkKnowledgeDocumentRepository,
                        useValue: { findById: jest.fn() },
                    },
                    {
                        provide: WorkKnowledgeUploadRepository,
                        useValue: { findById: jest.fn().mockResolvedValue(buildUpload()) },
                    },
                    { provide: WorkKnowledgeTagRepository, useValue: { list: jest.fn() } },
                    {
                        provide: WorkKnowledgeCitationRepository,
                        useValue: { listForDocument: jest.fn() },
                    },
                    {
                        provide: WorkOwnershipService,
                        useValue: {
                            ensureCanView: jest.fn().mockResolvedValue({ role: 'editor' } as any),
                            ensureCanEdit: jest.fn(),
                        },
                    },
                    { provide: ActivityLogService, useValue: { log: jest.fn() } },
                ],
            }).compile();
            const bare = module.get(KnowledgeBaseService);
            await expect(bare.getUploadBytes(WORK_ID, 'any-id', USER_ID)).rejects.toBeInstanceOf(
                ServiceUnavailableException,
            );
        });

        it('enforces ensureCanView before touching storage', async () => {
            ownership.ensureCanView.mockRejectedValueOnce(new ForbiddenException('nope'));
            await expect(service.getUploadBytes(WORK_ID, 'any-id', USER_ID)).rejects.toBeInstanceOf(
                ForbiddenException,
            );
            expect(uploadRepo.findById).not.toHaveBeenCalled();
            expect(storage.getObject).not.toHaveBeenCalled();
        });
    });

    describe('restoreDocumentFromHistory', () => {
        it('rejects editor-role callers (manager+ required)', async () => {
            // Default ownership mock returns 'editor' — restore needs
            // owner/manager per spec §20.
            await expect(
                service.restoreDocumentFromHistory(WORK_ID, 'docId', USER_ID, 'abc1234'),
            ).rejects.toBeInstanceOf(ForbiddenException);
        });

        it('returns 503 when the KB Git mirror service is not wired', async () => {
            // Default test module bootstraps without
            // `KnowledgeBaseGitMirrorService`. A missing server-side
            // dependency is a server problem, not a client error, so
            // the call should surface as ServiceUnavailableException
            // (503) — clients can retry-on-503 rather than treating a
            // valid request as malformed.
            ownership.ensureCanEdit.mockResolvedValueOnce({ role: 'owner' } as any);
            await expect(
                service.restoreDocumentFromHistory(WORK_ID, 'docId', USER_ID, 'abc1234'),
            ).rejects.toBeInstanceOf(ServiceUnavailableException);
        });
    });

    // EW-742 P3.2 T22 — KB-embed is the proof-of-concept dispatcher
    // for enqueue-site tenant-runtime binding capture. These tests
    // build a fresh service with WorkRepository + RuntimeBindingStamperService
    // wired and assert that the (providerId, credentialVersion) pair
    // gets threaded onto the dispatch payload.
    describe('enqueueEmbed — T22 tenant runtime binding capture (KB-embed PoC)', () => {
        async function buildWithStamper(opts: {
            stamperResult?: { providerId: string | null; credentialVersion: number | null };
            stamperThrows?: boolean;
            workTenantId?: string | null;
            workFindThrows?: boolean;
        }) {
            const embedDispatcherMock = {
                dispatchKbEmbedDocument: jest.fn().mockResolvedValue('run-id'),
            };
            const mirrorDispatcherMock = {
                dispatchKbMirrorDocument: jest.fn().mockResolvedValue('mirror-run-id'),
            };
            const workRepoMock = {
                findById: opts.workFindThrows
                    ? jest.fn().mockRejectedValue(new Error('db boom'))
                    : jest
                          .fn()
                          .mockResolvedValue(
                              opts.workTenantId === undefined
                                  ? null
                                  : ({ id: WORK_ID, tenantId: opts.workTenantId } as any),
                          ),
            };
            const stamperMock = {
                stamp: opts.stamperThrows
                    ? jest.fn().mockRejectedValue(new Error('stamper boom'))
                    : jest.fn().mockResolvedValue(
                          opts.stamperResult ?? {
                              providerId: null,
                              credentialVersion: null,
                          },
                      ),
            };

            const module: TestingModule = await Test.createTestingModule({
                providers: [
                    KnowledgeBaseService,
                    { provide: WorkKnowledgeDocumentRepository, useValue: docRepo },
                    { provide: WorkKnowledgeUploadRepository, useValue: uploadRepo },
                    { provide: WorkKnowledgeTagRepository, useValue: tagRepo },
                    {
                        provide: WorkKnowledgeCitationRepository,
                        useValue: { listForDocument: jest.fn().mockResolvedValue([]) },
                    },
                    { provide: WorkOwnershipService, useValue: ownership },
                    { provide: KB_STORAGE_PLUGIN, useValue: storage },
                    { provide: ActivityLogService, useValue: activityLog },
                    { provide: KB_EMBED_DOCUMENT_DISPATCHER, useValue: embedDispatcherMock },
                    { provide: KB_MIRROR_DOCUMENT_DISPATCHER, useValue: mirrorDispatcherMock },
                    { provide: WorkRepository, useValue: workRepoMock },
                    { provide: RuntimeBindingStamperService, useValue: stamperMock },
                ],
            }).compile();

            return {
                service: module.get(KnowledgeBaseService),
                embedDispatcherMock,
                workRepoMock,
                stamperMock,
            };
        }

        it('stamps payload with stamper result when overlay is active', async () => {
            const {
                service: svc,
                embedDispatcherMock,
                workRepoMock,
                stamperMock,
            } = await buildWithStamper({
                workTenantId: '00000000-0000-0000-0000-00000000aaaa',
                stamperResult: { providerId: 'trigger', credentialVersion: 7 },
            });
            docRepo.create.mockImplementation(async (data) =>
                buildDocument({ ...data, id: 'doc-t22-a' }),
            );

            await svc.createDocument({
                workId: WORK_ID,
                userId: USER_ID,
                path: 'brand/v.md',
                title: 'v',
                class: 'brand' as KbDocumentClass,
                body: 'hi',
            });

            expect(workRepoMock.findById).toHaveBeenCalledWith(WORK_ID);
            expect(stamperMock.stamp).toHaveBeenCalledWith('00000000-0000-0000-0000-00000000aaaa');
            expect(embedDispatcherMock.dispatchKbEmbedDocument).toHaveBeenCalledWith({
                workId: WORK_ID,
                documentId: 'doc-t22-a',
                providerId: 'trigger',
                credentialVersion: 7,
            });
        });

        it('passes null/null when work has no tenantId (pre-EW-655 row)', async () => {
            const {
                service: svc,
                embedDispatcherMock,
                stamperMock,
            } = await buildWithStamper({
                workTenantId: null,
                stamperResult: { providerId: null, credentialVersion: null },
            });
            docRepo.create.mockImplementation(async (data) =>
                buildDocument({ ...data, id: 'doc-t22-b' }),
            );

            await svc.createDocument({
                workId: WORK_ID,
                userId: USER_ID,
                path: 'brand/v.md',
                title: 'v',
                class: 'brand' as KbDocumentClass,
                body: 'hi',
            });

            // Stamper still called (it's the contract entry point) but
            // with `null` tenantId so it short-circuits to null/null.
            expect(stamperMock.stamp).toHaveBeenCalledWith(null);
            expect(embedDispatcherMock.dispatchKbEmbedDocument).toHaveBeenCalledWith({
                workId: WORK_ID,
                documentId: 'doc-t22-b',
                providerId: null,
                credentialVersion: null,
            });
        });

        it('fails open on stamper throw — payload ships with null/null, embed still enqueues', async () => {
            const { service: svc, embedDispatcherMock } = await buildWithStamper({
                workTenantId: '00000000-0000-0000-0000-00000000aaaa',
                stamperThrows: true,
            });
            docRepo.create.mockImplementation(async (data) =>
                buildDocument({ ...data, id: 'doc-t22-c' }),
            );

            await svc.createDocument({
                workId: WORK_ID,
                userId: USER_ID,
                path: 'brand/v.md',
                title: 'v',
                class: 'brand' as KbDocumentClass,
                body: 'hi',
            });

            // FR-5 fail-open: stamper failure MUST NOT block the
            // enqueue — payload ships with null/null so the worker host
            // falls back to the instance default.
            expect(embedDispatcherMock.dispatchKbEmbedDocument).toHaveBeenCalledWith({
                workId: WORK_ID,
                documentId: 'doc-t22-c',
                providerId: null,
                credentialVersion: null,
            });
        });

        it('fails open on workRepository.findById throw', async () => {
            const {
                service: svc,
                embedDispatcherMock,
                stamperMock,
            } = await buildWithStamper({
                workFindThrows: true,
            });
            docRepo.create.mockImplementation(async (data) =>
                buildDocument({ ...data, id: 'doc-t22-d' }),
            );

            await svc.createDocument({
                workId: WORK_ID,
                userId: USER_ID,
                path: 'brand/v.md',
                title: 'v',
                class: 'brand' as KbDocumentClass,
                body: 'hi',
            });

            // The workRepository lookup failed — stamper was never
            // called (no tenantId available) and payload ships null/null.
            expect(stamperMock.stamp).not.toHaveBeenCalled();
            expect(embedDispatcherMock.dispatchKbEmbedDocument).toHaveBeenCalledWith({
                workId: WORK_ID,
                documentId: 'doc-t22-d',
                providerId: null,
                credentialVersion: null,
            });
        });
    });

    // EW-742 P3.2 T22 (KB Tier 1 rollout) — same stamping path as the
    // KB-embed PoC, applied to the three other KB dispatchers that
    // share KnowledgeBaseService: KB_MIRROR_DOCUMENT_DISPATCHER,
    // KB_NORMALIZE_MEDIA_DISPATCHER, KB_ORG_OVERLAY_FANOUT_DISPATCHER.
    describe('KB Tier 1 — T22 stamping for the other KnowledgeBaseService dispatchers', () => {
        const TENANT_ID = '00000000-0000-0000-0000-00000000aaaa';

        async function buildWithAllDispatchers(opts: {
            stamperResult?: { providerId: string | null; credentialVersion: number | null };
            workTenantId?: string | null;
            orgTenantId?: string | null;
            orgFindThrows?: boolean;
        }) {
            const embedDispatcherMock = {
                dispatchKbEmbedDocument: jest.fn().mockResolvedValue('embed-run-id'),
            };
            const mirrorDispatcherMock = {
                dispatchKbMirrorDocument: jest.fn().mockResolvedValue('mirror-run-id'),
            };
            const normalizeMediaDispatcherMock = {
                dispatchKbNormalizeMedia: jest.fn().mockResolvedValue('normalize-run-id'),
            };
            const orgOverlayFanoutDispatcherMock = {
                dispatchKbOrgOverlayFanout: jest.fn().mockResolvedValue('fanout-run-id'),
            };
            const workRepoMock = {
                findById: jest
                    .fn()
                    .mockResolvedValue(
                        opts.workTenantId === undefined
                            ? null
                            : ({ id: WORK_ID, tenantId: opts.workTenantId } as any),
                    ),
                findIdsByOrganization: jest.fn().mockResolvedValue(['work-a', 'work-b']),
            };
            const orgRepoMock = {
                findById: opts.orgFindThrows
                    ? jest.fn().mockRejectedValue(new Error('db boom'))
                    : jest
                          .fn()
                          .mockResolvedValue(
                              opts.orgTenantId === undefined
                                  ? null
                                  : ({ id: ORG_ID, tenantId: opts.orgTenantId } as any),
                          ),
            };
            const stamperMock = {
                stamp: jest.fn().mockResolvedValue(
                    opts.stamperResult ?? {
                        providerId: null,
                        credentialVersion: null,
                    },
                ),
            };

            const module: TestingModule = await Test.createTestingModule({
                providers: [
                    KnowledgeBaseService,
                    { provide: WorkKnowledgeDocumentRepository, useValue: docRepo },
                    { provide: WorkKnowledgeUploadRepository, useValue: uploadRepo },
                    { provide: WorkKnowledgeTagRepository, useValue: tagRepo },
                    {
                        provide: WorkKnowledgeCitationRepository,
                        useValue: { listForDocument: jest.fn().mockResolvedValue([]) },
                    },
                    { provide: WorkOwnershipService, useValue: ownership },
                    { provide: KB_STORAGE_PLUGIN, useValue: storage },
                    { provide: ActivityLogService, useValue: activityLog },
                    { provide: KB_EMBED_DOCUMENT_DISPATCHER, useValue: embedDispatcherMock },
                    { provide: KB_MIRROR_DOCUMENT_DISPATCHER, useValue: mirrorDispatcherMock },
                    {
                        provide: KB_NORMALIZE_MEDIA_DISPATCHER,
                        useValue: normalizeMediaDispatcherMock,
                    },
                    {
                        provide: KB_ORG_OVERLAY_FANOUT_DISPATCHER,
                        useValue: orgOverlayFanoutDispatcherMock,
                    },
                    { provide: WorkRepository, useValue: workRepoMock },
                    { provide: RuntimeBindingStamperService, useValue: stamperMock },
                    { provide: OrganizationRepository, useValue: orgRepoMock },
                ],
            }).compile();

            return {
                service: module.get(KnowledgeBaseService),
                embedDispatcherMock,
                mirrorDispatcherMock,
                normalizeMediaDispatcherMock,
                orgOverlayFanoutDispatcherMock,
                workRepoMock,
                orgRepoMock,
                stamperMock,
            };
        }

        it('enqueueMirror — stamps payload via stampForWork', async () => {
            const { service: svc, mirrorDispatcherMock } = await buildWithAllDispatchers({
                workTenantId: TENANT_ID,
                stamperResult: { providerId: 'trigger', credentialVersion: 11 },
            });
            docRepo.create.mockImplementation(async (data) =>
                buildDocument({ ...data, id: 'doc-mirror-1' }),
            );

            await svc.createDocument({
                workId: WORK_ID,
                userId: USER_ID,
                path: 'brand/voice.md',
                title: 'v',
                class: 'brand' as KbDocumentClass,
                body: 'hi',
            });

            expect(mirrorDispatcherMock.dispatchKbMirrorDocument).toHaveBeenCalledTimes(1);
            const payload = mirrorDispatcherMock.dispatchKbMirrorDocument.mock.calls[0][0];
            expect(payload).toMatchObject({
                workId: WORK_ID,
                documentId: 'doc-mirror-1',
                operation: 'upsert',
                providerId: 'trigger',
                credentialVersion: 11,
            });
        });

        it('enqueueOrgOverlayFanout — stamps payload via stampForOrganization', async () => {
            const {
                service: svc,
                orgOverlayFanoutDispatcherMock,
                orgRepoMock,
                stamperMock,
            } = await buildWithAllDispatchers({
                orgTenantId: TENANT_ID,
                stamperResult: { providerId: 'trigger', credentialVersion: 13 },
            });
            docRepo.create.mockImplementation(async (data) =>
                buildDocument({
                    ...data,
                    id: 'org-doc-1',
                    workId: null,
                    organizationId: ORG_ID,
                }),
            );

            await svc.createOrgDocument(ORG_ID, USER_ID, {
                path: 'legal/privacy.md',
                title: 'Privacy policy',
                class: 'legal' as KbDocumentClass,
                body: 'verbatim',
            });

            expect(orgRepoMock.findById).toHaveBeenCalledWith(ORG_ID);
            expect(stamperMock.stamp).toHaveBeenCalledWith(TENANT_ID);
            expect(orgOverlayFanoutDispatcherMock.dispatchKbOrgOverlayFanout).toHaveBeenCalledTimes(
                1,
            );
            const payload =
                orgOverlayFanoutDispatcherMock.dispatchKbOrgOverlayFanout.mock.calls[0][0];
            expect(payload).toMatchObject({
                organizationId: ORG_ID,
                documentId: 'org-doc-1',
                workIds: ['work-a', 'work-b'],
                providerId: 'trigger',
                credentialVersion: 13,
            });
        });

        it('enqueueOrgOverlayFanout — fails open when OrganizationRepository.findById throws', async () => {
            const {
                service: svc,
                orgOverlayFanoutDispatcherMock,
                stamperMock,
            } = await buildWithAllDispatchers({ orgFindThrows: true });
            docRepo.create.mockImplementation(async (data) =>
                buildDocument({
                    ...data,
                    id: 'org-doc-2',
                    workId: null,
                    organizationId: ORG_ID,
                }),
            );

            await svc.createOrgDocument(ORG_ID, USER_ID, {
                path: 'legal/privacy.md',
                title: 'Privacy policy',
                class: 'legal' as KbDocumentClass,
                body: 'verbatim',
            });

            // Org lookup failed → stamper never called → payload ships null/null.
            expect(stamperMock.stamp).not.toHaveBeenCalled();
            expect(orgOverlayFanoutDispatcherMock.dispatchKbOrgOverlayFanout).toHaveBeenCalledTimes(
                1,
            );
            const payload =
                orgOverlayFanoutDispatcherMock.dispatchKbOrgOverlayFanout.mock.calls[0][0];
            expect(payload.providerId).toBeNull();
            expect(payload.credentialVersion).toBeNull();
        });
    });
});
