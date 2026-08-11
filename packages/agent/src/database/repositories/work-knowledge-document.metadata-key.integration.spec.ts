import { DataSource, Repository } from 'typeorm';
import { ENTITIES } from '../_entities-inventory';
import { User } from '../../entities/user.entity';
import { Work } from '../../entities/work.entity';
import { WorkKnowledgeDocument } from '../../entities/work-knowledge-document.entity';
import { KbDocumentClass, KbDocumentStatus } from '../../entities/kb-types';
import { WorkKnowledgeDocumentRepository } from './work-knowledge-document.repository';

/**
 * Guard for `findByMetadataKey` — the transcribe idempotency check.
 *
 * The predicate was `(doc.metadata::jsonb) ->> :key = :value`. Both `::`
 * and `->>` are PostgreSQL-only, so the statement is a syntax error on
 * SQLite and the whole transcribe pipeline crashed at the point that is
 * supposed to stop a Trigger.dev retry creating a duplicate transcript.
 *
 * Nothing could catch it: the method's own docstring conceded the gap
 * ("the test DB uses an in-memory mock at the repo layer (no SQL is
 * exercised)") and `knowledge-base-transcribe.service.spec.ts` mocks
 * `findByMetadataKey` outright.
 *
 * The fix follows the precedent already in this codebase —
 * `work-knowledge-chunk.repository.ts` branches on
 * `manager.connection.options.type` for its pgvector query. Postgres keeps
 * the indexed `jsonb` path; every other driver gets a portable pre-filter
 * plus an exact in-JS comparison.
 *
 * Both halves are tested: the SQLite path by execution, the Postgres path
 * by asserting the emitted clause still carries the cast (a mocked
 * connection is the only way to reach it without a live Postgres).
 */
describe('WorkKnowledgeDocumentRepository.findByMetadataKey (integration)', () => {
    const UPLOAD_ID = 'upload-abc-123';

    describe('on better-sqlite3 (demo / OSS self-host / CI)', () => {
        let dataSource: DataSource;
        let kbDocs: Repository<WorkKnowledgeDocument>;
        let repository: WorkKnowledgeDocumentRepository;
        let workId: string;
        let otherWorkId: string;

        beforeAll(async () => {
            dataSource = new DataSource({
                type: 'better-sqlite3',
                database: ':memory:',
                entities: ENTITIES,
                synchronize: true,
            });
            await dataSource.initialize();

            kbDocs = dataSource.getRepository(WorkKnowledgeDocument);
            repository = new WorkKnowledgeDocumentRepository(kbDocs);

            const users = dataSource.getRepository(User);
            const user = await users.save(
                users.create({
                    username: 'transcriber',
                    email: 'transcriber@example.com',
                    password: 'x',
                } as Partial<User>),
            );

            const works = dataSource.getRepository(Work);
            const makeWork = async (slug: string) =>
                (
                    await works.save(
                        works.create({
                            userId: user.id,
                            name: slug,
                            slug,
                            description: slug,
                        } as Partial<Work>),
                    )
                ).id;

            workId = await makeWork('primary-work');
            otherWorkId = await makeWork('other-work');

            const seed = (
                path: string,
                metadata: Record<string, unknown> | null,
                owner: string = workId,
            ) =>
                kbDocs.save(
                    kbDocs.create({
                        workId: owner,
                        path,
                        slug: path.replace(/\W+/g, '-'),
                        title: path,
                        kbDocumentClass: KbDocumentClass.FREEFORM,
                        status: KbDocumentStatus.ACTIVE,
                        metadata,
                    } as Partial<WorkKnowledgeDocument>),
                );

            await seed('transcripts/one.md', { transcribedFromUploadId: UPLOAD_ID, lang: 'en' });
            await seed('transcripts/two.md', { transcribedFromUploadId: 'upload-other' });
            await seed('notes/plain.md', null);
            // Same metadata value, different Work — must never leak across scope.
            await seed(
                'transcripts/other-work.md',
                { transcribedFromUploadId: UPLOAD_ID },
                otherWorkId,
            );
        });

        afterAll(async () => {
            if (dataSource?.isInitialized) await dataSource.destroy();
        });

        it('finds the document whose metadata key holds the value', async () => {
            const found = await repository.findByMetadataKey(
                workId,
                'transcribedFromUploadId',
                UPLOAD_ID,
            );
            expect(found?.path).toBe('transcripts/one.md');
        });

        it('returns null when no document carries that value', async () => {
            const found = await repository.findByMetadataKey(
                workId,
                'transcribedFromUploadId',
                'upload-never-seen',
            );
            expect(found).toBeNull();
        });

        it('does not match a different key that happens to hold the same value', async () => {
            const found = await repository.findByMetadataKey(workId, 'lang', UPLOAD_ID);
            expect(found).toBeNull();
        });

        it('stays scoped to the Work — an identical value elsewhere is a different row', async () => {
            const found = await repository.findByMetadataKey(
                otherWorkId,
                'transcribedFromUploadId',
                UPLOAD_ID,
            );
            expect(found?.path).toBe('transcripts/other-work.md');
        });
    });

    describe('on postgres', () => {
        it('keeps the indexed jsonb predicate', async () => {
            const clauses: string[] = [];
            const qb = {
                where: jest.fn(() => qb),
                andWhere: jest.fn((clause: string) => {
                    clauses.push(clause);
                    return qb;
                }),
                getOne: jest.fn(async () => null),
                getMany: jest.fn(async () => []),
            };
            const fake = {
                createQueryBuilder: jest.fn(() => qb),
                manager: { connection: { options: { type: 'postgres' } } },
            } as unknown as Repository<WorkKnowledgeDocument>;

            const repository = new WorkKnowledgeDocumentRepository(fake);
            await repository.findByMetadataKey(
                '44444444-4444-4444-8444-444444444444',
                'transcribedFromUploadId',
                UPLOAD_ID,
            );

            expect(clauses.join(' | ')).toContain('::jsonb');
            expect(clauses.join(' | ')).toContain('->>');
        });
    });
});
