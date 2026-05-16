import { Global, Module } from '@nestjs/common';
import { ZERO_FRICTION_FUNNEL_ANALYTICS } from '@ever-works/agent/services';
import { AnalyticsService } from '@ever-works/monitoring';

/**
 * EW-617 G8 — global PostHog forwarding for the zero-friction funnel.
 *
 * `ZeroFrictionFunnelService` is registered as a provider by three
 * different modules (AuthModule, TelemetryModule, WorkModule). Each
 * instance consumes the `ZERO_FRICTION_FUNNEL_ANALYTICS` token via
 * `@Optional() @Inject(...)` to forward events to PostHog without the
 * `packages/agent` package taking a dependency on `@ever-works/monitoring`.
 *
 * Rather than binding the token in each of those modules, we declare a
 * single `@Global()` binding here that aliases the token to
 * `AnalyticsService`. MonitoringModule is also `@Global()` at the app
 * root, so its `AnalyticsService` resolves in this binding's scope and
 * Nest re-exports the token to every consumer in the tree.
 *
 * If MonitoringModule is ever unregistered (offline dev, specs), the
 * funnel service's `@Optional()` injection silently degrades to log-only
 * mode — nothing breaks.
 */
@Global()
@Module({
    providers: [
        {
            provide: ZERO_FRICTION_FUNNEL_ANALYTICS,
            useExisting: AnalyticsService,
        },
    ],
    exports: [ZERO_FRICTION_FUNNEL_ANALYTICS],
})
export class FunnelAnalyticsBindingModule {}
