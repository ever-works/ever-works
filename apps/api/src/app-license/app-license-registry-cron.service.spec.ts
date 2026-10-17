import { APPS_CATALOG_REFRESH_CRON } from '@ever-works/contracts';
import { config } from '@ever-works/agent/config';
import { SCHEDULE_CRON_OPTIONS } from '@nestjs/schedule/dist/schedule.constants';
import {
    APP_LICENSE_REGISTRY_FANOUT_LOCK_KEY,
    AppLicenseRegistryCronService,
} from './app-license-registry-cron.service';

describe('AppLicenseRegistryCronService (APW-03 T43)', () => {
    afterEach(() => jest.restoreAllMocks());

    it('runs on the Apps-catalog refresh schedule', () => {
        const metadata = Reflect.getMetadata(
            SCHEDULE_CRON_OPTIONS,
            AppLicenseRegistryCronService.prototype.runRegistryFanOut,
        ) as { cronTime?: string } | undefined;
        expect(metadata?.cronTime).toBe(APPS_CATALOG_REFRESH_CRON);
    });

    it('re-classifies the stale rows when App Works is on', async () => {
        jest.spyOn(config.everWorks.apps, 'worksEnabled').mockReturnValue(true);
        const licenses = {
            refreshStaleRegistry: jest.fn(async () => ({ scanned: 3, evaluated: 3 })),
        };
        const cron = new AppLicenseRegistryCronService(licenses as never);
        await expect(cron.runRegistryFanOut()).resolves.toEqual({ scanned: 3, evaluated: 3 });
        expect(licenses.refreshStaleRegistry).toHaveBeenCalledTimes(1);
    });

    it('runs under the per-tick lease, and a replica that loses it does nothing', async () => {
        jest.spyOn(config.everWorks.apps, 'worksEnabled').mockReturnValue(true);
        const licenses = {
            refreshStaleRegistry: jest.fn(async () => ({ scanned: 1, evaluated: 1 })),
        };
        const held = {
            runExclusive: jest.fn(async (_k: string, fn: () => Promise<unknown>) => ({
                acquired: true,
                result: await fn(),
            })),
        };
        await expect(
            new AppLicenseRegistryCronService(licenses as never, held as never).runRegistryFanOut(),
        ).resolves.toEqual({ scanned: 1, evaluated: 1 });
        expect(held.runExclusive).toHaveBeenCalledWith(
            APP_LICENSE_REGISTRY_FANOUT_LOCK_KEY,
            expect.any(Function),
            expect.any(Object),
        );

        const lost = { runExclusive: jest.fn(async () => ({ acquired: false })) };
        licenses.refreshStaleRegistry.mockClear();
        await expect(
            new AppLicenseRegistryCronService(licenses as never, lost as never).runRegistryFanOut(),
        ).resolves.toBeNull();
        expect(licenses.refreshStaleRegistry).not.toHaveBeenCalled();
    });

    it('reads nothing when App Works is off, and never throws', async () => {
        jest.spyOn(config.everWorks.apps, 'worksEnabled').mockReturnValue(false);
        const licenses = { refreshStaleRegistry: jest.fn() };
        await expect(
            new AppLicenseRegistryCronService(licenses as never).runRegistryFanOut(),
        ).resolves.toBeNull();
        expect(licenses.refreshStaleRegistry).not.toHaveBeenCalled();

        jest.spyOn(config.everWorks.apps, 'worksEnabled').mockReturnValue(true);
        const failing = {
            refreshStaleRegistry: jest.fn(async () => {
                throw new Error('db down');
            }),
        };
        await expect(
            new AppLicenseRegistryCronService(failing as never).runRegistryFanOut(),
        ).resolves.toBeNull();
    });
});
