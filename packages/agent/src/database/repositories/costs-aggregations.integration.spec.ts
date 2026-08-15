import { DataSource } from 'typeorm';
import { AgentRun } from '@src/entities/agent-run.entity';
import { PluginUsageCapability, PluginUsageEvent } from '@src/entities/plugin-usage-event.entity';
import { ENTITIES } from '../_entities-inventory';
import { AgentRunRepository } from './agent-run.repository';
import { PluginUsageRepository } from './plugin-usage.repository';

/**
 * The Costs dashboard aggregations, executed against a real (in-memory)
 * database rather than a mocked query builder.
 *
 * The unit spec beside `CostsSummaryService` mocks these repositories
 * wholesale, so no SQL is ever generated there and nothing can catch a
 * window that is inclusive on the wrong end, a GROUP BY that drops the
 * NULL bucket, or an ORDER BY that ties non-deterministically. Those are
 * exactly the defects that make a spend report quietly wrong, so they
 * are pinned here over seeded rows.
 *
 * Driver note: better-sqlite3 is what CI and the e2e stack run, so a
 * Postgres-only construct (`to_char`, `date_trunc`) would fail here —
 * which is the point. Cross-driver identifier quoting is separately
 * pinned by `credit-ledger.period-totals-sql.integration.spec.ts`.
 */
