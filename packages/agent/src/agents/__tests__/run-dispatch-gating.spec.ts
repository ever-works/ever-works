import {
    AgentRunRepository,
    RUN_ADMISSION_LOCK_CLASS_ID,
    advisoryLockObjectId,
} from '../../database/repositories/agent-run.repository';
import {
    QUEUED_REASON_CONCURRENCY,
    RunDispatchGateService,
    runAdmissionLockScope,
} from '../run-dispatch-gate.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Run orchestration — the admission CRITICAL SECTION and the advisory
 * lock behind it.
 *
 * `admit(input, reserve)` is what makes the concurrency valve hold: the
 * count and the `agent_runs` insert that consumes the counted slot run
 * as one unit, serialized per admission scope by `pg_advisory_xact_lock`
 * on Postgres and — documented, deliberate — unlocked everywhere else,
 * because better-sqlite3 (the whole e2e stack) has no advisory locks.
 * The CAS claim in `claimQueuedForDispatch` stays the correctness floor
 * on every driver.
 */
describe('RunDispatchGateService — admit + reserve critical section', () => {
    const ENV_KEYS = [
        'AGENT_MAX_CONCURRENT_RUNS_PER_WORK',
        'AGENT_MAX_CONCURRENT_RUNS_PER_ORG',
        'CREDITS_ENFORCEMENT',
    ] as const;
    const savedEnv: Record<string, string | undefined> = {};

    let runs: any;
    let dispatcher: any;
    let chatDispatcher: any;

    beforeEach(() => {
        for (const key of ENV_KEYS) {
            savedEnv[key] = process.env[key];
            delete process.env[key];
        }
        runs = {
            countInFlightForWork: jest.fn().mockResolvedValue(0),
            countInFlightForUser: jest.fn().mockResolvedValue(0),
            countInFlightForOrganization: jest.fn().mockResolvedValue(0),
            findOldestQueuedForConcurrency: jest.fn().mockResolvedValue(null),
            claimQueuedForDispatch: jest.fn().mockResolvedValue(true),
            restoreQueuedReason: jest.fn().mockResolvedValue(undefined),
            setTriggerRunId: jest.fn().mockResolvedValue(undefined),
            markDispatchFailed: jest.fn().mockResolvedValue(undefined),
            // Default: the real Postgres-or-nothing helper, stubbed as a
            // pass-through so the ordering assertions below stay readable.
            withAdmissionLock: jest.fn(async (_key: string, fn: () => Promise<unknown>) => fn()),
        };
        dispatcher = { enqueue: jest.fn().mockResolvedValue({ runId: 'trd-1' }) };
        chatDispatcher = { enqueue: jest.fn().mockResolvedValue({ runId: 'trd-chat-1' }) };
    });

    afterEach(() => {
        for (const key of ENV_KEYS) {
            if (savedEnv[key] === undefined) delete process.env[key];
            else process.env[key] = savedEnv[key];
        }
    });

    const makeGate = () => new RunDispatchGateService(runs, dispatcher, undefined, chatDispatcher);

    describe('reserve callback', () => {
        it('runs the reservation exactly once, with the ADMITTED verdict', async () => {
            const reserve = jest.fn().mockResolvedValue(undefined);
            const result = await makeGate().admit({ userId: 'u1', workId: 'w1' }, reserve);
            expect(result).toEqual({ admitted: true });
            expect(reserve).toHaveBeenCalledTimes(1);
            expect(reserve).toHaveBeenCalledWith({ admitted: true });
        });

        it('runs the reservation with the PARKED verdict when over the valve', async () => {
            runs.countInFlightForWork.mockResolvedValueOnce(10); // default limit 10
            const reserve = jest.fn().mockResolvedValue(undefined);
            const result = await makeGate().admit({ userId: 'u1', workId: 'w1' }, reserve);
            expect(result).toEqual({
                admitted: false,
                queuedReason: QUEUED_REASON_CONCURRENCY,
            });
            expect(reserve).toHaveBeenCalledTimes(1);
            expect(reserve).toHaveBeenCalledWith({
                admitted: false,
                queuedReason: QUEUED_REASON_CONCURRENCY,
            });
        });

        it('FAILS OPEN and still reserves when the counting query explodes', async () => {
            runs.countInFlightForWork.mockRejectedValueOnce(new Error('count query exploded'));
            const reserve = jest.fn().mockResolvedValue(undefined);
            const result = await makeGate().admit({ userId: 'u1', workId: 'w1' }, reserve);
            // A broken safety valve must never stop legitimate work, and
            // must never leave the caller with no run row either.
            expect(result).toEqual({ admitted: true });
            expect(reserve).toHaveBeenCalledTimes(1);
            expect(reserve).toHaveBeenCalledWith({ admitted: true });
        });

        it('propagates an error thrown BY the reservation (that one is real)', async () => {
            const reserve = jest.fn().mockRejectedValue(new Error('insert failed'));
            await expect(makeGate().admit({ userId: 'u1', workId: 'w1' }, reserve)).rejects.toThrow(
                'insert failed',
            );
        });

        it('counts BEFORE it reserves — the insert must not inflate its own count', async () => {
            const order: string[] = [];
            runs.countInFlightForWork.mockImplementation(async () => {
                order.push('count');
                return 0;
            });
            const reserve = jest.fn(async () => {
                order.push('reserve');
            });
            await makeGate().admit({ userId: 'u1', workId: 'w1' }, reserve);
            expect(order).toEqual(['count', 'reserve']);
        });

        it('holds the admission lock across BOTH the count and the reservation', async () => {
            const order: string[] = [];
            runs.withAdmissionLock.mockImplementation(
                async (_key: string, fn: () => Promise<unknown>) => {
                    order.push('lock-acquired');
                    const out = await fn();
                    order.push('lock-released');
                    return out;
                },
            );
            runs.countInFlightForWork.mockImplementation(async () => {
                order.push('count');
                return 0;
            });
            await makeGate().admit({ userId: 'u1', workId: 'w1' }, async () => {
                order.push('reserve');
            });
            expect(order).toEqual(['lock-acquired', 'count', 'reserve', 'lock-released']);
        });

        it('locks on the Work scope when the run has one', async () => {
            await makeGate().admit(
                { userId: 'u1', workId: 'w1', organizationId: 'o1' },
                async () => undefined,
            );
            expect(runs.withAdmissionLock).toHaveBeenCalledWith('work:w1', expect.any(Function));
        });

        it('falls back to the org, then the user, for Work-less runs', async () => {
            const gate = makeGate();
            await gate.admit({ userId: 'u1', organizationId: 'o1' }, async () => undefined);
            expect(runs.withAdmissionLock).toHaveBeenLastCalledWith('org:o1', expect.any(Function));
            await gate.admit({ userId: 'u1' }, async () => undefined);
            expect(runs.withAdmissionLock).toHaveBeenLastCalledWith(
                'user:u1',
                expect.any(Function),
            );
        });

        it('works against a repository stub that has no lock helper (unit tests, old drivers)', async () => {
            delete runs.withAdmissionLock;
            const reserve = jest.fn().mockResolvedValue(undefined);
            const result = await makeGate().admit({ userId: 'u1', workId: 'w1' }, reserve);
            expect(result).toEqual({ admitted: true });
            expect(reserve).toHaveBeenCalledTimes(1);
        });

        it('takes NO lock when the caller only wants a verdict (drain, probes)', async () => {
            const result = await makeGate().admit({ userId: 'u1', workId: 'w1' });
            expect(result).toEqual({ admitted: true });
            expect(runs.withAdmissionLock).not.toHaveBeenCalled();
        });
    });

    describe('runAdmissionLockScope', () => {
        it.each([
            [{ userId: 'u1', workId: 'w1', organizationId: 'o1' }, 'work:w1'],
            [{ userId: 'u1', workId: null, organizationId: 'o1' }, 'org:o1'],
            [{ userId: 'u1', workId: null, organizationId: null }, 'user:u1'],
            [{ userId: 'u1' }, 'user:u1'],
        ])('%j → %s', (input, expected) => {
            expect(runAdmissionLockScope(input as any)).toBe(expected);
        });
    });

    describe('drain — parked CHAT runs go back out on the chat path', () => {
        const parkedChatRun = (over: Record<string, unknown> = {}) => ({
            id: 'run-chat',
            agentId: 'agent-1',
            userId: 'user-1',
            taskId: 'task-1',
            chatMessageId: 'msg-1',
            triggerKind: 'chat',
            workId: 'work-1',
            organizationId: null,
            status: 'queued',
            queuedReason: QUEUED_REASON_CONCURRENCY,
            ...over,
        });

        it('re-dispatches through agent-chat-reply, carrying the triggering message', async () => {
            runs.findOldestQueuedForConcurrency.mockResolvedValueOnce(parkedChatRun());
            const result = await makeGate().drainForWork('work-1');
            expect(result).toEqual({ dispatched: true, runId: 'run-chat' });
            expect(chatDispatcher.enqueue).toHaveBeenCalledWith({
                agentId: 'agent-1',
                userId: 'user-1',
                taskId: 'task-1',
                triggeringMessageId: 'msg-1',
                dedupKey: 'task-1:agent-1:drain:run-chat',
                runId: 'run-chat',
            });
            // The task path must NOT be used — it would drop the message
            // the agent was mentioned in.
            expect(dispatcher.enqueue).not.toHaveBeenCalled();
        });

        it('still uses the TASK path for task-triggered parked runs', async () => {
            runs.findOldestQueuedForConcurrency.mockResolvedValueOnce(
                parkedChatRun({ triggerKind: 'task', chatMessageId: null }),
            );
            await makeGate().drainForWork('work-1');
            expect(dispatcher.enqueue).toHaveBeenCalledTimes(1);
            expect(chatDispatcher.enqueue).not.toHaveBeenCalled();
        });

        it('leaves a parked chat run alone when no chat dispatcher is bound', async () => {
            runs.findOldestQueuedForConcurrency.mockResolvedValueOnce(parkedChatRun());
            const gate = new RunDispatchGateService(runs, dispatcher, undefined, undefined);
            const result = await gate.drainForWork('work-1');
            expect(result).toEqual({ dispatched: false, reason: 'no-dispatcher' });
            // Never claimed ⇒ still parked ⇒ still drainable later.
            expect(runs.claimQueuedForDispatch).not.toHaveBeenCalled();
        });
    });
});

