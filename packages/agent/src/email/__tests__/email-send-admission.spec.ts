import { FindOperator } from 'typeorm';
import { advisoryLockObjectId } from '../../database/repositories/agent-run.repository';
import {
    EMAIL_SEND_ACCOUNT_ADMISSION_LOCK_CLASS_ID,
    EMAIL_SEND_AGENT_ADMISSION_LOCK_CLASS_ID,
    EmailMessageRepository,
} from '../../database/repositories/email-message.repository';
import { EmailMessage } from '../../entities/email-message.entity';
import { EmailFacadeService } from '../../facades/email.facade';
import { EmailSendCapExceededException } from '../email-send-cap-exceeded.exception';
import { EmailSendPolicyService } from '../email-send-policy.service';

/**
 * Agent email (AW-05) — send caps are HARD stops, so the count and the
 * reservation of capacity must be serialized. Two layers are pinned here:
 *
 * 1. `EmailMessageRepository.withSendAdmissionLock` — on Postgres the Agent
 *    key then the account key, in ONE transaction held across the critical
 *    section, which runs on that transaction's repository; a no-op off
 *    Postgres; a lock that cannot be taken never stops mail; a critical
 *    section that ran is never run twice.
 * 2. A burst through the real facade → policy gate → repository, over an
 *    in-memory table and a fake connection whose `pg_advisory_xact_lock`
 *    is a real keyed mutex released at transaction end: exactly `cap`
 *    sends go out, the rest get the structured 429 — and the same burst
 *    with the lock replaced by a pass-through overshoots, which is what
 *    makes the first assertion meaningful.
 */

const AGENT = 'agent-1';
const USER = 'user-1';

