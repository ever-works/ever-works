import {
    BadRequestException,
    ForbiddenException,
    NotFoundException,
    ServiceUnavailableException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { KB_STORAGE_PLUGIN, KnowledgeBaseService } from '../knowledge-base.service';
import { KB_EMBED_DOCUMENT_DISPATCHER } from '../../tasks/kb-embed-document-dispatcher';
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

            expect(embedDispatcher.dispatchKbEmbedDocument).toHaveBeenCalledWith({
                workId: WORK_ID,
                documentId: 'doc-99',
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

        it('unsupported MIME: marks upload skipped + emits kb_upload_extraction_skipped', async () => {
            storage.putObject.mockResolvedValue({ key: 'kb-originals/freeform/abc.bin', url: '' });
            const uploadRow = buildUpload({ mimeType: 'application/pdf' });
            uploadRepo.create.mockResolvedValue(uploadRow);
            uploadRepo.update.mockResolvedValue({
                ...uploadRow,
                extractionStatus: 'skipped' as KbUploadExtractionStatus,
            });

            const result = await service.createUpload({
                ...buildUploadInput({ mimeType: 'application/pdf', originalFilename: 'spec.pdf' }),
                targetClass: undefined,
            });

            expect(result.document).toBeNull();
            expect(uploadRepo.update).toHaveBeenCalledWith(
                uploadRow.id,
                expect.objectContaining({ extractionStatus: 'skipped' }),
            );
            const kinds = activityLog.log.mock.calls.map(
                (c) => (c[0] as { actionType: string }).actionType,
            );
            expect(kinds).toContain(ActivityActionType.KB_UPLOAD_EXTRACTION_SKIPPED);
            expect(kinds).not.toContain(ActivityActionType.KB_DOCUMENT_CREATED);
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
});
