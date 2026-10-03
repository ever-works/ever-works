import { Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import type { DataSource } from 'typeorm';
import { createHarness, type StatsHarness } from './fixtures/harness.helper-spec';
import { createStatsDataSource, seedOneUserInstance } from './fixtures/works-seed.helper-spec';

/**
 * Where the statistics private key is kept, and what happens when it cannot
 * be read.
 *
 * - Without `PLUGIN_SECRET_ENCRYPTION_KEY` the key is stored unencrypted: the
 *   module says so at boot (a machine token, never the key) and the operator
 *   page shows it (`keyStoredEncrypted: false`).
 * - Once the encryption key is set, the next boot wraps the stored key — it is
 *   otherwise rewritten only by a reset — and reports are still signed.
 * - With the encryption key removed or changed after that, the key cannot be
 *   read: the status says `key_unreadable`, a due report sends NOTHING and
 *   follows the retry ladder (not a failure every tick), and a reset recovers.
 */
const ENCRYPTION_KEY = 'PLUGIN_SECRET_ENCRYPTION_KEY';

describe('instance statistics — the stored key', () => {
    let dataSource: DataSource;
    let savedKey: string | undefined;
    let warn: jest.SpyInstance;

    beforeEach(async () => {
        savedKey = process.env[ENCRYPTION_KEY];
        delete process.env[ENCRYPTION_KEY];
        dataSource = await createStatsDataSource();
        await seedOneUserInstance(dataSource, '2026-10');
        warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    });

    afterEach(async () => {
        jest.restoreAllMocks();
        if (savedKey === undefined) delete process.env[ENCRYPTION_KEY];
        else process.env[ENCRYPTION_KEY] = savedKey;
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    /** A fresh replica: a new secret service reads the environment as it is now. */
    const replica = (): StatsHarness =>
        createHarness(dataSource, { now: new Date('2026-10-15T08:00:00Z') });

    const warnings = (): string[] => warn.mock.calls.map((call) => String(call[0]));

    it('without an encryption key: stored unencrypted, said at boot and on the operator page', async () => {
        const h = replica();
        await h.sender.initialise();
        const row = (await h.identity.get())!;
        expect(row.statsPrivateKeyEncrypted.startsWith('enc::v1::')).toBe(false);
        expect(warnings()).toContain(
            'ever-stats: key_stored_unencrypted (set PLUGIN_SECRET_ENCRYPTION_KEY)',
        );
        // The warning names the condition, never the key.
        expect(warnings().join('\n')).not.toContain(row.statsPrivateKeyEncrypted);
        expect(await h.service.operatorStatus()).toMatchObject({
            keyStoredEncrypted: false,
            reason: 'on',
        });
    });

    it('wraps a key stored before the encryption key was set, and still signs with it', async () => {
        await replica().sender.initialise();
        const before = (await replica().identity.get())!;

        process.env[ENCRYPTION_KEY] = randomBytes(32).toString('hex');
        const h = replica();
        await h.sender.initialise();
        const after = (await h.identity.get())!;
        expect(after.statsPrivateKeyEncrypted.startsWith('enc::v1::')).toBe(true);
        expect(after.statsKeyId).toBe(before.statsKeyId);
        expect(after.instanceId).toBe(before.instanceId);
        expect(await h.service.operatorStatus()).toMatchObject({ keyStoredEncrypted: true });

        await h.lease.updateSchedule({ nextSendAt: h.clock.now });
        const outcome = await h.sender.runDue();
        expect(outcome).toMatchObject({ ran: true, results: [{ status: 'sent' }] });
        expect(h.sink.calls[0].report.headers['Ever-Stats-Key']).toBe(before.statsPublicKey);
    });

    it('with the encryption key gone: key_unreadable, nothing sent, the ladder applies, a reset recovers', async () => {
        process.env[ENCRYPTION_KEY] = randomBytes(32).toString('hex');
        await replica().sender.initialise();

        // The operator removes the encryption key (or replaces it).
        process.env[ENCRYPTION_KEY] = randomBytes(32).toString('hex');
        const h = replica();
        await h.lease.updateSchedule({ nextSendAt: h.clock.now });
        expect(await h.service.operatorStatus()).toMatchObject({ reason: 'key_unreadable' });

        const outcome = await h.sender.runDue();
        expect(outcome).toEqual({
            ran: true,
            results: [{ status: 'failed', httpStatus: null, errorCode: 'key_unreadable' }],
        });
        expect(h.sink.calls).toHaveLength(0);
        expect(await h.lease.lastReport()).toBeNull();
        const schedule = (await h.lease.schedule())!;
        expect(schedule.failures).toBe(1);
        expect(schedule.nextSendAt!.getTime() - h.clock.now.getTime()).toBe(60 * 60 * 1000);
        // A tick before then does nothing at all.
        h.clock.now = new Date(h.clock.now.getTime() + 60_000);
        expect(await h.sender.runDue()).toEqual({ ran: false, reason: 'not_due' });

        await h.service.resetIdentity('operator-user');
        expect(await h.service.operatorStatus()).toMatchObject({ reason: 'on' });
        await h.lease.updateSchedule({ nextSendAt: h.clock.now });
        expect(await h.sender.runDue()).toMatchObject({ ran: true, results: [{ status: 'sent' }] });
        expect(h.sink.calls).toHaveLength(1);
    });
});
