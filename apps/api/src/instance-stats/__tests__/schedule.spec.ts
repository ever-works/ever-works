import type { DataSource } from 'typeorm';
import { EverInstance } from '@ever-works/agent/entities';
import { StatsSinkUnavailableError } from '@ever-works/agent/facades';
import { INSTANCE_STATS_MODULE_VERSION, versionAndChannel } from '../instance-stats.mapping';
import { instanceStatsReleaseMarker } from '../instance-stats-sender.service';
import { getBuildInfo } from '../../health/build-info';
import { createHarness, FakeSink, type StatsHarness } from './fixtures/harness.helper-spec';
import { createStatsDataSource, seedOneUserInstance } from './fixtures/works-seed.helper-spec';

/**
 * The schedule: first send a day after first boot (10 minutes after boot when
 * overdue by more than a day), then once per UTC day at a random second drawn
 * per report, the closed month re-sent on days 1-3, the retry ladder after a
 * failure, no retry of a report refused by the schema or for its key until
 * a release changes the product or module version (or a reset), a bounded
 * 7-day pause after any other refusal (a redirect, say), the operator switch,
 * and ONE report from two replicas.
 */
const HOUR = 60 * 60 * 1000;

async function freshDataSource(): Promise<DataSource> {
    const dataSource = await createStatsDataSource();
    await seedOneUserInstance(dataSource, '2026-10');
    return dataSource;
}

async function bootAt(
    dataSource: DataSource,
    at: string,
    random: (max: number) => number = () => 3_600,
): Promise<StatsHarness> {
    const harness = createHarness(dataSource, { now: new Date(at), random });
    await harness.identity.ensure();
    return harness;
}

