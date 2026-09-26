import { Global, Module } from '@nestjs/common';
import { APP_WORKS_TELEMETRY_SINK } from '@ever-works/agent/app-works';
import { AnalyticsService } from '@ever-works/monitoring';

/**
 * APW-01 T36 — global PostHog forwarding for App Works telemetry (FR-53, plan §9.1).
 *
 * `AppWorksTelemetryService` is declared by the agent package's `AppWorksModule`,
 * which `WorkModule`, the works module and the API's App Works module all import, and
 * it injects `APP_WORKS_TELEMETRY_SINK` `@Optional()` so the agent package never
 * depends on `@ever-works/monitoring`. This `@Global()` module aliases that token to
 * `AnalyticsService` exactly as `FunnelAnalyticsBindingModule` does for the
 * zero-friction funnel: `MonitoringModule` is global at the app root, so its
 * `AnalyticsService` resolves here, and a global export is visible to the agent
 * module's providers without that module importing anything.
 *
 * `AnalyticsService.isAvailable()` answers `false` when PostHog is not configured, and
 * the telemetry service then counts and drops each event — the same answer as an
 * unbound token, so an installation without PostHog loses nothing but the events.
 */
@Global()
@Module({
    providers: [
        {
            provide: APP_WORKS_TELEMETRY_SINK,
            useExisting: AnalyticsService,
        },
    ],
    exports: [APP_WORKS_TELEMETRY_SINK],
})
export class AppWorksTelemetryBindingModule {}