describe('AgentRunRepository.withAdmissionLock — pg advisory lock', () => {
    /**
     * The gate hands its whole critical section to this helper. On
     * Postgres it must open a transaction, take
     * `pg_advisory_xact_lock(classid, objid)` and only THEN run the
     * section (the lock is released by the transaction commit). On every
     * other driver it must be a straight pass-through — better-sqlite3
     * has no advisory locks at all, and pretending otherwise would throw
     * on every dispatch in the e2e stack.
     */
    const makeRepo = (driverType: string, transaction?: jest.Mock) => {
        const repository = {
            manager: {
                connection: {
                    options: { type: driverType },
                    transaction:
                        transaction ??
                        jest.fn(async (cb: (m: unknown) => Promise<unknown>) =>
                            cb({ query: jest.fn().mockResolvedValue(undefined) }),
                        ),
                },
            },
        };
        return {
            repo: new AgentRunRepository(repository as any),
            repository,
        };
    };

    it('POSTGRES: opens a transaction, takes the advisory lock, then runs the section', async () => {
        const query = jest.fn().mockResolvedValue(undefined);
        const transaction = jest.fn(async (cb: (m: unknown) => Promise<unknown>) => cb({ query }));
        const { repo } = makeRepo('postgres', transaction);

        const order: string[] = [];
        query.mockImplementation(async () => {
            order.push('lock');
        });
        const result = await repo.withAdmissionLock('work:w1', async () => {
            order.push('section');
            return 'done';
        });

        expect(result).toBe('done');
        expect(transaction).toHaveBeenCalledTimes(1);
        expect(query).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock($1, $2)', [
            RUN_ADMISSION_LOCK_CLASS_ID,
            advisoryLockObjectId('work:w1'),
        ]);
        expect(order).toEqual(['lock', 'section']);
    });

    it('SQLITE: documented no-op — runs the section directly, no transaction', async () => {
        const transaction = jest.fn();
        const { repo } = makeRepo('better-sqlite3', transaction);
        const section = jest.fn().mockResolvedValue('done');
        await expect(repo.withAdmissionLock('work:w1', section)).resolves.toBe('done');
        expect(transaction).not.toHaveBeenCalled();
        expect(section).toHaveBeenCalledTimes(1);
    });

    it('degrades to UNLOCKED when the lock itself cannot be taken', async () => {
        const transaction = jest.fn(async () => {
            throw new Error('no connections available');
        });
        const { repo } = makeRepo('postgres', transaction);
        const section = jest.fn().mockResolvedValue('done');
        // A broken safety valve must never stop legitimate work.
        await expect(repo.withAdmissionLock('work:w1', section)).resolves.toBe('done');
        expect(section).toHaveBeenCalledTimes(1);
    });

    it('re-raises an error thrown by the SECTION (never re-runs it)', async () => {
        const query = jest.fn().mockResolvedValue(undefined);
        const transaction = jest.fn(async (cb: (m: unknown) => Promise<unknown>) => cb({ query }));
        const { repo } = makeRepo('postgres', transaction);
        const section = jest.fn().mockRejectedValue(new Error('insert failed'));
        await expect(repo.withAdmissionLock('work:w1', section)).rejects.toThrow('insert failed');
        // Re-running would double-create the run row it reserves.
        expect(section).toHaveBeenCalledTimes(1);
    });

    it('derives a STABLE int4 lock id per scope, distinct across scopes', () => {
        const a = advisoryLockObjectId('work:w1');
        const b = advisoryLockObjectId('work:w2');
        expect(a).toBe(advisoryLockObjectId('work:w1'));
        expect(a).not.toBe(b);
        for (const id of [a, b, advisoryLockObjectId('user:u1'), advisoryLockObjectId('')]) {
            expect(Number.isInteger(id)).toBe(true);
            expect(id).toBeGreaterThanOrEqual(-(2 ** 31));
            expect(id).toBeLessThanOrEqual(2 ** 31 - 1);
        }
    });
});
