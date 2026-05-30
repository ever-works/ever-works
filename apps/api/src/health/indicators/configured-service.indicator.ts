import { Injectable } from '@nestjs/common';
import { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import { ServiceStatus } from '../service-detection';

/**
 * Informational indicator for third-party integrations (AI provider, Sentry,
 * PostHog, Trigger.dev, Stripe, email, storage).
 *
 * It ALWAYS reports `up` — it surfaces *whether the service is configured* and
 * a coarse mode label, but never pings the remote and never fails the
 * aggregate readiness. We don't want a transient outage at PostHog/Sentry to
 * flip the pod out of the load balancer; those are best-effort dependencies,
 * not readiness gates.
 */
@Injectable()
export class ConfiguredServiceHealthIndicator {
    constructor(private readonly healthIndicatorService: HealthIndicatorService) {}

    report(status: ServiceStatus): HealthIndicatorResult {
        return this.healthIndicatorService.check(status.key).up({
            configured: status.configured,
            mode: status.mode,
        });
    }
}
