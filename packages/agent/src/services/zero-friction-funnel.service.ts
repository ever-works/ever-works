import { Injectable, Logger } from '@nestjs/common';
import type { ZeroFrictionFunnelPayload } from '@ever-works/contracts/telemetry';

/**
 * EW-617 G8 — funnel emit service.
 *
 * Stage one keeps the emit surface tiny: every event lands as a single
 * structured Nest log line tagged `[zero-friction]` + the event name.
 * The existing platform log pipeline picks that up; downstream the ops
 * team can either grep raw logs, build a PostHog "Insights" view from
 * the JSON, or wire a custom OpenTelemetry exporter later.
 *
 * Why not call PostHog directly here?
 *   - PostHogModule today only exposes an `isInitialized` flag — no
 *     `capture()` helper yet.
 *   - Adding the dependency cleanly would require either client
 *     instantiation logic or a global module hookup, neither of which
 *     I want to do in the same PR that defines the schema.
 *
 * A follow-up PR can swap the log call for a real PostHog/Open-
 * Telemetry sink without changing any of the emit call sites.
 */
@Injectable()
export class ZeroFrictionFunnelService {
    private readonly logger = new Logger('ZeroFrictionFunnel');

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
    }
}
