import { advisoryLockObjectId } from './agent-run.repository';
import {
    EMAIL_SEND_ACCOUNT_ADMISSION_LOCK_CLASS_ID,
    EMAIL_SEND_AGENT_ADMISSION_LOCK_CLASS_ID,
} from './email-message.repository';
import {
    MODEL_ACCOUNT_WRITE_LOCK_CLASS_ID,
    ModelAccountRepository,
    modelAccountWriteLockKey,
} from './model-account.repository';

/**
 * Model accounts (AW-16) — writes to a workspace's accounts for one provider
 * serialize on an advisory lock keyed by workspace and provider, taken before
 * the row lock and inside the same transaction as the count and the insert.
 * The row lock alone cannot cover the first add (no rows yet); the advisory
 * lock can. Off Postgres both are a documented no-op.
 */

function build(driver: string, options: { lockError?: Error } = {}) {
    const events: string[] = [];
    const queryBuilder = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        setLock: jest.fn().mockReturnThis(),
        getMany: jest.fn(async () => {
            events.push('row-lock');
            return [];
        }),
    };
    const tx = { createQueryBuilder: jest.fn(() => queryBuilder) };
    const manager = {
        connection: { options: { type: driver } },
        query: jest.fn(async (sql: string, params: [number, number]) => {
            if (options.lockError) throw options.lockError;
            events.push(`${sql}|${params[0]}|${params[1]}`);
        }),
        getRepository: jest.fn(() => tx),
    };
    const transaction = jest.fn(async (work: (m: typeof manager) => Promise<unknown>) => {
        events.push('begin');
        try {
            return await work(manager);
        } finally {
            events.push('commit');
        }
    });
    const repository = new ModelAccountRepository({ manager: { transaction } } as never);
    return { repository, manager, queryBuilder, transaction, events };
}

describe('ModelAccountRepository.inTransaction — write lock', () => {
    it('on Postgres takes the workspace+provider advisory lock first, then the row lock, then runs the write in the same transaction', async () => {
        const { repository, events, queryBuilder } = build('postgres');

        const result = await repository.inTransaction('org:org-1', 'openrouter', async () => {
            events.push('count-and-insert');
            return 'added';
        });

        expect(result).toBe('added');
        expect(events).toEqual([
            'begin',
            `SELECT pg_advisory_xact_lock($1, $2)|${MODEL_ACCOUNT_WRITE_LOCK_CLASS_ID}|${advisoryLockObjectId(
                'model-accounts:org:org-1:openrouter',
            )}`,
            'row-lock',
            'count-and-insert',
            'commit',
        ]);
        expect(queryBuilder.setLock).toHaveBeenCalledWith('pessimistic_write');
    });

    it('takes the lock even when the provider has no rows yet (the first add)', async () => {
        const { repository, manager, queryBuilder } = build('postgres');
        queryBuilder.getMany.mockResolvedValue([]);

        await repository.inTransaction('user:user-1', 'anthropic', async () => undefined);

        expect(manager.query).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock($1, $2)', [
            MODEL_ACCOUNT_WRITE_LOCK_CLASS_ID,
            advisoryLockObjectId(modelAccountWriteLockKey('user:user-1', 'anthropic')),
        ]);
    });

    it('keys on workspace AND provider: two providers, or two workspaces, never share a key', () => {
        const keys = new Set([
            modelAccountWriteLockKey('org:org-1', 'openrouter'),
            modelAccountWriteLockKey('org:org-1', 'anthropic'),
            modelAccountWriteLockKey('org:org-2', 'openrouter'),
            modelAccountWriteLockKey('user:user-1', 'openrouter'),
            modelAccountWriteLockKey('org:org-1', null),
        ]);
        expect(keys.size).toBe(5);
        expect(modelAccountWriteLockKey('org:org-1', 'openrouter')).toBe(
            modelAccountWriteLockKey('org:org-1', 'openrouter'),
        );
    });

    it('uses its own namespace, apart from run, live-view and send admission', () => {
        expect([
            0x6577_0001,
            0x6577_000b,
            0x6577_000c,
            EMAIL_SEND_AGENT_ADMISSION_LOCK_CLASS_ID,
            EMAIL_SEND_ACCOUNT_ADMISSION_LOCK_CLASS_ID,
        ]).not.toContain(MODEL_ACCOUNT_WRITE_LOCK_CLASS_ID);
    });

    it('is a documented no-op off Postgres: no advisory lock, no row lock, same transaction', async () => {
        const { repository, manager, queryBuilder, transaction } = build('better-sqlite3');

        await expect(
            repository.inTransaction('org:org-1', 'openrouter', async () => 7),
        ).resolves.toBe(7);

        expect(transaction).toHaveBeenCalledTimes(1);
        expect(manager.query).not.toHaveBeenCalled();
        expect(queryBuilder.getMany).not.toHaveBeenCalled();
    });

    it('fails the write, with nothing run, when the lock cannot be taken', async () => {
        const { repository } = build('postgres', { lockError: new Error('lock timeout') });
        const work = jest.fn(async () => 'added');

        await expect(repository.inTransaction('org:org-1', 'openrouter', work)).rejects.toThrow(
            'lock timeout',
        );
        expect(work).not.toHaveBeenCalled();
    });
});
