import { DataSource } from 'typeorm';
import { AgentRun } from '@src/entities/agent-run.entity';
import { ENTITIES } from '../_entities-inventory';
import { AgentRunRepository } from './agent-run.repository';

/**
 * AW-23 — the AGENT-keyed parked-run reads behind "nothing is lost".
 *
 * The Work-keyed drain cannot see this work at all: a chat reply held for
 * a paused agent may carry no Work, and two agents on the same Work must
 * not drain each other's held runs. These are the three properties a
 * Resume depends on — oldest-first order, the exact park reason, and
 * cross-agent isolation — pinned against a real database rather than a
 * query-builder mock, because "oldest first" is a claim about SQL.
 */
describe('AgentRunRepository — runs held for one agent (AW-23)', () => {
    let dataSource: DataSource;
    let runs: AgentRunRepository;

    const USER = '11111111-1111-4111-8111-111111111111';
    const AGENT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const AGENT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const WORK = '33333333-3333-4333-8333-333333333333';
    const HELD = 'agent-paused';

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
        });
        await dataSource.initialize();
        // Read-model spec: no parent rows are seeded.
        await dataSource.query('PRAGMA foreign_keys = OFF');
        runs = new AgentRunRepository(dataSource.getRepository(AgentRun));
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        await dataSource.getRepository(AgentRun).clear();
    });

    async function seed(rows: Array<Partial<AgentRun>>): Promise<void> {
        const repo = dataSource.getRepository(AgentRun);
        for (const row of rows) {
            await repo.save(
                repo.create({
                    userId: USER,
                    agentId: AGENT_A,
                    triggerKind: 'task',
                    status: 'queued',
                    workId: WORK,
                    ...row,
                }),
            );
        }
    }

    describe('findOldestQueuedForAgent', () => {
        it('returns the OLDEST held run, so a Resume releases in arrival order', async () => {
            await seed([
                {
                    id: '22222222-2222-4222-8222-222222222222',
                    queuedReason: HELD,
                    createdAt: new Date('2026-09-14T10:00:00.000Z'),
                },
                {
                    id: '11111111-2222-4222-8222-222222222222',
                    queuedReason: HELD,
                    createdAt: new Date('2026-09-14T09:00:00.000Z'),
                },
            ]);
            const oldest = await runs.findOldestQueuedForAgent(AGENT_A, HELD);
            expect(oldest?.id).toBe('11111111-2222-4222-8222-222222222222');
        });

        it('ignores runs held for a DIFFERENT agent', async () => {
            await seed([
                {
                    id: '33333333-2222-4222-8222-222222222222',
                    agentId: AGENT_B,
                    queuedReason: HELD,
                    createdAt: new Date('2026-09-14T08:00:00.000Z'),
                },
            ]);
            await expect(runs.findOldestQueuedForAgent(AGENT_A, HELD)).resolves.toBeNull();
        });

        it('ignores runs parked for another reason', async () => {
            await seed([
                {
                    id: '44444444-2222-4222-8222-222222222222',
                    queuedReason: 'concurrency-limit',
                    createdAt: new Date('2026-09-14T08:00:00.000Z'),
                },
            ]);
            await expect(runs.findOldestQueuedForAgent(AGENT_A, HELD)).resolves.toBeNull();
        });

        it('ignores a run that is already running', async () => {
            await seed([
                {
                    id: '55555555-2222-4222-8222-222222222222',
                    status: 'running',
                    queuedReason: HELD,
                },
            ]);
            await expect(runs.findOldestQueuedForAgent(AGENT_A, HELD)).resolves.toBeNull();
        });

        it('finds a held run that carries no Work at all', async () => {
            // The whole reason this query is agent-keyed: the Work-keyed
            // drain is blind to a Work-less held run.
            await seed([
                {
                    id: '66666666-2222-4222-8222-222222222222',
                    workId: null,
                    triggerKind: 'chat',
                    queuedReason: HELD,
                },
            ]);
            const oldest = await runs.findOldestQueuedForAgent(AGENT_A, HELD);
            expect(oldest?.id).toBe('66666666-2222-4222-8222-222222222222');
        });
    });

    describe('listQueuedForAgent', () => {
        it('reports the full total with a bounded, oldest-first preview', async () => {
            await seed([
                {
                    id: '77777777-2222-4222-8222-222222222222',
                    queuedReason: HELD,
                    createdAt: new Date('2026-09-14T10:00:00.000Z'),
                },
                {
                    id: '88888888-2222-4222-8222-222222222222',
                    queuedReason: HELD,
                    createdAt: new Date('2026-09-14T09:00:00.000Z'),
                },
                {
                    id: '99999999-2222-4222-8222-222222222222',
                    queuedReason: HELD,
                    createdAt: new Date('2026-09-14T08:00:00.000Z'),
                },
            ]);
            const result = await runs.listQueuedForAgent(AGENT_A, HELD, 2);
            expect(result.total).toBe(3);
            expect(result.items.map((r) => r.id)).toEqual([
                '99999999-2222-4222-8222-222222222222',
                '88888888-2222-4222-8222-222222222222',
            ]);
        });

        it('is empty, not an error, when nothing is held', async () => {
            await expect(runs.listQueuedForAgent(AGENT_A, HELD, 20)).resolves.toEqual({
                total: 0,
                items: [],
            });
        });

        it('a zero limit still reports the total', async () => {
            await seed([{ id: 'aaaaaaaa-2222-4222-8222-222222222222', queuedReason: HELD }]);
            await expect(runs.listQueuedForAgent(AGENT_A, HELD, 0)).resolves.toEqual({
                total: 1,
                items: [],
            });
        });
    });

    describe('countInFlightForAgent', () => {
        it('counts running and dispatched-queued runs, never held ones', async () => {
            // A held run is WAITING, not finishing — counting it would make
            // the card offer "stop it now" for work that never started.
            await seed([
                { id: 'bbbbbbbb-2222-4222-8222-222222222222', status: 'running' },
                { id: 'cccccccc-2222-4222-8222-222222222222', status: 'queued' },
                { id: 'dddddddd-2222-4222-8222-222222222222', queuedReason: HELD },
                { id: 'eeeeeeee-2222-4222-8222-222222222222', status: 'completed' },
                { id: 'ffffffff-2222-4222-8222-222222222222', agentId: AGENT_B, status: 'running' },
            ]);
            await expect(runs.countInFlightForAgent(AGENT_A)).resolves.toBe(2);
        });
    });
});
