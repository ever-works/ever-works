import { DataSource } from 'typeorm';
import { WorkspaceBackup } from '@src/entities/workspace-backup.entity';
import { ENTITIES } from '../_entities-inventory';
import { WorkspaceBackupRepository } from './workspace-backup.repository';

/**
 * `findOverdue` executed against a real (in-memory) database — the
 * better-sqlite3 driver CI and the e2e stack run — rather than a mocked query
 * builder, because what is under test is the comparison operator itself and a
 * mock cannot see it.
 *
 * The sweeper is the backstop for the timeout rule `observeRun` already
 * applies on every 10-second look, and that rule is inclusive:
 * `startedAt <= minutesAgo(timeoutMinutes)`. If this query were the stricter
 * of the two, a row sitting exactly on the cutoff would be overdue to the
 * watcher and invisible to its own backstop — so when the watcher is the
 * thing that died, that row waits a further hour for the next pass while its
 * owner stays blocked by the one-at-a-time rule.
 */
describe('WorkspaceBackupRepository.findOverdue (better-sqlite3)', () => {
    let dataSource: DataSource;
    let backups: WorkspaceBackupRepository;

    const USER = '11111111-1111-4111-8111-111111111111';
    const CUTOFF = new Date('2026-09-21T12:00:00.000Z');
    const MINUTE = 60 * 1000;

    const seed = async (id: string, startedAt: Date | null, status = 'running') => {
        await dataSource.getRepository(WorkspaceBackup).save({
            id,
            userId: USER,
            status,
            formatVersion: '1.0',
            includeFullHistory: false,
            startedAt,
        } as Partial<WorkspaceBackup>);
    };

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            // The whole inventory: TypeORM's metadata builder refuses a partial
            // list once an entity's relations reach the rest of the schema.
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        await dataSource.query('PRAGMA foreign_keys = OFF');
        backups = new WorkspaceBackupRepository(dataSource.getRepository(WorkspaceBackup));
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        await dataSource.getRepository(WorkspaceBackup).clear();
    });

    it('returns a row whose startedAt is exactly the cutoff', async () => {
        await seed('11111111-0000-4000-8000-000000000001', CUTOFF);

        const overdue = await backups.findOverdue(CUTOFF, 10);

        expect(overdue.map((b) => b.id)).toEqual(['11111111-0000-4000-8000-000000000001']);
    });

    it('returns rows started before the cutoff and skips rows started after it', async () => {
        await seed('11111111-0000-4000-8000-000000000002', new Date(CUTOFF.getTime() - MINUTE));
        await seed('11111111-0000-4000-8000-000000000003', new Date(CUTOFF.getTime() + MINUTE));

        const overdue = await backups.findOverdue(CUTOFF, 10);

        expect(overdue.map((b) => b.id)).toEqual(['11111111-0000-4000-8000-000000000002']);
    });

    it('ignores rows that are not running, and rows that never started', async () => {
        await seed('11111111-0000-4000-8000-000000000004', CUTOFF, 'ready');
        await seed('11111111-0000-4000-8000-000000000005', CUTOFF, 'queued');
        await seed('11111111-0000-4000-8000-000000000006', null);

        await expect(backups.findOverdue(CUTOFF, 10)).resolves.toEqual([]);
    });

    it('returns the longest-running first and honours the limit', async () => {
        await seed('11111111-0000-4000-8000-000000000007', new Date(CUTOFF.getTime() - MINUTE));
        await seed(
            '11111111-0000-4000-8000-000000000008',
            new Date(CUTOFF.getTime() - 30 * MINUTE),
        );
        await seed(
            '11111111-0000-4000-8000-000000000009',
            new Date(CUTOFF.getTime() - 10 * MINUTE),
        );

        const overdue = await backups.findOverdue(CUTOFF, 2);

        expect(overdue.map((b) => b.id)).toEqual([
            '11111111-0000-4000-8000-000000000008',
            '11111111-0000-4000-8000-000000000009',
        ]);
    });
});
