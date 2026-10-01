import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Global, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AnalyticsService } from '@ever-works/monitoring';
import {
    APP_WORKS_TELEMETRY_EVENTS,
    APP_WORKS_TELEMETRY_SINK,
    AppWorksTelemetryService,
} from '@ever-works/agent/app-works';
import { AppWorksTelemetryBindingModule } from './app-works-telemetry-binding.module';

/**
 * APW-01 T36 — the API binds App Works telemetry to PostHog (FR-53, plan §9.1).
 *
 * Three facts, each a way the events could silently go nowhere:
 *
 *   1. the module is `@Global()` and aliases `APP_WORKS_TELEMETRY_SINK` to
 *      `AnalyticsService` — a non-global binding would be invisible to the agent
 *      package's `AppWorksModule`, which imports nothing from the API;
 *   2. through a real container, an event reaches `AnalyticsService.track` from a
 *      service declared in a module that does NOT import the binding (the agent
 *      module's position), and an unconfigured PostHog (`isAvailable() === false`)
 *      drops it instead of calling `track`;
 *   3. `ApiModule` imports the binding beside `FunnelAnalyticsBindingModule` — read as
 *      text, because compiling the whole API root is a different test.
 */

/** Stands in for `MonitoringModule`, which is `@Global()` at the app root. */
function monitoringModule(analytics: { track: jest.Mock; isAvailable: () => boolean }) {
    @Global()
    @Module({
        providers: [{ provide: AnalyticsService, useValue: analytics }],
        exports: [AnalyticsService],
    })
    class FakeMonitoringModule {}
    return FakeMonitoringModule;
}

/** A consumer in its own module that imports neither the binding nor monitoring. */
@Injectable()
class Emitter {
    constructor(readonly telemetry: AppWorksTelemetryService) {}
}

@Module({ providers: [AppWorksTelemetryService, Emitter], exports: [Emitter] })
class ConsumerModule {}

describe('AppWorksTelemetryBindingModule', () => {
    it('is @Global() and aliases the sink token to AnalyticsService', () => {
        expect(Reflect.getMetadata('__module:global__', AppWorksTelemetryBindingModule)).toBe(true);
        expect(Reflect.getMetadata('providers', AppWorksTelemetryBindingModule)).toEqual([
            { provide: APP_WORKS_TELEMETRY_SINK, useExisting: AnalyticsService },
        ]);
        expect(Reflect.getMetadata('exports', AppWorksTelemetryBindingModule)).toEqual([
            APP_WORKS_TELEMETRY_SINK,
        ]);
    });

    it('forwards an event from a module that never imported it to AnalyticsService.track', async () => {
        const analytics = { track: jest.fn(), isAvailable: () => true };
        const moduleRef = await Test.createTestingModule({
            imports: [monitoringModule(analytics), AppWorksTelemetryBindingModule, ConsumerModule],
        }).compile();

        moduleRef
            .get(Emitter)
            .telemetry.track(
                APP_WORKS_TELEMETRY_EVENTS.createStarted,
                { mode: 'fork', deployTarget: 'none', adoptedExistingFork: false },
                'user-1',
            );

        expect(analytics.track).toHaveBeenCalledTimes(1);
        expect(analytics.track).toHaveBeenCalledWith('user-1', 'app_work.create_started', {
            mode: 'fork',
            deployTarget: 'none',
            adoptedExistingFork: false,
        });

        await moduleRef.close();
    });

    it('drops the event when PostHog is not configured (isAvailable() is false)', async () => {
        const analytics = { track: jest.fn(), isAvailable: () => false };
        const moduleRef = await Test.createTestingModule({
            imports: [monitoringModule(analytics), AppWorksTelemetryBindingModule, ConsumerModule],
        }).compile();

        const { telemetry } = moduleRef.get(Emitter);
        telemetry.track(
            APP_WORKS_TELEMETRY_EVENTS.deleted,
            { mode: 'link', repositoryDeleted: false },
            'user-1',
        );

        expect(analytics.track).not.toHaveBeenCalled();
        expect(telemetry.stats()).toMatchObject({ emitted: 0, dropped: 1 });

        await moduleRef.close();
    });

    it('is imported by ApiModule next to FunnelAnalyticsBindingModule', () => {
        const apiModule = readFileSync(join(__dirname, '..', 'api.module.ts'), 'utf8').replace(
            /\s+/g,
            '',
        );

        // `indexOf` rather than `toContain`, so a failure prints a number and not the
        // whole root module.
        expect(
            apiModule.indexOf(
                "import{AppWorksTelemetryBindingModule}from'./telemetry/app-works-telemetry-binding.module';",
            ),
        ).toBeGreaterThan(-1);
        expect(
            apiModule.indexOf('FunnelAnalyticsBindingModule,AppWorksTelemetryBindingModule,'),
        ).toBeGreaterThan(-1);
    });
});
