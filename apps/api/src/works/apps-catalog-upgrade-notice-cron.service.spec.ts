import { APPS_CATALOG_REFRESH_CRON } from '@ever-works/contracts';
import { config } from '@ever-works/agent/config';
import { SCHEDULE_CRON_OPTIONS } from '@nestjs/schedule/dist/schedule.constants';
import {
    APP_BLUEPRINT_NOTICE_LOCK_KEY,
    AppsCatalogUpgradeNoticeCronService,
} from './apps-catalog-upgrade-notice-cron.service';

/** APW-03 T30 (lane aw-blueprints) — the hourly Blueprint upgrade-notice pass. */
describe('AppsCatalogUpgradeNoticeCronService (APW-03 T30)', () => {
    afterEach(() => jest.restoreAllMocks());

    const summary = { blueprints: 1, scanned: 2, notices: 2 };

    it('runs on the Apps-catalog refresh schedule (23 * * * *)', () => {
        const metadata = Reflect.getMetadata(
            SCHEDULE_CRON_OPTIONS,
            AppsCatalogUpgradeNoticeCronService.prototype.runUpgradeNotices,
        ) as { cronTime?: string } | undefined;
        expect(metadata?.cronTime).toBe(APPS_CATALOG_REFRESH_CRON);
        expect(APPS_CATALOG_REFRESH_CRON).toBe('23 * * * *');
    });

    it('runs the fan-out when App Works is on', async () => {
        jest.spyOn(config.everWorks.apps, 'worksEnabled').mockReturnValue(true);
        const upgrades = { refreshUpgradeNotices: jest.fn(async () => summary) };
        await expect(
            new AppsCatalogUpgradeNoticeCronService(upgrades as never).runUpgradeNotices(),
        ).resolves.toEqual(summary);
        expect(upgrades.refreshUpgradeNotices).toHaveBeenCalledTimes(1);
    });

    it('runs under the per-tick lease, and a replica that loses it does nothing', async () => {
        jest.spyOn(config.everWorks.apps, 'worksEnabled').mockReturnValue(true);
        const upgrades = { refreshUpgradeNotices: jest.fn(async () => summary) };
        const held = {
            runExclusive: jest.fn(async (_key: string, fn: () => Promise<unknown>) => ({
                acquired: true,
                result: await fn(),
            })),
        };
        await expect(
            new AppsCatalogUpgradeNoticeCronService(
                upgrades as never,
                held as never,
            ).runUpgradeNotices(),
        ).resolves.toEqual(summary);
        expect(held.runExclusive).toHaveBeenCalledWith(
            APP_BLUEPRINT_NOTICE_LOCK_KEY,
            expect.any(Function),
            expect.any(Object),
        );

        const lost = { runExclusive: jest.fn(async () => ({ acquired: false })) };
        upgrades.refreshUpgradeNotices.mockClear();
        await expect(
            new AppsCatalogUpgradeNoticeCronService(
                upgrades as never,
                lost as never,
            ).runUpgradeNotices(),
        ).resolves.toBeNull();
        expect(upgrades.refreshUpgradeNotices).not.toHaveBeenCalled();
    });

    it('does nothing while App Works is off, or with no service bound', async () => {
        jest.spyOn(config.everWorks.apps, 'worksEnabled').mockReturnValue(false);
        const upgrades = { refreshUpgradeNotices: jest.fn(async () => summary) };
        await expect(
            new AppsCatalogUpgradeNoticeCronService(upgrades as never).runUpgradeNotices(),
        ).resolves.toBeNull();
        expect(upgrades.refreshUpgradeNotices).not.toHaveBeenCalled();
        await expect(
            new AppsCatalogUpgradeNoticeCronService().runUpgradeNotices(),
        ).resolves.toBeNull();
    });

    it('never throws out of a tick', async () => {
        jest.spyOn(config.everWorks.apps, 'worksEnabled').mockReturnValue(true);
        const upgrades = {
            refreshUpgradeNotices: jest.fn(async () => {
                throw new Error('database down');
            }),
        };
        await expect(
            new AppsCatalogUpgradeNoticeCronService(upgrades as never).runUpgradeNotices(),
        ).resolves.toBeNull();
    });
});
