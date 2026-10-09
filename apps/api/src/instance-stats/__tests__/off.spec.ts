import { readFileSync } from 'fs';
import { join } from 'path';
import type { DataSource } from 'typeorm';
import { InstanceStatsModule, instanceStatsModuleImports } from '../instance-stats.module';
import { InstanceStatsSchedulerService } from '../instance-stats-scheduler.service';
import { createHarness } from './fixtures/harness.helper-spec';
import { createStatsDataSource, seedOneUserInstance } from './fixtures/works-seed.helper-spec';

/**
 * Off means off.
 *
 * - `EVER_STATS_ENABLED` unset or empty (the default, see
 *   `EVER_STATS_DEFAULT_ENABLED`), `false`, or any value other than `true`:
 *   the module is not imported at all — `ApiModule` gets nothing to import, so
 *   there is no route, no timer and no identity row. Only
 *   `EVER_STATS_ENABLED=true` imports it.
 * - The operator switch in Settings off: the module is loaded, its timer
 *   ticks, and two simulated minutes with a 5-second send interval make no
 *   request. Switching it back on sends (the control that the run could send).
 */
describe('instance statistics — off', () => {
    describe('EVER_STATS_ENABLED', () => {
        it.each([
            [undefined, false],
            ['', false],
            ['true', true],
            ['false', false],
            ['TRUE', false],
            ['1', false],
            ['FALSE', false],
            ['0', false],
            ['no', false],
            ['off', false],
        ])('EVER_STATS_ENABLED=%s ⇒ module imported: %s', (value, imported) => {
            const env: Record<string, string | undefined> = {};
            if (value !== undefined) env.EVER_STATS_ENABLED = value;
            expect(instanceStatsModuleImports(env)).toEqual(imported ? [InstanceStatsModule] : []);
        });

        it('is the ONLY way ApiModule reaches the statistics module', () => {
            const source = readFileSync(join(__dirname, '..', '..', 'api.module.ts'), 'utf8');
            expect(source.match(/\.\.\.instanceStatsModuleImports\(\)/g)).toHaveLength(1);
            // Never imported unconditionally, by class, anywhere in the root module.
            expect(source).not.toMatch(/\bInstanceStatsModule\b/);
        });
    });

    describe('the operator switch, with the module loaded', () => {
        let dataSource: DataSource;

        beforeEach(async () => {
            dataSource = await createStatsDataSource();
            await seedOneUserInstance(dataSource, '2026-10');
            // Timers only: TypeORM checks values against the real `Date`, so the
            // clock the module reads is advanced by hand, second by second.
            jest.useFakeTimers({
                doNotFake: ['Date', 'nextTick', 'setImmediate', 'queueMicrotask'],
            });
        });

        afterEach(async () => {
            jest.useRealTimers();
            if (dataSource?.isInitialized) await dataSource.destroy();
        });

        it('makes no request in 120 s with a 5 s interval while switched off — and sends once switched on', async () => {
            const h = createHarness(dataSource, {
                env: { EVER_STATS_SEND_INTERVAL_S: '5' },
                now: new Date('2026-10-15T08:00:00Z'),
            });
            await h.identity.ensure();
            await h.identity.setStatsEnabledUi(false);
            await h.lease.ensureSchedule(new Date('2026-10-15T08:00:00Z'));

            // Every run's outcome, so a run that THREW cannot pass for one that sent nothing.
            const outcomes: unknown[] = [];
            const runDue = h.sender.runDue.bind(h.sender);
            jest.spyOn(h.sender, 'runDue').mockImplementation(async () => {
                const outcome = await runDue();
                outcomes.push(outcome);
                return outcome;
            });

            const advance = async (seconds: number) => {
                for (let second = 0; second < seconds; second += 1) {
                    h.clock.now = new Date(h.clock.now.getTime() + 1_000);
                    await jest.advanceTimersByTimeAsync(1_000);
                }
            };

            const scheduler = new InstanceStatsSchedulerService(h.sender, h.config);
            scheduler.onApplicationBootstrap();
            try {
                await advance(120);
                expect(h.sink.calls).toHaveLength(0);
                expect(await h.lease.lastReport()).toBeNull();
                // The timer did run (every 2.5 s), and every run stopped at the switch.
                expect(outcomes.length).toBeGreaterThanOrEqual(40);
                expect(
                    outcomes.every((outcome) => (outcome as { reason?: string }).reason === 'ui'),
                ).toBe(true);

                // Control: the same run sends as soon as the operator switches it on.
                await h.identity.setStatsEnabledUi(true);
                await advance(5);
                expect(h.sink.calls.length).toBeGreaterThan(0);
            } finally {
                scheduler.onModuleDestroy();
            }
        });
    });
});
