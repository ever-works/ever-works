import { Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { SentryService } from '@ever-works/monitoring';
import {
    TRIGGER_WEBHOOK_EVENTS,
    TriggerWebhookInternalEventPayload,
} from '../trigger-webhook-events';

/**
 * EW-743 Phase 3 — bounded observability fanout for Trigger.dev
 * `trigger.run.failed` and `trigger.deployment.failed`.
 *
 * Surfaces each failed Trigger.dev event as a structured Sentry log
 * line (via the platform's `SentryService` from `@ever-works/monitoring`)
 * tagged with `runId`, `tenantId`, and the upstream event type, so
 * operators can grep / filter Sentry to discover Trigger.dev runs that
 * never recovered. No exception is captured — webhook failures are
 * EXPECTED workload events, not platform errors. Adding them to
 * Sentry's exceptions stream would dilute the signal-to-noise of the
 * project's real error count.
 *
 * # Constraints
 *
 *  - `SentryService` is provided by the `@Global()` `MonitoringModule`
 *    that the API root wires at startup. It is marked `@Optional()`
 *    here so unit tests can construct the subscriber without standing
 *    up the entire monitoring graph, and so a deploy that disables
 *    monitoring (offline / dev) does not refuse to construct the
 *    WebhooksModule.
 *  - When `SentryService` is absent we log the same line via the
 *    Nest `Logger` instead, so operators don't lose the observability
 *    signal in dev / test environments.
 *  - Never throws (router contract). All bodies are wrapped in
 *    try/catch.
 *  - Idempotent: a duplicate delivery produces a duplicate log line.
 *    That's fine — operators correlate by `runId` and de-dup mentally,
 *    and Sentry's own ingest pipeline rate-limits.
 *
 * # Why not addBreadcrumb()?
 *
 * Breadcrumbs are scoped to the active Sentry Hub, which on the
 * NestJS request-pipeline is the incoming HTTP request. A breadcrumb
 * added inside an EventEmitter2 handler that fires AFTER the trigger
 * webhook controller has returned would attach to a different scope
 * (or no scope at all). A structured `sentryService.error(...)` log
 * goes to the standalone logs surface and does not depend on hub
 * scoping. See the SentryService class header.
 */
@Injectable()
export class TriggerRunFailureSentryBreadcrumbSubscriber {
    private readonly logger = new Logger(TriggerRunFailureSentryBreadcrumbSubscriber.name);

    constructor(@Optional() private readonly sentry?: SentryService) {}

    @OnEvent(TRIGGER_WEBHOOK_EVENTS.RUN_FAILED)
    onRunFailed(event: TriggerWebhookInternalEventPayload): void {
        this.emit('trigger.run.failed', event, {
            runId: extractRunId(event.payload),
            errorMessage: extractErrorMessage(event.payload),
        });
    }

    @OnEvent(TRIGGER_WEBHOOK_EVENTS.DEPLOYMENT_FAILED)
    onDeploymentFailed(event: TriggerWebhookInternalEventPayload): void {
        this.emit('trigger.deployment.failed', event, {
            deploymentId: extractDeploymentId(event.payload),
            errorMessage: extractErrorMessage(event.payload),
        });
    }

    private emit(
        label: string,
        event: TriggerWebhookInternalEventPayload,
        attrs: Readonly<Record<string, string | null>>,
    ): void {
        try {
            const sanitizedAttrs: Record<string, string> = {
                upstreamEventType: event.upstreamEventType,
                internalEventName: event.internalEventName,
                tenantId: event.tenantId,
                createdAt: event.createdAt,
            };
            for (const [key, value] of Object.entries(attrs)) {
                if (value) {
                    sanitizedAttrs[key] = value;
                }
            }

            const message = `${label} (tenantId=${event.tenantId})`;

            if (this.sentry) {
                this.sentry.error(message, sanitizedAttrs);
            } else {
                // No SentryService bound (offline dev / test). Keep the
                // signal — same fields, just routed through Nest Logger.
                this.logger.warn(
                    `${message} ${JSON.stringify(sanitizedAttrs)} ` +
                        `(SentryService not bound; operators see this in Nest logs only)`,
                );
            }
        } catch (err) {
            // MUST NOT throw — router contract.
            this.logger.error(
                `Sentry breadcrumb subscriber failed for ${label}: ` +
                    `${(err as Error).message ?? String(err)}`,
                (err as Error).stack,
            );
        }
    }
}

function extractRunId(payload: Readonly<Record<string, unknown>>): string | null {
    const run = (payload as { run?: unknown }).run;
    if (!run || typeof run !== 'object') return null;
    const id = (run as { id?: unknown }).id;
    return typeof id === 'string' && id.length > 0 ? id : null;
}

function extractDeploymentId(payload: Readonly<Record<string, unknown>>): string | null {
    const deployment = (payload as { deployment?: unknown }).deployment;
    if (!deployment || typeof deployment !== 'object') return null;
    const id = (deployment as { id?: unknown }).id;
    return typeof id === 'string' && id.length > 0 ? id : null;
}

function extractErrorMessage(payload: Readonly<Record<string, unknown>>): string | null {
    const run = (payload as { run?: unknown }).run;
    if (run && typeof run === 'object') {
        const error = (run as { error?: unknown }).error;
        if (error && typeof error === 'object') {
            const message = (error as { message?: unknown }).message;
            if (typeof message === 'string' && message.length > 0) {
                return message.length > 512 ? `${message.slice(0, 512)}…` : message;
            }
        }
    }
    const deployment = (payload as { deployment?: unknown }).deployment;
    if (deployment && typeof deployment === 'object') {
        const error = (deployment as { error?: unknown }).error;
        if (error && typeof error === 'object') {
            const message = (error as { message?: unknown }).message;
            if (typeof message === 'string' && message.length > 0) {
                return message.length > 512 ? `${message.slice(0, 512)}…` : message;
            }
        }
    }
    return null;
}
