import { advisoryLockObjectId } from '../../database/repositories/agent-run.repository';
import {
    COMPUTER_NODE_ADMISSION_LOCK_CLASS_ID,
    COMPUTER_SCOPE_ADMISSION_LOCK_CLASS_ID,
    ComputerSessionRepository,
    computerSessionScopeKey,
} from '../computer-session.repository';

/**
 * The live-view admission lock. Pinned: on Postgres the machine key is
 * taken before the scope key, both inside ONE transaction that is held
 * for the whole critical section; off Postgres it is a documented no-op;
 * a lock that cannot be taken never stops a view, and a critical section
 * that already ran is never run twice.
 */

const NODE = '33333333-3333-4333-8333-333333333333';

function build(driver: string, options: { lockError?: Error } = {}) {
    const events: string[] = [];
    const manager = {
        query: jest.fn(async (_sql: string, params: [number, number]) => {
            if (options.lockError) throw options.lockError;
            events.push(`lock:${params[0]}:${params[1]}`);
        }),
    };
    const connection = {
        options: { type: driver },
        transaction: jest.fn(async (work: (m: typeof manager) => Promise<unknown>) => {
            events.push('begin');
            try {
                return await work(manager);
            } finally {
                events.push('release');
            }
        }),
    };
    const repository = new ComputerSessionRepository({ manager: { connection } } as never);
    jest.spyOn(
        (repository as never as { logger: Record<string, () => void> }).logger,
        'warn',
    ).mockImplementation(() => undefined);
    return { repository, connection, manager, events };
}

describe('ComputerSessionRepository.withAdmissionLock', () => {
    it('on Postgres takes the machine lock, then the scope lock, and holds both across the critical section', async () => {
        const { repository, events } = build('postgres');

        const result = await repository.withAdmissionLock(
            { nodeId: NODE, scopeKey: 'org:org-1' },
            async () => {
                events.push('critical-section');
                return 'admitted';
            },
        );

        expect(result).toBe('admitted');
        expect(events).toEqual([
            'begin',
            `lock:${COMPUTER_NODE_ADMISSION_LOCK_CLASS_ID}:${advisoryLockObjectId(`node:${NODE}`)}`,
            `lock:${COMPUTER_SCOPE_ADMISSION_LOCK_CLASS_ID}:${advisoryLockObjectId('scope:org:org-1')}`,
            'critical-section',
            'release',
        ]);
    });

    it('takes only the machine lock when no scope is read', async () => {
        const { repository, manager } = build('postgres');
        await repository.withAdmissionLock({ nodeId: NODE }, async () => undefined);
        expect(manager.query).toHaveBeenCalledTimes(1);
        expect(manager.query.mock.calls[0][1]).toEqual([
            COMPUTER_NODE_ADMISSION_LOCK_CLASS_ID,
            advisoryLockObjectId(`node:${NODE}`),
        ]);
    });

    it('uses its own namespaces, apart from each other and from run admission', () => {
        expect(COMPUTER_NODE_ADMISSION_LOCK_CLASS_ID).not.toBe(
            COMPUTER_SCOPE_ADMISSION_LOCK_CLASS_ID,
        );
        expect([
            COMPUTER_NODE_ADMISSION_LOCK_CLASS_ID,
            COMPUTER_SCOPE_ADMISSION_LOCK_CLASS_ID,
        ]).not.toContain(0x6577_0001);
    });

    it('is a no-op off Postgres', async () => {
        const { repository, connection } = build('better-sqlite3');
        await expect(
            repository.withAdmissionLock({ nodeId: NODE, scopeKey: 'user:u' }, async () => 7),
        ).resolves.toBe(7);
        expect(connection.transaction).not.toHaveBeenCalled();
    });

    it('admits unlocked when the lock cannot be taken, running the critical section once', async () => {
        const { repository } = build('postgres', { lockError: new Error('pool exhausted') });
        const fn = jest.fn(async () => 'admitted');
        await expect(repository.withAdmissionLock({ nodeId: NODE }, fn)).resolves.toBe('admitted');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('re-raises a failure inside the critical section and never re-runs it', async () => {
        const { repository } = build('postgres');
        const fn = jest.fn(async () => {
            throw new Error('insert failed');
        });
        await expect(repository.withAdmissionLock({ nodeId: NODE }, fn)).rejects.toThrow(
            'insert failed',
        );
        expect(fn).toHaveBeenCalledTimes(1);
    });
});

describe('computerSessionScopeKey', () => {
    it('is the Organization, else the owner’s personal workspace', () => {
        expect(computerSessionScopeKey({ userId: 'u1', organizationId: 'o1' })).toBe('org:o1');
        expect(computerSessionScopeKey({ userId: 'u1', organizationId: null })).toBe('user:u1');
    });
});