describe('Costs aggregations over seeded rows (integration)', () => {
    let dataSource: DataSource;
    let usage: PluginUsageRepository;
    let runs: AgentRunRepository;

    const USER = '11111111-1111-4111-8111-111111111111';
    const OTHER_USER = '22222222-2222-4222-8222-222222222222';
    const AGENT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const AGENT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const WORK = '33333333-3333-4333-8333-333333333333';

    const FROM = new Date('2026-08-08T00:00:00.000Z');
    const TO = new Date('2026-08-15T00:00:00.000Z');

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            // The whole inventory, not a hand-picked subset:
            // `PluginUsageEvent` declares `@ManyToOne` to `User` and
            // `Work`, whose own relation graphs reach most of the schema,
            // so TypeORM's metadata builder refuses any partial list. The
            // e2e stack boots the same inventory on this driver, so this
            // is also a cheap guard that the two new indexes are portable.
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        // Referential integrity is switched off deliberately, and AFTER
        // initialize because TypeORM's better-sqlite3 driver turns it on
        // itself during connection setup (so `prepareDatabase` is too
        // early). These are AGGREGATION specs: none of the queries under
        // test joins to `users` / `works` / `agents`, so seeding a valid
        // parent graph for every fixture row would add a large amount of
        // unrelated setup whose breakage would read as a costs bug. The
        // FKs themselves are created by the migrations and exercised by
        // the e2e stack.
        await dataSource.query('PRAGMA foreign_keys = OFF');
        usage = new PluginUsageRepository(dataSource.getRepository(PluginUsageEvent));
        runs = new AgentRunRepository(dataSource.getRepository(AgentRun));
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        await dataSource.getRepository(PluginUsageEvent).clear();
        await dataSource.getRepository(AgentRun).clear();
    });

    function seedEvent(overrides: Partial<PluginUsageEvent>): Promise<PluginUsageEvent> {
        const repository = dataSource.getRepository(PluginUsageEvent);
        return repository.save(
            repository.create({
                userId: USER,
                workId: WORK,
                pluginId: 'anthropic',
                capability: PluginUsageCapability.AI,
                units: 1,
                costCents: 0,
                currency: 'usd',
                occurredAt: new Date('2026-08-10T12:00:00.000Z'),
                ...overrides,
            } as Partial<PluginUsageEvent>),
        );
    }

    function seedRun(overrides: Partial<AgentRun>): Promise<AgentRun> {
        const repository = dataSource.getRepository(AgentRun);
        return repository.save(
            repository.create({
                userId: USER,
                agentId: AGENT_A,
                triggerKind: 'task',
                status: 'completed',
                gateAttempts: 0,
                persistent: false,
                awaitingInput: false,
                interruptRequested: false,
                createdAt: new Date('2026-08-10T12:00:00.000Z'),
                ...overrides,
            } as Partial<AgentRun>),
        );
    }

    describe('getDailySpendByAgentForUser', () => {
        // Day-level assertions use midday timestamps and compare days to
        // each OTHER rather than to hard-coded strings. The better-sqlite3
        // driver round-trips a timestamp through a string and reads it back
        // in the process timezone, so a midnight-UTC event lands in the
        // previous day's bucket on a runner east of Greenwich. That is a
        // driver artifact (production is Postgres) and pinning absolute
        // day strings would make this suite pass or fail by geography.
        const midday = (date: string) => new Date(`${date}T12:00:00.000Z`);

        it('merges same-day events per agent and keeps the null-agent bucket', async () => {
            await seedEvent({
                agentId: AGENT_A,
                costCents: 100,
                occurredAt: new Date('2026-08-10T09:00:00.000Z'),
            });
            await seedEvent({
                agentId: AGENT_A,
                costCents: 50,
                occurredAt: new Date('2026-08-10T15:00:00.000Z'),
            });
            await seedEvent({ agentId: AGENT_B, costCents: 7, occurredAt: midday('2026-08-10') });
            await seedEvent({ agentId: null, costCents: 3, occurredAt: midday('2026-08-11') });

            const buckets = await usage.getDailySpendByAgentForUser(USER, FROM, TO);

            // Three buckets, not four: the two AGENT_A events share a day.
            expect(buckets).toHaveLength(3);
            const [firstDay, secondDay] = [...new Set(buckets.map((b) => b.day))];
            expect(buckets).toEqual(
                expect.arrayContaining([
                    { day: firstDay, agentId: AGENT_A, costCents: 150 },
                    { day: firstDay, agentId: AGENT_B, costCents: 7 },
                    // Unattributed spend keeps its own bucket instead of
                    // being folded into an agent's or dropped.
                    { day: secondDay, agentId: null, costCents: 3 },
                ]),
            );
            expect(secondDay).not.toBe(firstDay);
        });

        it('honours the half-open window and excludes other users', async () => {
            // One tick before `from` — excluded.
            await seedEvent({
                agentId: AGENT_A,
                costCents: 111,
                occurredAt: new Date(FROM.getTime() - 1),
            });
            // Exactly `to` — excluded; the window is [from, to).
            await seedEvent({ agentId: AGENT_A, costCents: 222, occurredAt: TO });
            // Exactly `from` — INCLUDED.
            await seedEvent({ agentId: AGENT_A, costCents: 5, occurredAt: FROM });
            await seedEvent({
                agentId: AGENT_A,
                costCents: 999,
                userId: OTHER_USER,
                occurredAt: midday('2026-08-10'),
            });

            const buckets = await usage.getDailySpendByAgentForUser(USER, FROM, TO);

            expect(buckets).toHaveLength(1);
            expect(buckets[0]).toMatchObject({ agentId: AGENT_A, costCents: 5 });
        });

        it('returns days in ascending order', async () => {
            for (const day of ['2026-08-13', '2026-08-09', '2026-08-11']) {
                await seedEvent({ agentId: AGENT_A, costCents: 1, occurredAt: midday(day) });
            }

            const buckets = await usage.getDailySpendByAgentForUser(USER, FROM, TO);
            const days = buckets.map((b) => b.day);

            expect(days).toHaveLength(3);
            expect(days).toEqual([...days].sort());
        });
    });

    describe('getDominantModelByRun', () => {
        const RUN_1 = '44444444-4444-4444-8444-444444444441';
        const RUN_2 = '44444444-4444-4444-8444-444444444442';

        it('picks the model that accounts for the most spend in each run', async () => {
            await seedEvent({ runId: RUN_1, modelId: 'cheap-model', costCents: 10 });
            await seedEvent({ runId: RUN_1, modelId: 'cheap-model', costCents: 10 });
            await seedEvent({ runId: RUN_1, modelId: 'expensive-model', costCents: 90 });
            await seedEvent({ runId: RUN_2, modelId: 'only-model', costCents: 5 });

            const models = await usage.getDominantModelByRun([RUN_1, RUN_2]);

            expect(models.get(RUN_1)).toBe('expensive-model');
            expect(models.get(RUN_2)).toBe('only-model');
        });

        it('omits runs whose events carry no model id rather than inventing one', async () => {
            await seedEvent({ runId: RUN_1, modelId: null, costCents: 40 });

            const models = await usage.getDominantModelByRun([RUN_1, RUN_2]);

            expect(models.has(RUN_1)).toBe(false);
            expect(models.size).toBe(0);
        });

        it('short-circuits on an empty id list instead of emitting `IN ()`', async () => {
            await expect(usage.getDominantModelByRun([])).resolves.toEqual(new Map());
        });
    });

    describe('countRunsByAgentForUser', () => {
        it('counts every run in the window regardless of status', async () => {
            await seedRun({ agentId: AGENT_A, status: 'completed' });
            await seedRun({ agentId: AGENT_A, status: 'failed' });
            // Queued-and-never-dispatched still consumed an attempt.
            await seedRun({ agentId: AGENT_A, status: 'queued' });
            await seedRun({ agentId: AGENT_B, status: 'completed' });

            const counts = await runs.countRunsByAgentForUser(USER, FROM, TO);

            expect(counts).toEqual(
                expect.arrayContaining([
                    { agentId: AGENT_A, runs: 3 },
                    { agentId: AGENT_B, runs: 1 },
                ]),
            );
            expect(counts).toHaveLength(2);
        });

        it('honours the half-open window and excludes other users', async () => {
            await seedRun({ createdAt: new Date('2026-08-07T23:59:59.999Z') });
            await seedRun({ createdAt: TO });
            await seedRun({ createdAt: FROM });
            await seedRun({ userId: OTHER_USER });

            const counts = await runs.countRunsByAgentForUser(USER, FROM, TO);

            expect(counts).toEqual([{ agentId: AGENT_A, runs: 1 }]);
        });
    });

    describe('findTopByCostForUser', () => {
        it('orders by cost descending and applies the limit', async () => {
            await seedRun({ costCents: 10 });
            await seedRun({ costCents: 900 });
            await seedRun({ costCents: 300 });

            const top = await runs.findTopByCostForUser(USER, FROM, TO, 2);

            expect(top.map((run) => run.costCents)).toEqual([900, 300]);
        });

        it('excludes unsettled runs — NULL costCents means "unknown", not "free"', async () => {
            await seedRun({ costCents: null });
            await seedRun({ costCents: 0 });
            await seedRun({ costCents: 1 });

            const top = await runs.findTopByCostForUser(USER, FROM, TO, 20);

            expect(top).toHaveLength(1);
            expect(top[0].costCents).toBe(1);
        });

        it('breaks cost ties deterministically by id so paging is stable', async () => {
            const ids = [
                '55555555-5555-4555-8555-555555555553',
                '55555555-5555-4555-8555-555555555551',
                '55555555-5555-4555-8555-555555555552',
            ];
            for (const id of ids) {
                await seedRun({ id, costCents: 100 });
            }

            const first = await runs.findTopByCostForUser(USER, FROM, TO, 20);
            const second = await runs.findTopByCostForUser(USER, FROM, TO, 20);

            expect(first.map((run) => run.id)).toEqual([...ids].sort());
            expect(second.map((run) => run.id)).toEqual(first.map((run) => run.id));
        });

        it('honours the half-open window and never leaks another user run', async () => {
            await seedRun({ costCents: 500, createdAt: TO });
            await seedRun({ costCents: 600, userId: OTHER_USER });
            await seedRun({ costCents: 700, createdAt: FROM });

            const top = await runs.findTopByCostForUser(USER, FROM, TO, 20);

            expect(top.map((run) => run.costCents)).toEqual([700]);
        });

        it('clamps a caller-supplied limit into 1..100', async () => {
            for (let i = 0; i < 3; i += 1) {
                await seedRun({ costCents: 10 + i });
            }

            await expect(runs.findTopByCostForUser(USER, FROM, TO, 0)).resolves.toHaveLength(1);
            await expect(runs.findTopByCostForUser(USER, FROM, TO, 1000)).resolves.toHaveLength(3);
        });
    });
});
