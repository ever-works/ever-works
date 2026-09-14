import { DataSource } from 'typeorm';
import { AgentRun } from '@src/entities/agent-run.entity';
import { PluginUsageCapability, PluginUsageEvent } from '@src/entities/plugin-usage-event.entity';
import { UsageMeter, UsageOutcome, UsagePayer } from '@src/entities/_types';
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

    describe('getRunSpendLines', () => {
        const RUN_1 = '44444444-4444-4444-8444-444444444441';
        const RUN_2 = '44444444-4444-4444-8444-444444444442';

        it("groups one run's events by capability and model, most expensive first", async () => {
            await seedEvent({ runId: RUN_1, modelId: 'model-a', units: 400, costCents: 10 });
            await seedEvent({ runId: RUN_1, modelId: 'model-a', units: 500, costCents: 19 });
            await seedEvent({
                runId: RUN_1,
                modelId: null,
                capability: PluginUsageCapability.SEARCH,
                pluginId: 'search-plugin',
                units: 1,
                costCents: 2,
            });
            // Another run's spend never leaks into this receipt.
            await seedEvent({ runId: RUN_2, modelId: 'model-a', units: 1, costCents: 500 });

            const lines = await usage.getRunSpendLines(RUN_1);

            expect(lines).toEqual([
                { capability: 'ai', modelId: 'model-a', calls: 2, units: 900, costCents: 29 },
                { capability: 'search', modelId: null, calls: 1, units: 1, costCents: 2 },
            ]);
        });

        it('returns no lines for a run with no retained usage', async () => {
            await expect(usage.getRunSpendLines(RUN_1)).resolves.toEqual([]);
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

    /**
     * AW-17 — the meter-aware aggregations, over seeded rows. The load-bearing
     * properties: rows recorded before meters (`meter IS NULL`) never land in
     * a named meter or a breakdown; the NULL Mission bucket survives GROUP BY;
     * the per-run groups agree with `getRunCostByPlugin`.
     */
    describe('meter aggregations (AW-17)', () => {
        const MISSION_A = '44444444-4444-4444-8444-444444444444';
        const RUN = '55555555-5555-4555-8555-555555555555';

        async function seedMetered(): Promise<void> {
            await seedEvent({
                pluginId: 'search-a',
                capability: PluginUsageCapability.SEARCH,
                meter: UsageMeter.CREDITS,
                payer: UsagePayer.PLATFORM,
                outcome: UsageOutcome.OK,
                priceKey: 'search.query',
                priceVersion: 1,
                creditsCharged: 2,
                costCents: 1,
                missionId: MISSION_A,
                runId: RUN,
            });
            await seedEvent({
                pluginId: 'search-a',
                capability: PluginUsageCapability.SEARCH,
                meter: UsageMeter.CREDITS,
                payer: UsagePayer.PLATFORM,
                outcome: UsageOutcome.CACHED,
                priceKey: 'search.query',
                priceVersion: 1,
                creditsCharged: 0,
                missionId: MISSION_A,
                runId: RUN,
            });
            await seedEvent({
                pluginId: 'openai',
                capability: PluginUsageCapability.AI,
                meter: UsageMeter.MODEL,
                payer: UsagePayer.WORKSPACE,
                outcome: UsageOutcome.OK,
                priceKey: 'ai.managed',
                creditsCharged: 0,
                costCents: 40,
                runId: RUN,
            });
            await seedEvent({
                pluginId: 'extract-a',
                capability: PluginUsageCapability.EXTRACTOR,
                meter: UsageMeter.CREDITS,
                payer: UsagePayer.UNCONFIRMED,
                outcome: UsageOutcome.FAILED,
                priceKey: 'extractor.page',
                priceVersion: 1,
                creditsCharged: 0,
            });
            // Recorded before meters were separated.
            await seedEvent({ pluginId: 'anthropic', costCents: 84, runId: RUN });
            // Another user, and outside the window.
            await seedEvent({
                userId: OTHER_USER,
                meter: UsageMeter.CREDITS,
                priceKey: 'search.query',
                creditsCharged: 99,
            });
            await seedEvent({
                meter: UsageMeter.CREDITS,
                priceKey: 'search.query',
                creditsCharged: 77,
                occurredAt: TO,
            });
        }

        it('getSpendByMeterForUser groups by meter × outcome × payer and returns the pre-meter bucket apart', async () => {
            await seedMetered();

            const rows = await usage.getSpendByMeterForUser(USER, FROM, TO);

            const find = (meter: string | null, outcome: string | null) =>
                rows.find((row) => row.meter === meter && row.outcome === outcome);
            expect(find('credits', 'ok')).toMatchObject({ calls: 1, credits: 2, costCents: 1 });
            expect(find('credits', 'cached')).toMatchObject({ calls: 1, credits: 0 });
            expect(find('credits', 'failed')).toMatchObject({ calls: 1, payer: 'unconfirmed' });
            expect(find('model', 'ok')).toMatchObject({ calls: 1, costCents: 40, credits: 0 });
            expect(find(null, null)).toMatchObject({ calls: 1, costCents: 84 });
            // Neither the other user's 99 credits nor the out-of-window 77.
            expect(rows.reduce((sum, row) => sum + row.credits, 0)).toBe(2);
        });

        it('getSpendByPriceKeyForUser ranks classified kinds and excludes pre-meter rows', async () => {
            await seedMetered();

            const rows = await usage.getSpendByPriceKeyForUser(USER, FROM, TO);

            expect(rows.map((row) => row.key)).toEqual([
                'search.query',
                'ai.managed',
                'extractor.page',
            ]);
            expect(rows[0]).toMatchObject({ capability: 'search', calls: 2, credits: 2 });
            expect(rows.some((row) => row.key === null)).toBe(false);
        });

        it('getSpendByMissionForUser keeps the NULL Mission bucket', async () => {
            await seedMetered();

            const rows = await usage.getSpendByMissionForUser(USER, FROM, TO);

            expect(rows).toEqual([
                expect.objectContaining({ key: MISSION_A, calls: 2, credits: 2 }),
                expect.objectContaining({ key: null, calls: 2, costCents: 40 }),
            ]);
        });

        it('getRunMeterGroups covers the same rows as getRunCostByPlugin', async () => {
            await seedMetered();

            const [groups, byPlugin] = await Promise.all([
                usage.getRunMeterGroups(RUN),
                usage.getRunCostByPlugin(RUN),
            ]);

            const groupCost = groups.reduce((sum, group) => sum + group.costCents, 0);
            const pluginCost = byPlugin.reduce((sum, row) => sum + row.costCents, 0);
            expect(groupCost).toBe(pluginCost);
            expect(groups.find((g) => g.meter === 'credits')).toMatchObject({
                pluginId: 'search-a',
                priceKey: 'search.query',
                priceVersion: 1,
                calls: 2,
                creditsCharged: 2,
            });
            expect(groups.find((g) => g.meter === null)).toMatchObject({
                pluginId: 'anthropic',
                priceVersion: null,
                costCents: 84,
            });
        });

        it('getRunMeterLines splits a run by meter, kind and outcome', async () => {
            await seedMetered();

            const lines = await usage.getRunMeterLines(RUN);

            expect(lines).toHaveLength(4);
            expect(lines.filter((line) => line.priceKey === 'search.query')).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ outcome: 'ok', calls: 1, creditsCharged: 2 }),
                    expect.objectContaining({ outcome: 'cached', calls: 1, creditsCharged: 0 }),
                ]),
            );
        });

        it('countForUserExport counts the export scope, organization included', async () => {
            await seedMetered();
            await seedEvent({ organizationId: '66666666-6666-4666-8666-666666666666' });

            await expect(usage.countForUserExport(USER, FROM, TO)).resolves.toBe(6);
            await expect(
                usage.countForUserExport(USER, FROM, TO, {
                    organizationId: '66666666-6666-4666-8666-666666666666',
                }),
            ).resolves.toBe(1);
        });
    });
});
