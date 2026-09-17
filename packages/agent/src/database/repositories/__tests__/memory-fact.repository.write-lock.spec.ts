import { advisoryLockObjectId, RUN_ADMISSION_LOCK_CLASS_ID } from '../agent-run.repository';
import {
    MEMORY_FACT_WRITE_LOCK_CLASS_ID,
    MemoryFactRepository,
    memoryFactWriteLockKey,
} from '../memory-fact.repository';
import {
    COMPUTER_NODE_ADMISSION_LOCK_CLASS_ID,
    COMPUTER_SCOPE_ADMISSION_LOCK_CLASS_ID,
} from '../../../computer/computer-session.repository';

/**
 * AW-07 — the memory-fact workspace write lock. Pinned: on Postgres the
 * check-then-write runs inside ONE transaction holding
 * `pg_advisory_xact_lock` on the workspace key, through a repository bound to
 * that transaction; on every driver, writes with the same key never overlap
 * in process; a lock that cannot be taken never stops a write; a critical
 * section that already ran is never run twice.
 */

const USER = 'user-1';
const ORG = { tenantId: 'tenant-1', organizationId: 'org-1' };

function build(driver: string, options: { lockError?: Error } = {}) {
    const events: string[] = [];
    const txRepository = { manager: { connection: { options: { type: driver } } } };
    const manager = {
        query: jest.fn(async (_sql: string, params: [number, number]) => {
            if (options.lockError) throw options.lockError;
            events.push(`lock:${params[0]}:${params[1]}`);
        }),
        getRepository: jest.fn(() => txRepository),
    };
    const connection = {
        options: { type: driver },
        transaction: jest.fn(async (work: (m: typeof manager) => Promise<unknown>) => {
            events.push('begin');
            try {
                return await work(manager);
            } finally {
                events.push('commit');
            }
        }),
    };
    const repository = new MemoryFactRepository({ manager: { connection } } as never);
    const warn = jest
        .spyOn((repository as never as { logger: Record<string, () => void> }).logger, 'warn')
        .mockImplementation(() => undefined);
    return { repository, connection, manager, events, warn };
}

describe('MemoryFactRepository.withWorkspaceWriteLock', () => {
    it('on Postgres locks the workspace key and runs the write on the transaction', async () => {
        const { repository, manager, events } = build('postgres');

        let handed: MemoryFactRepository | null = null;
        const result = await repository.withWorkspaceWriteLock(USER, ORG, async (facts) => {
            handed = facts;
            events.push('critical-section');
            return 'written';
        });

        expect(result).toBe('written');
        expect(events).toEqual([
            'begin',
            `lock:${MEMORY_FACT_WRITE_LOCK_CLASS_ID}:${advisoryLockObjectId(
                memoryFactWriteLockKey(USER, ORG),
            )}`,
            'critical-section',
            'commit',
        ]);
        expect(manager.query).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock($1, $2)', [
            MEMORY_FACT_WRITE_LOCK_CLASS_ID,
            advisoryLockObjectId(memoryFactWriteLockKey(USER, ORG)),
        ]);
        // The critical section reads and writes through the transaction.
        expect(handed).toBeInstanceOf(MemoryFactRepository);
        expect(handed).not.toBe(repository);
    });

    it('keys the lock by owner AND workspace', () => {
        const key = memoryFactWriteLockKey(USER, ORG);
        expect(memoryFactWriteLockKey(USER, { ...ORG, organizationId: 'org-2' })).not.toBe(key);
        expect(memoryFactWriteLockKey('user-2', ORG)).not.toBe(key);
        expect(
            memoryFactWriteLockKey(USER, { tenantId: 'tenant-1', organizationId: null }),
        ).not.toBe(key);
        expect(memoryFactWriteLockKey(USER, ORG)).toBe(key);
    });

    it('uses a lock namespace no other subsystem uses', () => {
        expect([
            RUN_ADMISSION_LOCK_CLASS_ID,
            COMPUTER_NODE_ADMISSION_LOCK_CLASS_ID,
            COMPUTER_SCOPE_ADMISSION_LOCK_CLASS_ID,
            // Email send admission (agent, account).
            0x6577_0e01,
            0x6577_0e02,
        ]).not.toContain(MEMORY_FACT_WRITE_LOCK_CLASS_ID);
    });

    it('off Postgres opens no transaction and runs on the repository itself', async () => {
        const { repository, connection, manager } = build('better-sqlite3');

        const handed = await repository.withWorkspaceWriteLock(USER, ORG, async (facts) => facts);

        expect(handed).toBe(repository);
        expect(connection.transaction).not.toHaveBeenCalled();
        expect(manager.query).not.toHaveBeenCalled();
    });

    it('never overlaps two writes with the same key in process, and never blocks another key', async () => {
        const { repository } = build('better-sqlite3');
        const events: string[] = [];
        let releaseFirst: () => void = () => undefined;

        const first = repository.withWorkspaceWriteLock(USER, ORG, async () => {
            events.push('first:start');
            await new Promise<void>((resolve) => (releaseFirst = resolve));
            events.push('first:end');
        });
        const second = repository.withWorkspaceWriteLock(USER, ORG, async () => {
            events.push('second:start');
        });
        const other = repository.withWorkspaceWriteLock(
            USER,
            { ...ORG, organizationId: 'org-2' },
            async () => {
                events.push('other-workspace');
            },
        );

        await other;
        await new Promise((resolve) => setImmediate(resolve));
        expect(events).toEqual(['first:start', 'other-workspace']);

        releaseFirst();
        await Promise.all([first, second]);
        expect(events).toEqual(['first:start', 'other-workspace', 'first:end', 'second:start']);
    });

    it('releases the key when the critical section throws', async () => {
        const { repository } = build('better-sqlite3');

        await expect(
            repository.withWorkspaceWriteLock(USER, ORG, async () => {
                throw new Error('refused');
            }),
        ).rejects.toThrow('refused');

        await expect(
            repository.withWorkspaceWriteLock(USER, ORG, async () => 'next'),
        ).resolves.toBe('next');
    });

    it('writes unlocked (and says so) when the lock itself cannot be taken', async () => {
        const { repository, warn } = build('postgres', { lockError: new Error('pool gone') });
        const fn = jest.fn(async () => 'written');

        await expect(repository.withWorkspaceWriteLock(USER, ORG, fn)).resolves.toBe('written');

        expect(fn).toHaveBeenCalledTimes(1);
        expect(fn).toHaveBeenCalledWith(repository);
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it('re-raises a failure inside the critical section without running it again', async () => {
        const { repository, warn } = build('postgres');
        const fn = jest.fn(async () => {
            throw new Error('duplicate');
        });

        await expect(repository.withWorkspaceWriteLock(USER, ORG, fn)).rejects.toThrow('duplicate');

        expect(fn).toHaveBeenCalledTimes(1);
        expect(warn).not.toHaveBeenCalled();
    });
});
