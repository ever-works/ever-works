import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'yaml';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { KnowledgeBaseGitMirrorService } from '../knowledge-base-git-mirror.service';
import { WorkKnowledgeDocument } from '../../entities/work-knowledge-document.entity';
import {
    KbDecisionStatus,
    KbDocumentClass,
    KbDocumentSource,
    KbDocumentStatus,
    KbReviewState,
} from '../../entities/kb-types';

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
            listFileCommits: jest.fn().mockResolvedValue([]),
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

    // EW-641 Phase 2/e row 37 — org overlay materialization +
    // removal. Same on-disk shape as `materializeDocument` /
    // `removeDocument`, but rooted under `.content/kb/.org/` so
    // Work owners can tell inherited docs apart from local ones.
    describe('materializeOrgDocument (row 37)', () => {
        const ORG_ID = '00000000-0000-0000-0000-000000000003';
        const ORG_DOC_ID = '00000000-0000-0000-0000-000000000020';

        function buildOrgDoc(overrides: Partial<WorkKnowledgeDocument> = {}) {
            return buildDoc({
                id: ORG_DOC_ID,
                workId: null,
                organizationId: ORG_ID,
                path: 'brand/voice.md',
                slug: 'voice',
                kbDocumentClass: 'brand' as KbDocumentClass,
                metadata: { body: '# Org brand voice\n\nUse the org-wide tone.' },
                ...overrides,
            });
        }

        beforeEach(() => {
            documentRepository.findOrgById = jest.fn().mockResolvedValue(buildOrgDoc());
        });

        it('writes sidecar + body under .content/kb/.org/<class>/<slug>.{yml,md}', async () => {
            await service.materializeOrgDocument(WORK_ID, ORG_ID, ORG_DOC_ID);

            expect(documentRepository.findOrgById).toHaveBeenCalledWith(ORG_ID, ORG_DOC_ID);

            const bodyPath = path.join(tempDir, '.content/kb/.org/brand/voice.md');
            const sidecarPath = path.join(tempDir, '.content/kb/.org/brand/voice.yml');

            const body = await fs.readFile(bodyPath, 'utf-8');
            expect(body).toContain('Org brand voice');

            const sidecarRaw = await fs.readFile(sidecarPath, 'utf-8');
            const sidecar = yaml.parse(sidecarRaw);
            // Sidecar carries the org provenance — Work owners can
            // tell from the filesystem alone that this is inherited.
            expect(sidecar.source).toBe('org-overlay');
            expect(sidecar.organizationId).toBe(ORG_ID);

            expect(gitFacade.commit).toHaveBeenCalledWith(
                'github',
                tempDir,
                expect.stringContaining('[kb] upsert org overlay brand/voice'),
                expect.any(Object),
            );
        });

        it('throws NotFoundException when the org doc no longer exists', async () => {
            documentRepository.findOrgById = jest.fn().mockResolvedValue(null);

            await expect(
                service.materializeOrgDocument(WORK_ID, ORG_ID, ORG_DOC_ID),
            ).rejects.toBeInstanceOf(NotFoundException);

            expect(gitFacade.commit).not.toHaveBeenCalled();
            expect(gitFacade.push).not.toHaveBeenCalled();
        });

        it('rejects org docs with traversal paths before touching the repo', async () => {
            documentRepository.findOrgById = jest
                .fn()
                .mockResolvedValue(buildOrgDoc({ path: '../../.git/config' }));

            await expect(
                service.materializeOrgDocument(WORK_ID, ORG_ID, ORG_DOC_ID),
            ).rejects.toBeInstanceOf(BadRequestException);

            // Path validation runs after the clone; the commit call is
            // what's gated. Defense-in-depth — the org doc row itself
            // should never persist a bad path (KnowledgeBaseService
            // validates on write), but a manually-inserted row would
            // be rejected here.
            expect(gitFacade.commit).not.toHaveBeenCalled();
        });

        it('does NOT touch the source doc lastCommitSha (one row → many commits)', async () => {
            documentRepository.update.mockClear();
            await service.materializeOrgDocument(WORK_ID, ORG_ID, ORG_DOC_ID);
            // Per-Work materializations would race for the field if
            // we wrote it back — org rows intentionally skip it.
            expect(documentRepository.update).not.toHaveBeenCalled();
        });
    });

    describe('removeOrgDocument (row 37)', () => {
        it('removes both .org/ sidecar + body and commits with the org-overlay marker', async () => {
            await fs.mkdir(path.join(tempDir, '.content/kb/.org/brand'), { recursive: true });
            await fs.writeFile(
                path.join(tempDir, '.content/kb/.org/brand/voice.yml'),
                'placeholder',
                'utf-8',
            );
            await fs.writeFile(
                path.join(tempDir, '.content/kb/.org/brand/voice.md'),
                'placeholder',
                'utf-8',
            );

            await service.removeOrgDocument(WORK_ID, {
                documentId: '00000000-0000-0000-0000-000000000020',
                path: 'brand/voice.md',
                class: 'brand',
            });

            await expect(
                fs.access(path.join(tempDir, '.content/kb/.org/brand/voice.yml')),
            ).rejects.toBeDefined();
            await expect(
                fs.access(path.join(tempDir, '.content/kb/.org/brand/voice.md')),
            ).rejects.toBeDefined();

            expect(gitFacade.commit).toHaveBeenCalledWith(
                'github',
                tempDir,
                expect.stringContaining('[kb] delete org overlay brand/voice'),
                expect.any(Object),
            );
        });

        it('is idempotent when the overlay files are already gone', async () => {
            await service.removeOrgDocument(WORK_ID, {
                documentId: '00000000-0000-0000-0000-000000000020',
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
                service.removeOrgDocument(WORK_ID, {
                    documentId: '00000000-0000-0000-0000-000000000020',
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

    describe('listDocumentHistory', () => {
        it('fans out to gitFacade.listFileCommits with the resolved KB path', async () => {
            const commits = [
                {
                    sha: 'abc1234',
                    message: 'Edit brand voice',
                    author: { name: 'Ada', email: 'ada@example.test' },
                    date: '2026-05-20T10:00:00Z',
                },
                {
                    sha: 'def5678',
                    message: 'Initial brand seed',
                    author: { name: 'Grace', email: 'grace@example.test' },
                    date: '2026-05-19T08:30:00Z',
                },
            ];
            gitFacade.listFileCommits.mockResolvedValueOnce(commits);

            const result = await service.listDocumentHistory(WORK_ID, DOC_ID, 25);

            // The path the facade gets is `.content/kb/` joined with the
            // doc's relative path, scoping the log to just this doc's body.
            expect(gitFacade.listFileCommits).toHaveBeenCalledWith(
                'ever-works',
                'demo-data',
                '.content/kb/brand/voice.md',
                expect.objectContaining({
                    providerId: 'github',
                    userId: USER_ID,
                    workId: WORK_ID,
                }),
                25,
            );
            expect(result).toEqual([
                {
                    sha: 'abc1234',
                    message: 'Edit brand voice',
                    authorName: 'Ada',
                    authoredAt: '2026-05-20T10:00:00Z',
                },
                {
                    sha: 'def5678',
                    message: 'Initial brand seed',
                    authorName: 'Grace',
                    authoredAt: '2026-05-19T08:30:00Z',
                },
            ]);
        });

        it('returns [] when the plugin returns nothing (capability not implemented)', async () => {
            gitFacade.listFileCommits.mockResolvedValueOnce([]);
            const result = await service.listDocumentHistory(WORK_ID, DOC_ID, 10);
            expect(result).toEqual([]);
        });

        it('handles a missing author.name gracefully', async () => {
            gitFacade.listFileCommits.mockResolvedValueOnce([
                {
                    sha: 'abc1234',
                    message: 'Bot commit',
                    author: { name: undefined, email: '' },
                    date: '2026-05-20T10:00:00Z',
                },
            ]);
            const result = await service.listDocumentHistory(WORK_ID, DOC_ID, 10);
            expect(result[0].authorName).toBe('');
        });

        it('throws NotFoundException when the document does not exist', async () => {
            documentRepository.findById.mockResolvedValueOnce(null);
            await expect(service.listDocumentHistory(WORK_ID, DOC_ID, 25)).rejects.toThrow(
                'KB document not found for history',
            );
        });
    });

    /**
     * Memory upgrades M12 — decision metadata in the git mirror.
     *
     * Before this, the sidecar carried only the KB lifecycle `status`
     * (draft/active/archived), so an agent reading the checked-out repo
     * could not tell a LIVE decision from a REVERSED one, nor an
     * agent-proposed doc awaiting review from an accepted one. These
     * tests pin the round trip in BOTH directions.
     */
    describe('decision metadata round-trip (M12)', () => {
        function buildDecisionDoc() {
            return buildDoc({
                path: 'decision/use-postgres.md',
                slug: 'use-postgres',
                title: 'Use Postgres',
                kbDocumentClass: 'decision' as KbDocumentClass,
                decision: { status: KbDecisionStatus.SUPERSEDED, rationale: 'moved to a fork' },
                reviewState: KbReviewState.PROPOSED,
            } as never);
        }

        describe('write side', () => {
            it('mirrors decision_status + review_state into the sidecar', async () => {
                const doc = buildDecisionDoc();
                documentRepository.findById.mockResolvedValue(doc);
                documentRepository.list.mockResolvedValue({ items: [doc], total: 1 });

                await service.materializeDocument(WORK_ID, DOC_ID);

                const sidecar = yaml.parse(
                    await fs.readFile(
                        path.join(tempDir, '.content/kb/decision/use-postgres.yml'),
                        'utf-8',
                    ),
                );
                expect(sidecar.decision_status).toBe('superseded');
                expect(sidecar.review_state).toBe('proposed');
                // The KB lifecycle status is orthogonal and still present.
                expect(sidecar.status).toBe('active');
            });

            it('writes explicit nulls for a non-decision document (never omits the keys)', async () => {
                await service.materializeDocument(WORK_ID, DOC_ID);

                const sidecar = yaml.parse(
                    await fs.readFile(path.join(tempDir, '.content/kb/brand/voice.yml'), 'utf-8'),
                );
                expect(sidecar).toHaveProperty('decision_status', null);
                expect(sidecar).toHaveProperty('review_state', null);
            });

            it('carries both fields into the .index.yml catalogue', async () => {
                const doc = buildDecisionDoc();
                documentRepository.findById.mockResolvedValue(doc);
                documentRepository.list.mockResolvedValue({ items: [doc], total: 1 });

                await service.materializeDocument(WORK_ID, DOC_ID);

                const index = yaml.parse(
                    await fs.readFile(path.join(tempDir, '.content/kb/.index.yml'), 'utf-8'),
                );
                expect(index.documents[0]).toMatchObject({
                    decision_status: 'superseded',
                    review_state: 'proposed',
                });
            });
        });

        describe('read side — parseSidecarDecisionMetadata', () => {
            it('reads back exactly what the writer wrote (full round trip)', async () => {
                const doc = buildDecisionDoc();
                documentRepository.findById.mockResolvedValue(doc);
                documentRepository.list.mockResolvedValue({ items: [doc], total: 1 });
                await service.materializeDocument(WORK_ID, DOC_ID);
                const written = await fs.readFile(
                    path.join(tempDir, '.content/kb/decision/use-postgres.yml'),
                    'utf-8',
                );

                expect(KnowledgeBaseGitMirrorService.parseSidecarDecisionMetadata(written)).toEqual(
                    {
                        decisionStatus: KbDecisionStatus.SUPERSEDED,
                        reviewState: KbReviewState.PROPOSED,
                    },
                );
            });

            it('DROPS unrecognized values rather than defaulting them', () => {
                const parsed = KnowledgeBaseGitMirrorService.parseSidecarDecisionMetadata(
                    yaml.stringify({ decision_status: 'yolo', review_state: 'maybe' }),
                );
                expect(parsed).toEqual({});
            });

            it('drops absent / null values and keeps the recognized half', () => {
                expect(
                    KnowledgeBaseGitMirrorService.parseSidecarDecisionMetadata(
                        yaml.stringify({ decision_status: null, review_state: 'accepted' }),
                    ),
                ).toEqual({ reviewState: KbReviewState.ACCEPTED });

                expect(
                    KnowledgeBaseGitMirrorService.parseSidecarDecisionMetadata(
                        yaml.stringify({ title: 'no decision keys at all' }),
                    ),
                ).toEqual({});
            });

            it('never throws on corrupt / non-object / empty YAML', () => {
                expect(
                    KnowledgeBaseGitMirrorService.parseSidecarDecisionMetadata('{[not: yaml'),
                ).toEqual({});
                expect(
                    KnowledgeBaseGitMirrorService.parseSidecarDecisionMetadata(
                        '- just\n- a list\n',
                    ),
                ).toEqual({});
                expect(KnowledgeBaseGitMirrorService.parseSidecarDecisionMetadata('')).toEqual({});
                expect(
                    KnowledgeBaseGitMirrorService.parseSidecarDecisionMetadata(
                        undefined as unknown as string,
                    ),
                ).toEqual({});
            });

            it('ignores prototype-shaped keys in a hand-edited sidecar', () => {
                const hostile = '__proto__:\n  decision_status: accepted\ntitle: x\n';
                expect(KnowledgeBaseGitMirrorService.parseSidecarDecisionMetadata(hostile)).toEqual(
                    {},
                );
                expect(({} as Record<string, unknown>).decision_status).toBeUndefined();
            });
        });

        describe('read side — restoreDocumentFromGit', () => {
            it('restores decision status + review state alongside the body', async () => {
                documentRepository.findById.mockResolvedValue(buildDecisionDoc());
                gitFacade.getFileContent
                    // 1st call = body .md, 2nd call = sidecar .yml
                    .mockResolvedValueOnce({ content: '# older\n', encoding: 'utf-8' })
                    .mockResolvedValueOnce({
                        content: yaml.stringify({
                            decision_status: 'accepted',
                            review_state: 'accepted',
                        }),
                        encoding: 'utf-8',
                    });

                await service.restoreDocumentFromGit(WORK_ID, DOC_ID, COMMIT_SHA);

                const patch = documentRepository.update.mock.calls[0][1];
                expect(patch.decision).toMatchObject({ status: KbDecisionStatus.ACCEPTED });
                // Pre-existing decision fields survive the merge.
                expect(patch.decision.rationale).toBe('moved to a fork');
                expect(patch.reviewState).toBe(KbReviewState.ACCEPTED);
            });

            it('leaves decision state UNTOUCHED when the sidecar is missing', async () => {
                documentRepository.findById.mockResolvedValue(buildDecisionDoc());
                gitFacade.getFileContent
                    .mockResolvedValueOnce({ content: '# older\n', encoding: 'utf-8' })
                    .mockResolvedValueOnce(null);

                await service.restoreDocumentFromGit(WORK_ID, DOC_ID, COMMIT_SHA);

                const patch = documentRepository.update.mock.calls[0][1];
                expect(patch).not.toHaveProperty('decision');
                expect(patch).not.toHaveProperty('reviewState');
                // The body restore itself still happened.
                expect(patch.metadata.body).toBe('# older\n');
            });

            it('survives a provider that throws on the sidecar fetch', async () => {
                documentRepository.findById.mockResolvedValue(buildDecisionDoc());
                gitFacade.getFileContent
                    .mockResolvedValueOnce({ content: '# older\n', encoding: 'utf-8' })
                    .mockRejectedValueOnce(new Error('getFileContent not implemented'));

                const result = await service.restoreDocumentFromGit(WORK_ID, DOC_ID, COMMIT_SHA);

                expect(result.restored).toBe(true);
                expect(documentRepository.update.mock.calls[0][1]).not.toHaveProperty('decision');
            });

            it('decodes a base64 sidecar the same way it decodes the body', async () => {
                documentRepository.findById.mockResolvedValue(buildDecisionDoc());
                gitFacade.getFileContent
                    .mockResolvedValueOnce({ content: '# older\n', encoding: 'utf-8' })
                    .mockResolvedValueOnce({
                        content: Buffer.from(
                            yaml.stringify({ review_state: 'accepted' }),
                            'utf-8',
                        ).toString('base64'),
                        encoding: 'base64',
                    });

                await service.restoreDocumentFromGit(WORK_ID, DOC_ID, COMMIT_SHA);

                expect(documentRepository.update.mock.calls[0][1].reviewState).toBe(
                    KbReviewState.ACCEPTED,
                );
            });
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
            // Memory upgrades M12 — decision metadata rides the catalogue.
            decision_status: null,
            review_state: null,
            locked: false,
            lock_mode: null,
            word_count: 12,
            updated_at: '2026-05-21T12:30:00.000Z',
        };
    }
});
