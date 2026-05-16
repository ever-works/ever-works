import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { ZeroFrictionFunnelPayload } from '@ever-works/contracts/telemetry';

/**
 * Minimal contract for a PostHog-style analytics client. Mirrors the
 * signature on `@ever-works/monitoring`'s `AnalyticsService.track()`
 * without taking a runtime dep on that package (the agent package keeps
 * its DI graph free of `@ever-works/monitoring`).
 */
export interface FunnelAnalyticsSink {
    track(
        distinctId: string,
        event: string,
        properties?: Record<string, any>,
        groups?: Record<string, string | number>,
    ): void;
    /**
     * Optional readiness gate. When present and returning `false`, the
     * funnel skips the `.track()` call. The real `AnalyticsService`
     * exposes `isAvailable()`; we accept either name to stay tolerant
     * of future renames.
     */
    isAvailable?(): boolean;
    isInitialized?(): boolean;
}

/**
 * DI token wiring an external `AnalyticsService` (e.g. PostHog) into
 * `ZeroFrictionFunnelService` without the agent package importing the
 * monitoring package directly. Consumers (api modules) bind this token
 * to their actual `AnalyticsService` instance.
 */
export const ZERO_FRICTION_FUNNEL_ANALYTICS = Symbol('ZERO_FRICTION_FUNNEL_ANALYTICS');

/**
 * EW-617 G8 — funnel emit service.
 *
 * Every event lands as a single structured Nest log line tagged
 * `[zero-friction]` + the event name. This is the durable fallback —
 * platform log aggregation always picks it up regardless of whether
 * PostHog is configured.
 *
 * In addition, when a `FunnelAnalyticsSink` is wired in via DI
 * (typically `AnalyticsService` from `@ever-works/monitoring`), every
 * event is also forwarded to PostHog via `.track()`. The sink is
 * `@Optional()` so specs and modules that don't import monitoring keep
 * working unchanged.
 */
@Injectable()
export class ZeroFrictionFunnelService {
    private readonly logger = new Logger('ZeroFrictionFunnel');

    constructor(
        @Optional()
        @Inject(ZERO_FRICTION_FUNNEL_ANALYTICS)
        private readonly analytics?: FunnelAnalyticsSink,
    ) {}

    emit(payload: ZeroFrictionFunnelPayload): void {
        // Pin the timestamp here so call sites can omit it (it's not
        // very useful for them to set their own).
        const enriched = {
            ...payload,
            timestamp: payload.timestamp || new Date().toISOString(),
        };
        // Single JSON log line so downstream log aggregation can parse
        // each event without regex acrobatics.
        try {
            this.logger.log(`[zero-friction] ${JSON.stringify(enriched)}`);
        } catch {
            // JSON serialisation failures shouldn't take down the request.
            this.logger.log(
                `[zero-friction] event=${enriched.event} correlationId=${enriched.correlationId}`,
            );
        }

        // Mirror to PostHog (best-effort — never let analytics throw
        // bubble out of the funnel emit). Skip when the sink isn't
        // wired or reports itself as unavailable.
        if (this.analytics && this.isSinkReady(this.analytics)) {
            try {
                const distinctId =
                    (enriched as { userId?: string }).userId || enriched.correlationId;
                const { event, ...properties } = enriched;
                this.analytics.track(distinctId, event, properties);
            } catch (err) {
                this.logger.warn(
                    `[zero-friction] analytics.track failed for event=${enriched.event}: ${
                        err instanceof Error ? err.message : String(err)
                    }`,
                );
            }
        }
    }

    private isSinkReady(sink: FunnelAnalyticsSink): boolean {
        if (typeof sink.isAvailable === 'function') {
            return sink.isAvailable();
        }
        if (typeof sink.isInitialized === 'function') {
            return sink.isInitialized();
        }
        // Sink injected but doesn't advertise readiness — assume ready.
        return true;
    }
}
