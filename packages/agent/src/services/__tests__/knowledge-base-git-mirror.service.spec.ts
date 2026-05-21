import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'yaml';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { KnowledgeBaseGitMirrorService } from '../knowledge-base-git-mirror.service';
import { WorkKnowledgeDocument } from '../../entities/work-knowledge-document.entity';
import { KbDocumentClass, KbDocumentSource, KbDocumentStatus } from '../../entities/kb-types';

/**
 * EW-641 Phase 1B/a — focused unit coverage for the KB Git mirror.
 *
 * These tests stub the heavy collaborators (GitFacade, WorkRepository,
 * WorkKnowledgeDocumentRepository) and exercise the disk + YAML side
 * against a real `os.tmpdir()` location. The Trigger.dev wrapper is
 * covered indirectly via the task body; full end-to-end coverage
 * lives in the API e2e suite.
 */
describe('KnowledgeBaseGitMirrorService', () => {
    const WORK_ID = '00000000-0000-0000-0000-000000000001';
    const DOC_ID = '00000000-0000-0000-0000-000000000010';
    const USER_ID = '00000000-0000-0000-0000-000000000002';
    const COMMIT_SHA = 'deadbeefcafe1234567890abcdef1234567890ab';

    let tempDir: string;
    let gitFacade: jest.Mocked<any>;
    let workRepository: jest.Mocked<any>;
    let documentRepository: jest.Mocked<any>;
    let service: KnowledgeBaseGitMirrorService;

    function buildWork(overrides: Record<string, unknown> = {}) {
        return {
            id: WORK_ID,
            gitProvider: 'github',
            user: { id: USER_ID, email: 'op@example.com' },
            getRepoOwner: jest.fn().mockReturnValue('ever-works'),
            getDataRepo: jest.fn().mockReturnValue('demo-data'),
            resolveCommitter: jest
                .fn()
                .mockReturnValue({ name: 'Ever Works Bot', email: 'bot@ever.works' }),
            ...overrides,
        };
    }

    function buildDoc(overrides: Partial<WorkKnowledgeDocument> = {}): WorkKnowledgeDocument {
        return {
            id: DOC_ID,
            workId: WORK_ID,
            organizationId: null,
            path: 'brand/voice.md',
            slug: 'voice',
            title: 'Brand voice',
            description: 'Tone + register',
            kbDocumentClass: 'brand' as KbDocumentClass,
            tags: ['brand', 'voice'],
            categories: null,
            status: 'active' as KbDocumentStatus,
            locked: false,
            lockMode: null,
            language: 'en',
            wordCount: 12,
            tokenCount: 16,
            source: 'user' as KbDocumentSource,
            sourceUploadId: null,
            sourceUrl: null,
            generatedByAgentRunId: null,
            createdById: USER_ID,
            updatedById: USER_ID,
            lastIndexedAt: null,
            lastCommitSha: null,
            metadata: { body: '# Brand voice\n\nClear, confident, never breathless.' },
            createdAt: new Date('2026-05-21T12:00:00Z'),
            updatedAt: new Date('2026-05-21T12:30:00Z'),
            ...overrides,
        } as WorkKnowledgeDocument;
    }

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-mirror-spec-'));

        gitFacade = {
            cloneOrPull: jest.fn().mockResolvedValue(tempDir),
            addAll: jest.fn().mockResolvedValue(undefined),
            getStatus: jest.fn().mockResolvedValue([{ path: 'x', status: 'added' }]),
            commit: jest.fn().mockResolvedValue(COMMIT_SHA),
            push: jest.fn().mockResolvedValue(undefined),
            getFileContent: jest.fn(),
        };

        workRepository = {
            findById: jest.fn().mockResolvedValue(buildWork()),
        };

        documentRepository = {
            findById: jest.fn().mockResolvedValue(buildDoc()),
            list: jest.fn().mockResolvedValue({ items: [buildDoc()], total: 1 }),
            update: jest.fn().mockResolvedValue(buildDoc()),
        };

        service = new KnowledgeBaseGitMirrorService(gitFacade, workRepository, documentRepository);
    });

    afterEach(async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    describe('materializeDocument', () => {
        it('writes sidecar + body to the data repo and updates lastCommitSha', async () => {
            await service.materializeDocument(WORK_ID, DOC_ID);

            const sidecar = await fs.readFile(
                path.join(tempDir, '.content/kb/brand/voice.yml'),
                'utf-8',
            );
            const body = await fs.readFile(
                path.join(tempDir, '.content/kb/brand/voice.md'),
                'utf-8',
            );

            const parsed = yaml.parse(sidecar);
            expect(parsed.id).toBe(DOC_ID);
            expect(parsed.class).toBe('brand');
            expect(parsed.slug).toBe('voice');
            expect(parsed.tags).toEqual(['brand', 'voice']);
            expect(parsed.title).toBe('Brand voice');
            expect(body).toContain('# Brand voice');

            expect(gitFacade.commit).toHaveBeenCalledWith(
                'github',
                tempDir,
                expect.stringContaining('[kb] upsert brand/voice'),
                expect.any(Object),
            );
            expect(gitFacade.push).toHaveBeenCalled();
            expect(documentRepository.update).toHaveBeenCalledWith(DOC_ID, {
                lastCommitSha: COMMIT_SHA,
            });
        });

        it('rebuilds .index.yml on every materialize', async () => {
            await service.materializeDocument(WORK_ID, DOC_ID);

            const indexRaw = await fs.readFile(
                path.join(tempDir, '.content/kb/.index.yml'),
                'utf-8',
            );
            const indexed = yaml.parse(indexRaw);
            expect(indexed.version).toBe(1);
            expect(indexed.generator).toBe('ever-works-platform/kb-indexer');
            expect(Array.isArray(indexed.documents)).toBe(true);
            expect(indexed.documents[0]).toMatchObject({
                id: DOC_ID,
                path: 'brand/voice.md',
                class: 'brand',
            });
        });

        it('paginates the .index.yml rebuild across multiple pages', async () => {
            // Spread the work over three pages: 500 + 500 + 7 = 1007 docs.
            // The repo mock returns enough on each call to force the loop
            // through all three pages — no silent truncation at page 1.
            const pageOne = Array.from({ length: 500 }, (_, i) =>
                buildDoc({
                    id: `00000000-0000-0000-0000-${(1000 + i).toString().padStart(12, '0')}`,
                    path: `brand/doc-${1000 + i}.md`,
                    slug: `doc-${1000 + i}`,
                }),
            );
            const pageTwo = Array.from({ length: 500 }, (_, i) =>
                buildDoc({
                    id: `00000000-0000-0000-0000-${(2000 + i).toString().padStart(12, '0')}`,
                    path: `brand/doc-${2000 + i}.md`,
                    slug: `doc-${2000 + i}`,
                }),
            );
            const pageThree = Array.from({ length: 7 }, (_, i) =>
                buildDoc({
                    id: `00000000-0000-0000-0000-${(3000 + i).toString().padStart(12, '0')}`,
                    path: `brand/doc-${3000 + i}.md`,
                    slug: `doc-${3000 + i}`,
                }),
            );
            const total = pageOne.length + pageTwo.length + pageThree.length;
            documentRepository.list
                .mockResolvedValueOnce({ items: pageOne, total })
                .mockResolvedValueOnce({ items: pageTwo, total })
                .mockResolvedValueOnce({ items: pageThree, total });

            await service.materializeDocument(WORK_ID, DOC_ID);

            const indexRaw = await fs.readFile(
                path.join(tempDir, '.content/kb/.index.yml'),
                'utf-8',
            );
            const indexed = yaml.parse(indexRaw);
            expect(indexed.documents).toHaveLength(total);
            expect(documentRepository.list).toHaveBeenCalledTimes(3);
        });

        it('skips the commit + lastCommitSha update when the worktree is clean', async () => {
            gitFacade.getStatus.mockResolvedValueOnce([]);

            await service.materializeDocument(WORK_ID, DOC_ID);

            expect(gitFacade.commit).not.toHaveBeenCalled();
            expect(gitFacade.push).not.toHaveBeenCalled();
            expect(documentRepository.update).not.toHaveBeenCalled();
        });

        it('throws NotFoundException when the document row is missing', async () => {
            documentRepository.findById.mockResolvedValueOnce(null);

            await expect(service.materializeDocument(WORK_ID, DOC_ID)).rejects.toBeInstanceOf(
                NotFoundException,
            );
        });

        it('ensures every class folder + .index.yml exists (idempotent skeleton)', async () => {
            await service.materializeDocument(WORK_ID, DOC_ID);

            for (const folder of Object.values(KbDocumentClass)) {
                const gitkeep = path.join(tempDir, '.content/kb', folder as string, '.gitkeep');
                await expect(fs.access(gitkeep)).resolves.toBeUndefined();
            }
        });

        it.each([
            '../../.git/config',
            'brand/../../../etc/passwd',
            '/absolute/voice.md',
            'brand\\voice.md',
            'C:/Windows/voice.md',
            'unknown-class/voice.md',
            '',
        ])('rejects traversal/absolute/unknown-class path %s', async (badPath) => {
            documentRepository.findById.mockResolvedValueOnce(buildDoc({ path: badPath }));

            await expect(service.materializeDocument(WORK_ID, DOC_ID)).rejects.toBeInstanceOf(
                BadRequestException,
            );

            // The Git side must not have been touched — no clone, no commit.
            expect(gitFacade.commit).not.toHaveBeenCalled();
            expect(gitFacade.push).not.toHaveBeenCalled();
        });
    });

    describe('removeDocument', () => {
        it('removes both sidecar + body and commits the deletion', async () => {
            await fs.mkdir(path.join(tempDir, '.content/kb/brand'), { recursive: true });
            await fs.writeFile(
                path.join(tempDir, '.content/kb/brand/voice.yml'),
                'placeholder',
                'utf-8',
            );
            await fs.writeFile(
                path.join(tempDir, '.content/kb/brand/voice.md'),
                'placeholder',
                'utf-8',
            );

            await service.removeDocument(WORK_ID, {
                documentId: DOC_ID,
                path: 'brand/voice.md',
                class: 'brand',
            });

            await expect(
                fs.access(path.join(tempDir, '.content/kb/brand/voice.yml')),
            ).rejects.toBeDefined();
            await expect(
                fs.access(path.join(tempDir, '.content/kb/brand/voice.md')),
            ).rejects.toBeDefined();

            expect(gitFacade.commit).toHaveBeenCalledWith(
                'github',
                tempDir,
                expect.stringContaining('[kb] delete brand/voice'),
                expect.any(Object),
            );
        });

        it('is idempotent when the files are already gone', async () => {
            // No files on disk to begin with — the call should still
            // refresh the index and produce a commit message that
            // marks the absent state.
            gitFacade.getStatus.mockResolvedValueOnce([
                { path: '.content/kb/.index.yml', status: 'modified' },
            ]);

            await service.removeDocument(WORK_ID, {
                documentId: DOC_ID,
                path: 'brand/missing.md',
                class: 'brand',
            });

            expect(gitFacade.commit).toHaveBeenCalledWith(
                'github',
                tempDir,
                expect.stringContaining('already absent'),
                expect.any(Object),
            );
        });

        it('rejects traversal paths before unlinking anything', async () => {
            await expect(
                service.removeDocument(WORK_ID, {
                    documentId: DOC_ID,
                    path: '../../.git/config',
                    class: 'brand',
                }),
            ).rejects.toBeInstanceOf(BadRequestException);

            expect(gitFacade.commit).not.toHaveBeenCalled();
        });
    });

    describe('initializeSkeleton', () => {
        it('creates the empty class folders + .index.yml and commits once', async () => {
            await service.initializeSkeleton(WORK_ID);

            const indexRaw = await fs.readFile(
                path.join(tempDir, '.content/kb/.index.yml'),
                'utf-8',
            );
            expect(yaml.parse(indexRaw).documents).toEqual([buildDocIndexShape()]);
            expect(gitFacade.commit).toHaveBeenCalledWith(
                'github',
                tempDir,
                expect.stringContaining('initialize knowledge-base skeleton'),
                expect.any(Object),
            );
        });
    });

    describe('restoreDocumentFromGit', () => {
        it('reads the body at the supplied SHA and updates the row', async () => {
            gitFacade.getFileContent.mockResolvedValueOnce({
                content: '# Older brand voice\n',
                encoding: 'utf-8',
            });

            const result = await service.restoreDocumentFromGit(WORK_ID, DOC_ID, COMMIT_SHA);

            expect(result.restored).toBe(true);
            expect(result.body).toBe('# Older brand voice\n');
            expect(gitFacade.getFileContent).toHaveBeenCalledWith(
                'ever-works',
                'demo-data',
                '.content/kb/brand/voice.md',
                expect.objectContaining({ providerId: 'github', userId: USER_ID }),
                COMMIT_SHA,
            );
            expect(documentRepository.update).toHaveBeenCalledWith(
                DOC_ID,
                expect.objectContaining({
                    metadata: expect.objectContaining({ body: '# Older brand voice\n' }),
                }),
            );
        });

        it('decodes base64 content from providers that return it that way', async () => {
            gitFacade.getFileContent.mockResolvedValueOnce({
                content: Buffer.from('# encoded', 'utf-8').toString('base64'),
                encoding: 'base64',
            });

            const result = await service.restoreDocumentFromGit(WORK_ID, DOC_ID, COMMIT_SHA);

            expect(result.restored).toBe(true);
            expect(result.body).toBe('# encoded');
        });

        it('returns restored=false when the commit does not contain the file', async () => {
            gitFacade.getFileContent.mockResolvedValueOnce(null);

            const result = await service.restoreDocumentFromGit(WORK_ID, DOC_ID, COMMIT_SHA);

            expect(result.restored).toBe(false);
            expect(documentRepository.update).not.toHaveBeenCalled();
        });
    });

    function buildDocIndexShape() {
        return {
            id: DOC_ID,
            path: 'brand/voice.md',
            title: 'Brand voice',
            class: 'brand',
            tags: ['brand', 'voice'],
            status: 'active',
            locked: false,
            lock_mode: null,
            word_count: 12,
            updated_at: '2026-05-21T12:30:00.000Z',
        };
    }
});
