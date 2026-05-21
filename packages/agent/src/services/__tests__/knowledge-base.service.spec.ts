import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { KnowledgeBaseService } from '../knowledge-base.service';
import { WorkKnowledgeDocumentRepository } from '../../database/repositories/work-knowledge-document.repository';
import { WorkKnowledgeUploadRepository } from '../../database/repositories/work-knowledge-upload.repository';
import { WorkKnowledgeTagRepository } from '../../database/repositories/work-knowledge-tag.repository';
import { WorkKnowledgeCitationRepository } from '../../database/repositories/work-knowledge-citation.repository';
import { WorkOwnershipService } from '../work-ownership.service';
import { WorkKnowledgeDocument } from '../../entities/work-knowledge-document.entity';
import {
    KbDocumentClass,
    KbDocumentSource,
    KbDocumentStatus,
    KbLockMode,
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
    let tagRepo: jest.Mocked<WorkKnowledgeTagRepository>;
    let ownership: jest.Mocked<WorkOwnershipService>;

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

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                KnowledgeBaseService,
                { provide: WorkKnowledgeDocumentRepository, useValue: docRepoMock },
                { provide: WorkKnowledgeUploadRepository, useValue: {} },
                { provide: WorkKnowledgeTagRepository, useValue: tagRepoMock },
                {
                    provide: WorkKnowledgeCitationRepository,
                    useValue: { listForDocument: jest.fn().mockResolvedValue([]) },
                },
                { provide: WorkOwnershipService, useValue: ownershipMock },
            ],
        }).compile();

        service = module.get(KnowledgeBaseService);
        docRepo = module.get(WorkKnowledgeDocumentRepository);
        tagRepo = module.get(WorkKnowledgeTagRepository);
        ownership = module.get(WorkOwnershipService);
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

    describe('restoreDocumentFromHistory', () => {
        it('rejects editor-role callers (manager+ required)', async () => {
            // Default ownership mock returns 'editor' — restore needs
            // owner/manager per spec §20.
            await expect(
                service.restoreDocumentFromHistory(WORK_ID, 'docId', USER_ID, 'abc1234'),
            ).rejects.toBeInstanceOf(ForbiddenException);
        });

        it('fails fast when the KB Git mirror service is not wired', async () => {
            // Default test module bootstraps without
            // `KnowledgeBaseGitMirrorService`, so callers with sufficient
            // role get a 400 explaining the deployment is incomplete.
            ownership.ensureCanEdit.mockResolvedValueOnce({ role: 'owner' } as any);
            await expect(
                service.restoreDocumentFromHistory(WORK_ID, 'docId', USER_ID, 'abc1234'),
            ).rejects.toBeInstanceOf(BadRequestException);
        });
    });
});