describe('InstanceStatsSenderService — schedule', () => {
    let dataSource: DataSource;

    beforeEach(async () => {
        dataSource = await freshDataSource();
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    async function setCreatedAt(at: Date): Promise<void> {
        await dataSource.getRepository(EverInstance).update({ id: 'self' }, { createdAt: at });
    }

    it('sends the first report one day after first boot, not before', async () => {
        const h = await bootAt(dataSource, '2026-10-15T08:00:00Z');
        await setCreatedAt(new Date('2026-10-15T08:00:00Z'));
        const schedule = await h.sender.initialise();
        expect(schedule.nextSendAt?.toISOString()).toBe('2026-10-16T08:00:00.000Z');

        h.clock.now = new Date('2026-10-16T07:59:59Z');
        expect(await h.sender.runDue()).toEqual({ ran: false, reason: 'not_due' });
        expect(h.sink.calls).toHaveLength(0);

        h.clock.now = new Date('2026-10-16T08:00:00Z');
        const outcome = await h.sender.runDue();
        expect(outcome.ran).toBe(true);
        expect(h.sink.calls).toHaveLength(1);
        expect(h.sink.calls[0].pluginId).toBe('ever-stats-sink');
        expect(h.sink.calls[0].options).toMatchObject({
            baseUrl: 'https://api.ever.co',
            timeoutMs: 10_000,
        });
        expect(h.sink.calls[0].options.userAgent).toMatch(
            /^ever-stats\/1\.0\.0 \(works\/\d+\.\d+\.\d+\)$/,
        );
    });

    it('sends 10 minutes after boot when the first send is overdue by more than a day', async () => {
        const h = await bootAt(dataSource, '2026-10-20T08:00:00Z');
        await setCreatedAt(new Date('2026-10-10T08:00:00Z'));
        const schedule = await h.sender.initialise();
        expect(schedule.nextSendAt?.toISOString()).toBe('2026-10-20T08:10:00.000Z');
    });

    it('also pulls an overdue stored schedule forward to 10 minutes after boot', async () => {
        const h = await bootAt(dataSource, '2026-10-15T08:00:00Z');
        await setCreatedAt(new Date('2026-10-14T08:00:00Z'));
        await h.sender.initialise();
        h.clock.now = new Date('2026-10-25T12:00:00Z');
        const schedule = await h.sender.initialise();
        expect(schedule.nextSendAt?.toISOString()).toBe('2026-10-25T12:10:00.000Z');
    });

    it('schedules the next report at a random second of the next UTC day, drawn per report', async () => {
        const seconds = [12_345, 80_000];
        const draws: number[] = [];
        const h = await bootAt(dataSource, '2026-10-15T08:00:00Z', (max) => {
            draws.push(max);
            return seconds[draws.length - 1] ?? 0;
        });
        await h.lease.ensureSchedule(new Date('2026-10-15T08:00:00Z'));

        await h.sender.runDue();
        let schedule = await h.lease.schedule();
        expect(schedule?.nextSendAt?.toISOString()).toBe(
            new Date(Date.UTC(2026, 9, 16) + 12_345_000).toISOString(),
        );

        h.clock.now = schedule!.nextSendAt!;
        await h.sender.runDue();
        schedule = await h.lease.schedule();
        // A new draw for the next report: the same installation gets a different second.
        expect(schedule?.nextSendAt?.toISOString()).toBe(
            new Date(Date.UTC(2026, 9, 17) + 80_000_000).toISOString(),
        );
        expect(draws).toEqual([86_400, 86_400]);
        // The sent date carries no time of day.
        const body = JSON.parse(Buffer.from(h.sink.calls[0].report.body).toString('utf8'));
        expect(body.sent_at).toBe('2026-10-15');
    });

    it('re-sends the closed previous month once, on days 1-3', async () => {
        const h = await bootAt(dataSource, '2026-11-02T09:00:00Z');
        await h.lease.ensureSchedule(new Date('2026-11-02T09:00:00Z'));

        await h.sender.runDue();
        const periods = h.sink.calls.map((call) => [call.report.period, call.report.final]);
        expect(periods).toEqual([
            ['2026-11', false],
            ['2026-10', true],
        ]);

        h.clock.now = (await h.lease.schedule())!.nextSendAt!;
        await h.sender.runDue();
        // Already delivered: day 3 sends the running month only.
        expect(
            h.sink.calls.slice(2).map((call) => [call.report.period, call.report.final]),
        ).toEqual([['2026-11', false]]);
    });

    it('retries a failed send at +1 h, +4 h, +12 h, then at the next day slot', async () => {
        const h = await bootAt(dataSource, '2026-10-15T08:00:00Z');
        h.sink.answer = { status: 'failed', httpStatus: 503, errorCode: 'server_error' };
        await h.lease.ensureSchedule(new Date('2026-10-15T08:00:00Z'));

        const expected = [1 * HOUR, 4 * HOUR, 12 * HOUR];
        for (const step of expected) {
            const before = h.clock.now.getTime();
            await h.sender.runDue();
            const next = (await h.lease.schedule())!.nextSendAt!;
            expect(next.getTime() - before).toBe(step);
            h.clock.now = next;
        }
        await h.sender.runDue();
        const fourth = await h.lease.schedule();
        expect(fourth?.failures).toBe(4);
        expect(fourth?.nextSendAt?.getUTCHours()).toBe(1); // next UTC day + 3600 s

        h.sink.answer = { status: 'sent', httpStatus: 202, errorCode: null };
        h.clock.now = fourth!.nextSendAt!;
        await h.sender.runDue();
        expect((await h.lease.schedule())?.failures).toBe(0);
        // Every attempt is stored with its ladder position.
        const last = await h.lease.lastReport();
        expect(last?.status).toBe('sent');
    });

    it('does not retry a report refused by the schema until the release changes', async () => {
        const h = await bootAt(dataSource, '2026-10-15T08:00:00Z');
        h.sink.answer = {
            status: 'rejected',
            httpStatus: 422,
            errorCode: 'schema_violation',
            errors: [{ path: '/counts/works', code: 'unknown_field' }],
        };
        await h.lease.ensureSchedule(new Date('2026-10-15T08:00:00Z'));
        await h.sender.runDue();
        // Pinned to (statistics module version, product version), in the 14
        // characters of the column.
        const marker = (await h.lease.schedule())?.rejectedModuleVersion;
        const product = versionAndChannel(getBuildInfo().version).version;
        expect(marker).toBe(instanceStatsReleaseMarker(product));
        expect(marker).toHaveLength(14);
        expect(marker).not.toBe(instanceStatsReleaseMarker(`${product}.1`));
        const stored = await h.lease.lastReport();
        expect(stored).toMatchObject({
            status: 'rejected',
            httpStatus: 422,
            errorCode: 'schema_violation',
            errors: [{ path: '/counts/works', code: 'unknown_field' }],
        });

        h.clock.now = (await h.lease.schedule())!.nextSendAt!;
        expect(await h.sender.runDue()).toEqual({ ran: false, reason: 'parked' });
        expect(h.sink.calls).toHaveLength(1);

        // A Works upgrade (another product version, same statistics module):
        // the parked marker is no longer the running release's.
        await h.lease.updateSchedule({
            rejectedModuleVersion: instanceStatsReleaseMarker('0.0.1'),
        });
        h.sink.answer = { status: 'sent', httpStatus: 202, errorCode: null };
        h.clock.now = (await h.lease.schedule())!.nextSendAt!;
        expect((await h.sender.runDue()).ran).toBe(true);
        expect(h.sink.calls).toHaveLength(2);
    });

    it('un-parks a refusal stored by an earlier build (the bare module version)', async () => {
        const h = await bootAt(dataSource, '2026-10-15T08:00:00Z');
        await h.lease.ensureSchedule(new Date('2026-10-15T08:00:00Z'));
        await h.lease.updateSchedule({ rejectedModuleVersion: INSTANCE_STATS_MODULE_VERSION });
        expect((await h.sender.runDue()).ran).toBe(true);
    });

    it.each([
        [302, 'redirect'],
        [401, 'http_error'],
        [404, 'http_error'],
    ] as const)(
        'pauses for 7 days after a %s refusal, then tries again',
        async (httpStatus, errorCode) => {
            const h = await bootAt(dataSource, '2026-10-15T08:00:00Z');
            await h.lease.ensureSchedule(new Date('2026-10-15T08:00:00Z'));
            h.sink.answer = { status: 'rejected', httpStatus, errorCode };
            await h.sender.runDue();
            const schedule = (await h.lease.schedule())!;
            expect(schedule.rejectedModuleVersion ?? null).toBeNull();
            // The random second of the 7th day (the test random draws 3600 s).
            expect(schedule.nextSendAt?.toISOString()).toBe('2026-10-22T01:00:00.000Z');

            h.clock.now = new Date('2026-10-21T08:00:00Z');
            expect(await h.sender.runDue()).toEqual({ ran: false, reason: 'not_due' });
            expect(h.sink.calls).toHaveLength(1);

            h.sink.answer = { status: 'sent', httpStatus: 202, errorCode: null };
            h.clock.now = schedule.nextSendAt!;
            expect((await h.sender.runDue()).ran).toBe(true);
            expect(h.sink.calls).toHaveLength(2);
        },
    );

    it('makes no request at all while the operator switch is off', async () => {
        const h = await bootAt(dataSource, '2026-10-15T08:00:00Z');
        await h.lease.ensureSchedule(new Date('2026-10-15T08:00:00Z'));
        await h.identity.setStatsEnabledUi(false);
        expect(await h.sender.runDue()).toEqual({ ran: false, reason: 'ui' });
        expect(h.sink.calls).toHaveLength(0);
        expect(await h.lease.lastReport()).toBeNull();
    });

    it('sends one report from two replicas firing at the same moment', async () => {
        const sink = new FakeSink();
        const replicaA = createHarness(dataSource, { now: new Date('2026-10-15T08:00:00Z'), sink });
        const replicaB = createHarness(dataSource, { now: new Date('2026-10-15T08:00:00Z'), sink });
        await replicaA.identity.ensure();
        await replicaA.lease.ensureSchedule(new Date('2026-10-15T08:00:00Z'));

        const outcomes = await Promise.all([replicaA.sender.runDue(), replicaB.sender.runDue()]);
        expect(sink.calls).toHaveLength(1);
        expect(outcomes.filter((outcome) => outcome.ran)).toHaveLength(1);
        expect(replicaA.lease.holderId).not.toBe(replicaB.lease.holderId);
        // The lease is free again afterwards.
        const schedule = await replicaA.lease.schedule();
        expect(schedule?.holder ?? null).toBeNull();
    });

    it('lets a replica take a lease that expired (a crashed holder)', async () => {
        const h = await bootAt(dataSource, '2026-10-15T08:00:00Z');
        await h.lease.ensureSchedule(new Date('2026-10-15T08:00:00Z'));
        expect(await h.lease.tryAcquire(h.clock.now)).toBe(true);
        const other = createHarness(dataSource, { now: new Date('2026-10-15T08:10:00Z') });
        expect(await other.lease.tryAcquire(other.clock.now)).toBe(false);
        expect(await other.lease.tryAcquire(new Date('2026-10-15T08:16:00Z'))).toBe(true);
    });

    it('keeps only the last 12 attempts', async () => {
        const h = await bootAt(dataSource, '2026-10-15T08:00:00Z');
        h.sink.answer = { status: 'sent', httpStatus: 202, errorCode: null };
        await h.lease.ensureSchedule(new Date('2026-10-15T08:00:00Z'));
        for (let day = 0; day < 15; day += 1) {
            h.clock.now = (await h.lease.schedule())!.nextSendAt!;
            await h.sender.runDue();
        }
        const rows = await dataSource.query('SELECT COUNT(*) AS n FROM ever_stats_report');
        expect(Number(rows[0].n)).toBe(12);
    });

    it('stores the exact bytes it handed to the sink', async () => {
        const h = await bootAt(dataSource, '2026-10-15T08:00:00Z');
        await h.lease.ensureSchedule(new Date('2026-10-15T08:00:00Z'));
        await h.sender.runDue();
        const stored = await h.lease.lastReport();
        expect(
            Buffer.compare(
                Buffer.from(stored!.payload, 'utf8'),
                Buffer.from(h.sink.calls[0].report.body),
            ),
        ).toBe(0);
        expect(stored!.bytes).toBe(h.sink.calls[0].report.body.byteLength);
    });

    it('records a failed attempt and makes no request when the sink is unavailable or the URL is refused', async () => {
        const unusable = createHarness(dataSource, {
            now: new Date('2026-10-15T08:00:00Z'),
            env: { EVER_STATS_API_URL: 'http://stats.example.com' },
        });
        await unusable.identity.ensure();
        await unusable.lease.ensureSchedule(new Date('2026-10-15T08:00:00Z'));
        const outcome = await unusable.sender.runDue();
        expect(outcome).toEqual({
            ran: true,
            results: [{ status: 'failed', httpStatus: null, errorCode: 'invalid_url' }],
        });
        expect(unusable.sink.calls).toHaveLength(0);

        const missing = createHarness(dataSource, { now: new Date('2026-10-16T08:00:00Z') });
        missing.sink.answer = async () => {
            throw new StatsSinkUnavailableError('not_registered');
        };
        await missing.lease.updateSchedule({
            nextSendAt: new Date('2026-10-16T08:00:00Z'),
            failures: 0,
        });
        expect(await missing.sender.runDue()).toEqual({
            ran: true,
            results: [{ status: 'failed', httpStatus: null, errorCode: 'sink_unavailable' }],
        });
        expect((await missing.lease.lastReport())?.errorCode).toBe('sink_unavailable');
    });
});
