import { Test, TestingModule } from '@nestjs/testing';
import {
    buildWikilinkRegex,
    KnowledgeBaseWikilinkRewriterService,
} from './knowledge-base-wikilink-rewriter.service';
import { WorkKnowledgeDocumentRepository } from '../database/repositories/work-knowledge-document.repository';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ActivityActionType } from '../entities/activity-log.types';
import { WorkKnowledgeDocument } from '../entities/work-knowledge-document.entity';
import { KbDocumentStatus } from '../entities/kb-types';

const WORK_ID = '00000000-0000-0000-0000-000000000001';
const ACTOR_USER_ID = '00000000-0000-0000-0000-000000000099';

function buildDoc(
    overrides: Partial<WorkKnowledgeDocument> & { body?: string },
): WorkKnowledgeDocument {
    const { body, metadata, ...rest } = overrides;
    const mergedMetadata =
        metadata !== undefined
            ? metadata
            : body !== undefined
              ? ({ body } as Record<string, unknown>)
              : null;
    return {
        id: rest.id ?? '00000000-0000-0000-0000-00000000000a',
        workId: WORK_ID,
        organizationId: null,
        path: rest.path ?? 'notes/sample.md',
        slug: 'sample',
        title: 'Sample',
        description: null,
        kbDocumentClass: 'freeform',
        tags: null,
        categories: null,
        status: KbDocumentStatus.ACTIVE,
        locked: false,
        lockMode: null,
        language: 'en',
        wordCount: 0,
        tokenCount: 0,
        source: 'user',
        sourceUploadId: null,
        sourceUrl: null,
        generatedByAgentRunId: null,
        createdById: ACTOR_USER_ID,
        updatedById: ACTOR_USER_ID,
        createdAt: new Date('2026-06-01T00:00:00Z'),
        updatedAt: new Date('2026-06-01T00:00:00Z'),
        lastCommitSha: null,
        lastIndexedAt: null,
        metadata: mergedMetadata,
        ...rest,
    } as WorkKnowledgeDocument;
}

