import { advisoryLockObjectId } from './agent-run.repository';
import {
    EMAIL_SEND_ACCOUNT_ADMISSION_LOCK_CLASS_ID,
    EMAIL_SEND_AGENT_ADMISSION_LOCK_CLASS_ID,
} from './email-message.repository';
import {
    MODEL_ACCOUNT_WRITE_LOCK_CLASS_ID,
    ModelAccountRepository,
    modelAccountWriteLockKey,
    modelAccountWriteLockKeys,
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

describe('ModelAccountRepository.inTransaction — workspace lock for adds', () => {
    const lockSql = (key: string) =>
        `SELECT pg_advisory_xact_lock($1, $2)|${MODEL_ACCOUNT_WRITE_LOCK_CLASS_ID}|${advisoryLockObjectId(key)}`;

    it('takes the workspace key, then the provider key, then the row lock — in the same transaction', async () => {
        const { repository, events } = build('postgres');

        await repository.inTransaction(
            'org:org-1',
            'openrouter',
            async () => {
                events.push('count-and-insert');
            },
            { lockWorkspace: true },
        );

        expect(events).toEqual([
            'begin',
            lockSql('model-accounts:org:org-1'),
            lockSql('model-accounts:org:org-1:openrouter'),
            'row-lock',
            'count-and-insert',
            'commit',
        ]);
    });

    it('keeps one lock order for every write: the workspace key is never taken after a provider key', () => {
        const workspace = modelAccountWriteLockKey('org:org-1', null);
        const provider = modelAccountWriteLockKey('org:org-1', 'openrouter');
        expect(
            modelAccountWriteLockKeys('org:org-1', 'openrouter', { lockWorkspace: true }),
        ).toEqual([workspace, provider]);
        // Reorder, remove, rename and reconnect stay per provider.
        expect(modelAccountWriteLockKeys('org:org-1', 'openrouter')).toEqual([provider]);
        // A write about no one provider takes the workspace key alone, once.
        expect(modelAccountWriteLockKeys('org:org-1', null, { lockWorkspace: true })).toEqual([
            workspace,
        ]);
    });

    it('stays a no-op off Postgres with the workspace lock requested', async () => {
        const { repository, manager } = build('better-sqlite3');
        await repository.inTransaction('org:org-1', 'openrouter', async () => undefined, {
            lockWorkspace: true,
        });
        expect(manager.query).not.toHaveBeenCalled();
    });

    /**
     * Two concurrent adds for DIFFERENT providers against a workspace one
     * account short of its limit. Advisory locks are emulated with the
     * semantics Postgres gives `pg_advisory_xact_lock`: a key is held from the
     * call until the holder's transaction ends, and a second caller waits.
     */
    function concurrentStack(limit: number, stored: number) {
        const held = new Map<string, Promise<void>>();
        const state = { stored, inserted: 0 };
        const transaction = jest.fn(async (work: (m: unknown) => Promise<unknown>) => {
            const releases: Array<() => void> = [];
            const manager = {
                connection: { options: { type: 'postgres' } },
                query: async (_sql: string, params: [number, number]) => {
                    const key = String(params[1]);
                    while (held.has(key)) await held.get(key);
                    let release!: () => void;
                    held.set(
                        key,
                        new Promise<void>((resolve) => {
                            release = () => {
                                held.delete(key);
                                resolve();
                            };
                        }),
                    );
                    releases.push(release);
                },
                getRepository: () => ({
                    createQueryBuilder: () => {
                        const qb = {
                            select: () => qb,
                            where: () => qb,
                            andWhere: () => qb,
                            setLock: () => qb,
                            getMany: async () => [],
                        };
                        return qb;
                    },
                }),
            };
            try {
                return await work(manager);
            } finally {
                releases.reverse().forEach((release) => release());
            }
        });
        const repository = new ModelAccountRepository({ manager: { transaction } } as never);
        const add = (provider: string, options?: { lockWorkspace?: boolean }) =>
            repository.inTransaction(
                'org:org-1',
                provider,
                async () => {
                    const count = state.stored;
                    // Yield between the count and the insert, as a real round trip does.
                    await new Promise((resolve) => setImmediate(resolve));
                    if (count >= limit) return 'limit_reached';
                    state.stored += 1;
                    state.inserted += 1;
                    return 'added';
                },
                options,
            );
        return { add, state };
    }

    it('lets only one of two concurrent adds for different providers take the last workspace slot', async () => {
        const { add, state } = concurrentStack(32, 31);

        const results = await Promise.all([
            add('openrouter', { lockWorkspace: true }),
            add('anthropic', { lockWorkspace: true }),
        ]);

        expect(results.sort()).toEqual(['added', 'limit_reached']);
        expect(state.stored).toBe(32);
        expect(state.inserted).toBe(1);
    });

    it('(control) per-provider keys alone do not serialize adds for different providers', async () => {
        const { add, state } = concurrentStack(32, 31);

        await Promise.all([add('openrouter'), add('anthropic')]);

        expect(state.stored).toBe(33);
    });
});

describe('ModelAccountRepository.listDueForCheck', () => {
    it('orders never-checked accounts first, explicitly, so Postgres cannot sort them last', async () => {
        const find = jest.fn().mockResolvedValue([]);
        const repository = new ModelAccountRepository({ find } as never);
        const cutoff = new Date('2026-09-14T06:00:00.000Z');

        await repository.listDueForCheck(cutoff, 50);

        expect(find).toHaveBeenCalledWith(
            expect.objectContaining({
                order: { lastCheckedAt: { direction: 'ASC', nulls: 'FIRST' } },
                take: 50,
            }),
        );
    });
});
