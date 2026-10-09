import { Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AnalyticsService, SentryService } from '@ever-works/monitoring';
import { FleetJobCompletedEvent, FleetJobLeasedEvent } from '@ever-works/agent/events';
import { isFleetAgentExecutionProvider, type FleetJobView } from '@ever-works/contracts';

/**
 * Self-build slice AP — fleet run lifecycle telemetry.
 *
 * Neither PostHog nor Sentry knew the fleet existed: a run leased by a PC,
 * twenty minutes of work, a failure — none of it reached the two places the
 * platform's operators actually look. This listener emits one event per
 * lifecycle transition through the platform's EXISTING abstractions
 * (`AnalyticsService` → PostHog, `SentryService` → Sentry structured logs,
 * both provided app-wide by `MonitoringModule.forRoot`), so no new vendor
 * SDK and no new configuration: an install without PostHog / Sentry keys
 * gets the same no-ops every other caller of those services gets.
 *
 * ## What is sent, and what never is
 *
 * Identifiers, the job kind, the completion source, timings, attempts, the
 * CLI's provider and verdict, the cost the CLI reported, and the size of
 * the step record — {@link fleetRunTelemetryProperties} is the ONE place the
 * property bag is built. Never the payload (the assembled prompt), never the
 * result's text (summary, transcript, tails), never the node's error string:
 * all three are user- or model-authored and the analytics pipeline is not a
 * place secrets or customer content should ever travel to.
 *
 * ## Why a listener
 *
 * Same reason as `FleetMcpCredentialListener`: every terminal path —
 * a node's report, an operator cancel, an exhausted lease, the queue SLA —
 * already converges on `FleetJobCompletedEvent`, and the lease on
 * `FleetJobLeasedEvent`. Two subscriptions cover the whole lifecycle and
 * add nothing to `FleetJobService`.
 *
 * Best-effort by construction: telemetry is never allowed to throw into the
 * event bus.
 */

/** The PostHog event names (snake_case, like `budget_threshold_crossed`). */
export const FLEET_RUN_TELEMETRY_EVENTS = {
    leased: 'fleet_run_leased',
    completed: 'fleet_run_completed',
    failed: 'fleet_run_failed',
    cancelled: 'fleet_run_cancelled',
} as const;

export type FleetRunLifecycle = keyof typeof FLEET_RUN_TELEMETRY_EVENTS;

@Injectable()
export class FleetRunTelemetryListener {
    private readonly logger = new Logger(FleetRunTelemetryListener.name);

    constructor(
        @Optional() private readonly analytics?: AnalyticsService,
        @Optional() private readonly sentry?: SentryService,
    ) {}

    @OnEvent(FleetJobLeasedEvent.EVENT_NAME, { async: true })
    onLeased(event: FleetJobLeasedEvent): void {
        this.emit('leased', event.userId, fleetRunTelemetryProperties(event.job, event.nodeId));
    }

    @OnEvent(FleetJobCompletedEvent.EVENT_NAME, { async: true })
    onCompleted(event: FleetJobCompletedEvent): void {
        const lifecycle = classifyFleetRunCompletion(event);
        this.emit(
            lifecycle,
            event.userId,
            fleetRunTelemetryProperties(event.job, event.nodeId, event.source, event.result),
        );
    }

    private emit(
        lifecycle: FleetRunLifecycle,
        userId: string,
        properties: Record<string, unknown>,
    ): void {
        const name = FLEET_RUN_TELEMETRY_EVENTS[lifecycle];
        try {
            this.analytics?.track(userId, name, properties);
        } catch (error) {
            this.warn(`analytics event ${name}`, error);
        }
        try {
            const message = `fleet.run.${lifecycle}`;
            // A failed run is a fact about the owner's code, not a platform
            // error: a structured WARN log, never `captureException`, so it
            // cannot open an issue or page anyone.
            if (lifecycle === 'failed') this.sentry?.warn(message, properties);
            else this.sentry?.info(message, properties);
        } catch (error) {
            this.warn(`Sentry log ${name}`, error);
        }
    }

    private warn(what: string, error: unknown): void {
        this.logger.warn(
            `Fleet run telemetry: ${what} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

/**
 * Which lifecycle event a completion is. Cancelled wins (an operator's
 * cancel, or a node whose report landed after the cancel flag — the same
 * three arrivals the reconciler treats as cancelled); then a job the
 * service settled `done` whose node did not report its OWN run as failed
 * is `completed`; everything else is `failed`.
 */
export function classifyFleetRunCompletion(event: FleetJobCompletedEvent): FleetRunLifecycle {
    if (event.source === 'cancelled' || event.job?.cancelRequestedAt) return 'cancelled';
    const reported = asRecord(event.result);
    if (event.job?.status === 'done' && reported?.status !== 'failed') return 'completed';
    return 'failed';
}

/**
 * The ONE property bag every fleet run event carries. Built from row
 * metadata and from the result's NUMBERS and fixed vocabularies only — see
 * the class comment for what is deliberately never read.
 */
export function fleetRunTelemetryProperties(
    job: FleetJobView,
    nodeId: string | null,
    source?: string,
    result?: Record<string, unknown> | null,
): Record<string, unknown> {
    const properties: Record<string, unknown> = {
        jobId: job.id,
        kind: job.kind,
        nodeId: nodeId ?? job.nodeId ?? null,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
    };
    if (typeof job.leaseGeneration === 'number') properties.leaseGeneration = job.leaseGeneration;
    if (source) properties.source = source;
    const queuedMs = elapsedMs(job.queuedAt ?? job.createdAt, job.startedAt);
    if (queuedMs !== null) properties.queuedMs = queuedMs;
    const durationMs = elapsedMs(job.startedAt, job.completedAt);
    if (durationMs !== null) properties.durationMs = durationMs;

    const reported = asRecord(result);
    if (reported) {
        if (reported.status === 'succeeded' || reported.status === 'failed') {
            properties.resultStatus = reported.status;
        }
        if (isGate(reported.gateStatus)) properties.gateStatus = reported.gateStatus;
        if (isGate(reported.setupStatus)) properties.setupStatus = reported.setupStatus;
        const model = asRecord(reported.model);
        if (model) {
            if (isFleetAgentExecutionProvider(model.provider)) properties.provider = model.provider;
            if (
                model.status === 'succeeded' ||
                model.status === 'failed' ||
                model.status === 'timeout' ||
                model.status === 'error'
            ) {
                properties.modelStatus = model.status;
            }
            const numbers = ['costUsd', 'turns', 'totalTokens', 'durationMs'] as const;
            for (const key of numbers) {
                const value = model[key];
                if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
                    properties[key === 'durationMs' ? 'modelDurationMs' : key] = value;
                }
            }
            if (Array.isArray(model.timeline)) properties.timelineSteps = model.timeline.length;
        }
        if (asRecord(reported.question)) properties.askedQuestion = true;
        const git = asRecord(reported.git);
        if (git && typeof git.pushed === 'boolean') properties.pushed = git.pushed;
    }
    return properties;
}

function elapsedMs(from: string | null | undefined, to: string | null | undefined): number | null {
    if (!from || !to) return null;
    const start = Date.parse(from);
    const end = Date.parse(to);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
    return end - start;
}

function isGate(value: unknown): value is 'green' | 'red' | 'none' {
    return value === 'green' || value === 'red' || value === 'none';
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}