describe('KnowledgeBaseWikilinkRewriterService', () => {
    let service: KnowledgeBaseWikilinkRewriterService;
    let documents: jest.Mocked<Pick<WorkKnowledgeDocumentRepository, 'list' | 'update'>>;
    let activityLog: { log: jest.Mock };

    beforeEach(async () => {
        documents = {
            list: jest.fn(),
            update: jest.fn().mockResolvedValue(null),
        };
        activityLog = { log: jest.fn().mockResolvedValue(undefined) };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                KnowledgeBaseWikilinkRewriterService,
                { provide: WorkKnowledgeDocumentRepository, useValue: documents },
                { provide: ActivityLogService, useValue: activityLog },
            ],
        }).compile();

        service = module.get(KnowledgeBaseWikilinkRewriterService);
    });

    describe('buildWikilinkRegex (exported helper)', () => {
        it('matches a literal wikilink without regex meta chars', () => {
            const re = buildWikilinkRegex('notes/sample.md');
            expect(re.test('see [[notes/sample.md]] for details')).toBe(true);
        });

        it('escapes regex meta chars so foo.bar does NOT match foo_bar', () => {
            const re = buildWikilinkRegex('foo.bar');
            // Bare `.` would otherwise match any single char — with
            // escaping, `[[foo_bar]]` must NOT match.
            expect(re.test('see [[foo_bar]] now')).toBe(false);
            expect(re.test('see [[foo.bar]] now')).toBe(true);
        });

        it('carries the global flag for replace-all semantics', () => {
            const re = buildWikilinkRegex('a');
            expect(re.flags).toContain('g');
        });
    });

    describe('rewriteReferences', () => {
        it('returns documentsTouched: 0 when no doc body contains the wikilink', async () => {
            documents.list.mockResolvedValue({
                items: [
                    buildDoc({
                        id: 'doc-1',
                        path: 'notes/other.md',
                        body: 'no wikilinks at all here',
                    }),
                    buildDoc({
                        id: 'doc-2',
                        path: 'notes/third.md',
                        body: 'mentions [[unrelated/doc.md]] only',
                    }),
                ],
                total: 2,
            });

            const result = await service.rewriteReferences({
                workId: WORK_ID,
                oldPath: 'notes/sample.md',
                newPath: 'notes/renamed.md',
                actorUserId: ACTOR_USER_ID,
            });

            expect(result).toEqual({ documentsTouched: 0 });
            expect(documents.update).not.toHaveBeenCalled();
            // Activity log still fires — observers want zero-touch
            // events as well so the activity feed can show "no
            // references needed updating".
            expect(activityLog.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    actionType: ActivityActionType.KB_WIKILINK_REWRITTEN,
                    details: expect.objectContaining({ documentsTouched: 0 }),
                }),
            );
        });

        it('rewrites both occurrences in a document with two matches', async () => {
            documents.list.mockResolvedValue({
                items: [
                    buildDoc({
                        id: 'doc-with-refs',
                        path: 'notes/citing.md',
                        body:
                            'First reference [[notes/sample.md]] and a second ' +
                            'reference [[notes/sample.md]] later.',
                    }),
                ],
                total: 1,
            });

            const result = await service.rewriteReferences({
                workId: WORK_ID,
                oldPath: 'notes/sample.md',
                newPath: 'notes/renamed.md',
                actorUserId: ACTOR_USER_ID,
            });

            expect(result).toEqual({ documentsTouched: 1 });
            expect(documents.update).toHaveBeenCalledTimes(1);
            const [docId, patch] = documents.update.mock.calls[0];
            expect(docId).toBe('doc-with-refs');
            const metadata = (patch as { metadata: { body: string } }).metadata;
            expect(metadata.body).toBe(
                'First reference [[notes/renamed.md]] and a second ' +
                    'reference [[notes/renamed.md]] later.',
            );
            // The rewriter must NOT leave any stale references behind.
            expect(metadata.body).not.toContain('[[notes/sample.md]]');
            // And the actor user must be propagated as the updatedBy
            // so the audit trail reflects who triggered the cascade.
            expect((patch as { updatedById: string }).updatedById).toBe(ACTOR_USER_ID);
        });

        it('excludes the renamed document itself from the scan (no self-rewrite)', async () => {
            // The renamed doc still references its OLD path in its own
            // body (deliberate or accidental). The rewriter must leave
            // it alone — both before persistence (path === oldPath) and
            // after persistence (path === newPath).
            documents.list.mockResolvedValue({
                items: [
                    buildDoc({
                        id: 'renamed-doc-before',
                        path: 'notes/sample.md',
                        body: 'self-ref [[notes/sample.md]] in my own body',
                    }),
                    buildDoc({
                        id: 'renamed-doc-after',
                        path: 'notes/renamed.md',
                        body: 'self-ref [[notes/sample.md]] in my own body',
                    }),
                    buildDoc({
                        id: 'other-doc',
                        path: 'notes/elsewhere.md',
                        body: 'cross-ref [[notes/sample.md]] from elsewhere',
                    }),
                ],
                total: 3,
            });

            const result = await service.rewriteReferences({
                workId: WORK_ID,
                oldPath: 'notes/sample.md',
                newPath: 'notes/renamed.md',
                actorUserId: ACTOR_USER_ID,
            });

            expect(result).toEqual({ documentsTouched: 1 });
            expect(documents.update).toHaveBeenCalledTimes(1);
            expect(documents.update.mock.calls[0][0]).toBe('other-doc');
        });

        it('escapes regex-meta chars in oldPath so foo.bar does NOT match foo_bar', async () => {
            // A doc whose body references `[[foo_bar]]` must stay
            // untouched when `oldPath` is `foo.bar` — without escaping,
            // the `.` would match the `_` and we'd corrupt unrelated
            // references on every rename of a dotted path.
            documents.list.mockResolvedValue({
                items: [
                    buildDoc({
                        id: 'doc-foo-underscore',
                        path: 'notes/under.md',
                        body: 'this references [[foo_bar]] and nothing else',
                    }),
                    buildDoc({
                        id: 'doc-foo-dot',
                        path: 'notes/dot.md',
                        body: 'this references [[foo.bar]] which IS the target',
                    }),
                ],
                total: 2,
            });

            const result = await service.rewriteReferences({
                workId: WORK_ID,
                oldPath: 'foo.bar',
                newPath: 'foo.baz',
                actorUserId: ACTOR_USER_ID,
            });

            expect(result).toEqual({ documentsTouched: 1 });
            expect(documents.update).toHaveBeenCalledTimes(1);
            const [docId, patch] = documents.update.mock.calls[0];
            expect(docId).toBe('doc-foo-dot');
            expect((patch as { metadata: { body: string } }).metadata.body).toBe(
                'this references [[foo.baz]] which IS the target',
            );
        });

        it('returns documentsTouched: 0 when oldPath === newPath without hitting the DB', async () => {
            const result = await service.rewriteReferences({
                workId: WORK_ID,
                oldPath: 'notes/sample.md',
                newPath: 'notes/sample.md',
                actorUserId: ACTOR_USER_ID,
            });

            expect(result).toEqual({ documentsTouched: 0 });
            expect(documents.list).not.toHaveBeenCalled();
            expect(documents.update).not.toHaveBeenCalled();
        });

        it('does not bubble an activity-log failure back to the caller', async () => {
            documents.list.mockResolvedValue({ items: [], total: 0 });
            activityLog.log.mockRejectedValueOnce(new Error('log table offline'));

            await expect(
                service.rewriteReferences({
                    workId: WORK_ID,
                    oldPath: 'notes/sample.md',
                    newPath: 'notes/renamed.md',
                    actorUserId: ACTOR_USER_ID,
                }),
            ).resolves.toEqual({ documentsTouched: 0 });
        });
    });
});
