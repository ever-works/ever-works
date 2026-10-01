import { Injectable, Optional } from '@nestjs/common';
import { AnalyticsService } from '@ever-works/monitoring';

/**
 * APW-12 (Ever ID) — the closed set of telemetry events (plan §9.1). Counters
 * and ids only: no event ever carries an e-mail address, a subject, an issuer
 * URL, a client secret, a token, an authorization code or a `state`
 * (NFR-8, ACC-12-37).
 */
export const EVER_ID_TELEMETRY_EVENTS = {
    SIGN_IN_STARTED: 'ever_id.sign_in.started',
    SIGN_IN_COMPLETED: 'ever_id.sign_in.completed',
    SIGN_UP_CONFIRMED: 'ever_id.sign_up.confirmed',
    IDENTITY_LINKED: 'ever_id.identity.linked',
    IDENTITY_UNLINKED: 'ever_id.identity.unlinked',
    BACKCHANNEL_RECEIVED: 'ever_id.backchannel.received',
    DEVICE_EXCHANGED: 'ever_id.device.exchanged',
    DELEGATED_READ: 'ever_id.delegated.read',
    PROVIDER_UNAVAILABLE: 'ever_id.provider.unavailable',
} as const;

export type EverIdTelemetryEvent =
    (typeof EVER_ID_TELEMETRY_EVENTS)[keyof typeof EVER_ID_TELEMETRY_EVENTS];

/** The only property values an event may carry: numbers, booleans and short closed-set labels. */
export type EverIdTelemetryProperties = Record<string, string | number | boolean>;

/** A label value: a closed-set word such as `signedIn`, `cli`, `sid` — never free text. */
const LABEL = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;

/** The distinct id used when an event is not about a known account (FR-50). */
export const EVER_ID_TELEMETRY_ANONYMOUS_ID = 'ever-id';

/**
 * Sends the §9.1 events through the platform's analytics service when one is
 * bound (no-op otherwise). Every string property is checked against a
 * closed-label pattern before it leaves, so free text — an address, a URL, a
 * token — can never ride along by mistake (FR-16).
 */
@Injectable()
export class EverIdTelemetryService {
    constructor(@Optional() private readonly analytics?: AnalyticsService) {}

    emit(event: EverIdTelemetryEvent, properties: EverIdTelemetryProperties = {}, userId?: string) {
        if (!this.analytics) return;
        const safe = sanitize(properties);
        try {
            this.analytics.track(userId || EVER_ID_TELEMETRY_ANONYMOUS_ID, event, safe);
        } catch {
            // Telemetry never fails a request.
        }
    }
}

/** Drop any property that is not a finite number, a boolean or a closed-set label. */
export function sanitize(properties: EverIdTelemetryProperties): EverIdTelemetryProperties {
    const out: EverIdTelemetryProperties = {};
    for (const [key, value] of Object.entries(properties)) {
        if (typeof value === 'boolean') out[key] = value;
        else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
        else if (typeof value === 'string' && LABEL.test(value)) out[key] = value;
    }
    return out;
}