function buildLockHarness(driver: string, options: { lockError?: Error } = {}) {
    const events: string[] = [];
    const scopedRepository = { scoped: true };
    const manager = {
        query: jest.fn(async (_sql: string, params: [number, number]) => {
            if (options.lockError) throw options.lockError;
            events.push(`lock:${params[0]}:${params[1]}`);
        }),
        getRepository: jest.fn(() => scopedRepository),
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
    const repository = new EmailMessageRepository({ manager: { connection } } as never);
    jest.spyOn(
        (repository as never as { logger: Record<string, () => void> }).logger,
        'warn',
    ).mockImplementation(() => undefined);
    return { repository, connection, manager, events, scopedRepository };
}

describe('EmailMessageRepository.withSendAdmissionLock', () => {
    it('on Postgres takes the Agent key, then the account key, and holds both across the section', async () => {
        const { repository, events, manager } = buildLockHarness('postgres');

        const result = await repository.withSendAdmissionLock(
            { agentId: AGENT, userId: USER },
            async (messages) => {
                events.push('count-and-reserve');
                expect(messages).toBeInstanceOf(EmailMessageRepository);
                expect(messages).not.toBe(repository);
                return 'admitted';
            },
        );

        expect(result).toBe('admitted');
        expect(events).toEqual([
            'begin',
            `lock:${EMAIL_SEND_AGENT_ADMISSION_LOCK_CLASS_ID}:${advisoryLockObjectId(`agent:${AGENT}`)}`,
            `lock:${EMAIL_SEND_ACCOUNT_ADMISSION_LOCK_CLASS_ID}:${advisoryLockObjectId(`user:${USER}`)}`,
            'count-and-reserve',
            'release',
        ]);
        // The section's reads and its reservation run in the locked transaction.
        expect(manager.getRepository).toHaveBeenCalledWith(EmailMessage);
    });

    it('takes only the keys whose windows the send counts', async () => {
        const agentOnly = buildLockHarness('postgres');
        await agentOnly.repository.withSendAdmissionLock(
            { agentId: AGENT, userId: null },
            async () => undefined,
        );
        expect(agentOnly.manager.query).toHaveBeenCalledTimes(1);
        expect(agentOnly.manager.query.mock.calls[0][1]).toEqual([
            EMAIL_SEND_AGENT_ADMISSION_LOCK_CLASS_ID,
            advisoryLockObjectId(`agent:${AGENT}`),
        ]);

        const accountOnly = buildLockHarness('postgres');
        await accountOnly.repository.withSendAdmissionLock({ userId: USER }, async () => undefined);
        expect(accountOnly.manager.query.mock.calls.map((call) => call[1])).toEqual([
            [EMAIL_SEND_ACCOUNT_ADMISSION_LOCK_CLASS_ID, advisoryLockObjectId(`user:${USER}`)],
        ]);

        const none = buildLockHarness('postgres');
        await expect(none.repository.withSendAdmissionLock({}, async () => 3)).resolves.toBe(3);
        expect(none.connection.transaction).not.toHaveBeenCalled();
    });

    it('uses its own namespaces, apart from each other, run admission and live-view admission', () => {
        expect(EMAIL_SEND_AGENT_ADMISSION_LOCK_CLASS_ID).not.toBe(
            EMAIL_SEND_ACCOUNT_ADMISSION_LOCK_CLASS_ID,
        );
        for (const other of [0x6577_0001, 0x6577_000b, 0x6577_000c]) {
            expect([
                EMAIL_SEND_AGENT_ADMISSION_LOCK_CLASS_ID,
                EMAIL_SEND_ACCOUNT_ADMISSION_LOCK_CLASS_ID,
            ]).not.toContain(other);
        }
    });

    it('is a no-op off Postgres and runs the section on this repository', async () => {
        const { repository, connection } = buildLockHarness('better-sqlite3');
        await expect(
            repository.withSendAdmissionLock({ agentId: AGENT, userId: USER }, async (messages) => {
                expect(messages).toBe(repository);
                return 7;
            }),
        ).resolves.toBe(7);
        expect(connection.transaction).not.toHaveBeenCalled();
    });

    it('admits unlocked when the lock cannot be taken, running the section once', async () => {
        const { repository } = buildLockHarness('postgres', {
            lockError: new Error('pool exhausted'),
        });
        const fn = jest.fn(async () => 'admitted');
        await expect(repository.withSendAdmissionLock({ agentId: AGENT }, fn)).resolves.toBe(
            'admitted',
        );
        expect(fn).toHaveBeenCalledTimes(1);
        expect(fn).toHaveBeenCalledWith(repository);
    });

    it('re-raises a failure inside the section and never re-runs it', async () => {
        const { repository } = buildLockHarness('postgres');
        const fn = jest.fn(async () => {
            throw new Error('insert failed');
        });
        await expect(repository.withSendAdmissionLock({ agentId: AGENT }, fn)).rejects.toThrow(
            'insert failed',
        );
        expect(fn).toHaveBeenCalledTimes(1);
    });
});

// ── The burst ────────────────────────────────────────────────────────────

type Row = Record<string, any>;

/** Yield to the macrotask queue, so concurrent sends genuinely interleave. */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function matches(row: Row, where: Row): boolean {
    for (const [key, condition] of Object.entries(where)) {
        const value = row[key];
        if (condition instanceof FindOperator) {
            if (condition.type === 'moreThanOrEqual') {
                if (value === null || value === undefined) return false;
                if (new Date(value).getTime() < new Date(condition.value as Date).getTime()) {
                    return false;
                }
            } else if (condition.type === 'in') {
                if (!(condition.value as unknown[]).includes(value)) return false;
            } else {
                throw new Error(`unsupported operator ${condition.type}`);
            }
        } else if (value !== condition) {
            return false;
        }
    }
    return true;
}

/**
 * An in-memory `email_messages` table behind a TypeORM-shaped repository,
 * and a Postgres-typed connection whose advisory lock is a keyed mutex held
 * until the transaction that took it ends.
 */
function makeDatabase() {
    const rows: Row[] = [];
    let seq = 0;
    const held = new Map<string, Promise<void>>();

    const table = {
        count: async ({ where }: { where: Row }) => {
            await tick();
            return rows.filter((row) => matches(row, where)).length;
        },
        find: async ({ where, order, take }: { where: Row; order?: Row; take?: number }) => {
            await tick();
            let found = rows.filter((row) => matches(row, where));
            if (order?.sentAt) {
                const direction = order.sentAt === 'ASC' ? 1 : -1;
                found = [...found].sort(
                    (a, b) => direction * (a.sentAt.getTime() - b.sentAt.getTime()),
                );
            }
            return found.slice(0, take ?? found.length).map((row) => ({ ...row }));
        },
        findOne: async ({ where }: { where: Row }) => {
            await tick();
            const row = rows.find((candidate) => matches(candidate, where));
            return row ? { ...row } : null;
        },
        save: async (entry: Row) => {
            await tick();
            const row = { id: `m-${++seq}`, createdAt: new Date(), ...entry };
            rows.push(row);
            return { ...row };
        },
        update: async (criteria: Row, patch: Row) => {
            await tick();
            let affected = 0;
            for (const row of rows) {
                if (matches(row, criteria)) {
                    Object.assign(row, patch);
                    affected += 1;
                }
            }
            return { affected };
        },
        manager: {} as Row,
    };

    const connection = {
        options: { type: 'postgres' },
        transaction: async (work: (manager: Row) => Promise<unknown>) => {
            const releases: Array<() => void> = [];
            const manager = {
                query: async (sql: string, params: [number, number]) => {
                    expect(sql).toBe('SELECT pg_advisory_xact_lock($1, $2)');
                    const key = `${params[0]}:${params[1]}`;
                    while (held.has(key)) {
                        await held.get(key);
                    }
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
                getRepository: () => table,
            };
            try {
                return await work(manager);
            } finally {
                // Commit: every advisory lock this transaction took is released.
                for (const release of releases.reverse()) release();
            }
        },
    };
    table.manager = { connection };

    return { rows, messages: new EmailMessageRepository(table as never) };
}

const CAP_ENV_KEYS = [
    'EMAIL_SEND_CAPS_ENFORCEMENT',
    'EMAIL_SEND_CAP_INBOX_DAILY',
    'EMAIL_SEND_CAP_INBOX_PER_MINUTE',
    'EMAIL_SEND_CAP_INBOX_RECIPIENTS_PER_5_MINUTES',
    'EMAIL_SEND_CAP_RECIPIENTS_PER_MESSAGE',
    'EMAIL_SEND_CAP_WORKSPACE_DAILY',
    'EMAIL_SEND_CAP_WORKSPACE_MONTHLY',
    'EMAIL_DEFAULT_AGENT_SEND_MODE',
];

/** `dailySendCap: null` = the Agent has no settings row at all. */
function buildSendPath(dailySendCap: number | null) {
    const { rows, messages } = makeDatabase();
    const inboxes = {
        findByAgentForUser: jest.fn(async () =>
            dailySendCap === null
                ? null
                : {
                      id: 'inbox-1',
                      agentId: AGENT,
                      userId: USER,
                      mode: 'auto-send',
                      dailySendCap,
                  },
        ),
        setCapPausedUntil: jest.fn(async () => undefined),
    };
    const agents = {
        findOne: jest.fn(async () => ({ id: AGENT, userId: USER, organizationId: null })),
    };
    const organizations = { findOne: jest.fn(async () => null) };
    const proposals = { findOne: jest.fn(async () => null) };
    const policy = new EmailSendPolicyService(
        inboxes as never,
        messages,
        agents as never,
        organizations as never,
        proposals as never,
    );

    let providerSeq = 0;
    const plugin = {
        id: 'postmark',
        name: 'Postmark',
        version: '1.0.0',
        category: 'email',
        capabilities: ['email-outbound'],
        sendEmail: jest.fn(async () => {
            await tick();
            return {
                provider: 'postmark',
                providerMessageId: `pm-${++providerSeq}`,
                accepted: ['ada@example.com'],
                rejected: [],
            };
        }),
        verifyAddress: jest.fn(),
    };
    const registry = {
        getByCapability: jest.fn().mockReturnValue([{ plugin, state: 'loaded' }]),
        get: jest.fn().mockReturnValue({ plugin, state: 'loaded' }),
    };
    const settings = {
        getResolvedSettings: jest.fn().mockResolvedValue({}),
        getSettings: jest.fn().mockResolvedValue({}),
    };
    const facade = new EmailFacadeService(
        registry as never,
        settings as never,
        undefined,
        undefined,
        undefined,
        messages,
        undefined,
        policy,
    );
    jest.spyOn(
        facade as unknown as { resolveOutboundPlugin: () => unknown },
        'resolveOutboundPlugin',
    ).mockResolvedValue(plugin as never);

    const burst = (width: number) =>
        Promise.allSettled(
            Array.from({ length: width }, (_, i) =>
                facade.send(
                    {
                        from: 'nova@agents.example.com',
                        to: ['ada@example.com'],
                        subject: `Update ${i}`,
                        bodyText: 'Hello.',
                        messageRef: `burst-${i}`,
                    },
                    { userId: USER, agentId: AGENT, addressId: 'addr-1', origin: 'agent' },
                ),
            ),
        );

    return { rows, messages, plugin, burst };
}

describe('send caps under a concurrent burst (AW-05)', () => {
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
        for (const key of CAP_ENV_KEYS) {
            saved[key] = process.env[key];
            delete process.env[key];
        }
    });

    afterEach(() => {
        for (const key of CAP_ENV_KEYS) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
        jest.restoreAllMocks();
    });

    it('admits exactly the cap: cap 2, 5 concurrent sends → 2 sent, 3 refused with the structured 429', async () => {
        const { rows, plugin, burst } = buildSendPath(2);

        const outcomes = await burst(5);

        const sent = outcomes.filter((outcome) => outcome.status === 'fulfilled');
        const refused = outcomes.filter(
            (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
        );
        expect(sent).toHaveLength(2);
        expect(refused).toHaveLength(3);
        for (const { reason } of refused) {
            expect(reason).toBeInstanceOf(EmailSendCapExceededException);
            expect(reason.getStatus()).toBe(429);
            expect(reason.getResponse()).toMatchObject({
                error: 'EmailSendCapExceeded',
                details: {
                    scope: 'inbox',
                    limitKind: 'inboxDaily',
                    used: 2,
                    cap: 2,
                    windowSeconds: 86_400,
                    agentId: AGENT,
                },
            });
        }
        // The provider was reached exactly twice, and the table agrees.
        expect(plugin.sendEmail).toHaveBeenCalledTimes(2);
        expect(rows.filter((row) => row.status === 'sent' && row.sentAt)).toHaveLength(2);
        // Every reservation was settled: nothing is left holding capacity.
        expect(rows.filter((row) => row.status === 'sending')).toHaveLength(0);
        expect(rows).toHaveLength(2);
    });

    it('frees the capacity of a reservation whose provider send fails', async () => {
        const { rows, plugin, burst } = buildSendPath(2);
        plugin.sendEmail.mockRejectedValueOnce(new Error('provider 503'));

        const outcomes = await burst(5);

        // One admitted send failed at the provider, so its slot went to the
        // next waiter: still exactly 2 sent.
        expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(2);
        const failed = rows.filter((row) => row.status === 'failed');
        expect(failed).toHaveLength(1);
        expect(failed[0]).toMatchObject({ sentAt: null, failureReason: 'provider 503' });
        expect(rows.filter((row) => row.status === 'sent')).toHaveLength(2);
    });

    it('CONTROL: the same burst with the lock replaced by a pass-through overshoots the cap', async () => {
        const { messages, plugin, burst } = buildSendPath(2);
        jest.spyOn(messages, 'withSendAdmissionLock').mockImplementation(async (_keys, fn) =>
            fn(messages),
        );

        const outcomes = await burst(5);

        // Every count ran before any reservation landed — the race the lock
        // exists to close. If this ever stops overshooting, the burst test
        // above no longer proves anything and must be made harder.
        expect(outcomes.filter((outcome) => outcome.status === 'fulfilled').length).toBeGreaterThan(
            2,
        );
        expect(plugin.sendEmail.mock.calls.length).toBeGreaterThan(2);
    });

    it('leaves an unconfigured Agent unlimited: no lock, no reservation, every send recorded after the provider', async () => {
        // No settings row, no organization policy, no operator env.
        const { messages, rows, plugin, burst } = buildSendPath(null);
        const lock = jest.spyOn(messages, 'withSendAdmissionLock');

        const outcomes = await burst(5);

        expect(outcomes.every((outcome) => outcome.status === 'fulfilled')).toBe(true);
        expect(plugin.sendEmail).toHaveBeenCalledTimes(5);
        expect(lock).not.toHaveBeenCalled();
        expect(rows).toHaveLength(5);
        expect(rows.every((row) => row.status === 'sent' && row.sentAt)).toBe(true);
    });
});
