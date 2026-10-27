import { Inject, Injectable, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
    APP_WORKS_TELEMETRY_SINK,
    AppWorksTelemetryService,
    type AppWorksTelemetrySink,
    type AppWorksTelemetryStats,
} from '../app-works/app-works-telemetry.service';

/**
 * APW-06 T55 and APW-07 T39's dependency half (lane aw-builds-bindings, 2026-10-27) — App runtime
 * telemetry, emitted in the API off the `app.*` events the isolated worker relays.
 *
 * ## Why a listener in the API
 *
 * The deploy orchestrator, the smoke run, the lifecycle ops, the health poll and the dependency
 * provider all run in the isolated worker, which has no analytics client. Each of them already
 * emits its outcome through `APP_RUNTIME_EVENT_SINK`; the API's `AppRuntimeEventRelayService`
 * re-emits a catalogued, forbidden-key-checked event on `EventEmitter2`, and
 * `AppRuntimeActivityListener` writes the Activity row from it. This listener reads the same
 * events, so telemetry fires exactly when the feed does, from one place, with no RPC of its own.
 *
 * ## Codes, counters and flags only (T55's "no payload contains…", APW-07 §9.1)
 *
 * The relayed payloads carry component and job NAMES (`names`), Deployment and Build ids and the
 * owner's user id. None of those reaches a property: each event below copies a closed set of
 * codes (`target`, `phase`, `code`, `kind`, `providerId`, `reason`) and counts, and APW-01's
 * sanitizer drops any string that is not code-shaped. The user id is the distinct id. Never a
 * hostname, URL, namespace, env name or value, kubeconfig fragment or log text.
 *
 * ## Not emitted here
 *
 * "Deploy requested" and "cluster check outcome" happen in the API itself (the request service
 * and the target check) rather than in a relayed event; they are not covered by this listener.
 */

/** The events this listener emits, by the names the analytics backend receives. */
export const APP_RUNTIME_TELEMETRY_EVENTS = {
    deployStarted: 'app_deploy_started',
    deployOutcome: 'app_deploy_outcome',
    jobOutcome: 'app_job_outcome',
    smokeOutcome: 'app_smoke_outcome',
    healthTransition: 'app_health_transition',
    lifecycleAction: 'app_lifecycle_action',
    workDeletionOutcome: 'app_work_deletion_outcome',
    dependencyProvisioned: 'app_dependency_provisioned',
    dependencyFailed: 'app_dependency_failed',
    dependencyDataDeleted: 'app_dependency_data_deleted',
} as const;

export type AppRuntimeTelemetryEvent =
    (typeof APP_RUNTIME_TELEMETRY_EVENTS)[keyof typeof APP_RUNTIME_TELEMETRY_EVENTS];

/** The `reason` an App Work deletion's `app.deploy.removed` carries (`app-runtime-deletion.service.ts`). */
const APP_WORK_DELETED_REASON = 'app_work_deleted';

type Payload = Record<string, unknown> | null | undefined;

function code(value: unknown): string | null {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function count(value: unknown): number {
    if (Array.isArray(value)) return value.length;
    const number = typeof value === 'string' ? Number(value) : value;
    return typeof number === 'number' && Number.isFinite(number) && number >= 0 ? number : 0;
}

@Injectable()
export class AppRuntimeTelemetryListener {
    private readonly inner: AppWorksTelemetryService;

    constructor(
        @Optional()
        @Inject(APP_WORKS_TELEMETRY_SINK)
        sink?: AppWorksTelemetrySink,
    ) {
        this.inner = new AppWorksTelemetryService(sink);
    }

    /** A copy of the counters, for diagnostics and specs. */
    stats(): AppWorksTelemetryStats {
        return this.inner.stats();
    }

    private track(
        event: AppRuntimeTelemetryEvent,
        properties: Record<string, unknown>,
        payload: Payload,
    ): void {
        this.inner.trackEvent(event, properties, code(payload?.userId));
    }

    // ── Deployments ───────────────────────────────────────────────────────────

    @OnEvent('app.deploy.started', { async: true })
    onDeployStarted(payload: Payload): void {
        this.track(
            APP_RUNTIME_TELEMETRY_EVENTS.deployStarted,
            { target: code(payload?.target) },
            payload,
        );
    }

    @OnEvent('app.deploy.succeeded', { async: true })
    onDeploySucceeded(payload: Payload): void {
        this.deployOutcome('succeeded', payload);
    }

    @OnEvent('app.deploy.failed', { async: true })
    onDeployFailed(payload: Payload): void {
        this.deployOutcome('failed', payload);
    }

    @OnEvent('app.deploy.rolled_back', { async: true })
    onDeployRolledBack(payload: Payload): void {
        this.deployOutcome('rolled_back', payload);
    }

    private deployOutcome(outcome: 'succeeded' | 'failed' | 'rolled_back', payload: Payload): void {
        this.track(
            APP_RUNTIME_TELEMETRY_EVENTS.deployOutcome,
            {
                outcome,
                target: code(payload?.target),
                phase: code(payload?.phase),
                code: code(payload?.code),
            },
            payload,
        );
    }

    // ── Jobs and smoke ────────────────────────────────────────────────────────

    @OnEvent('app.job.succeeded', { async: true })
    onJobSucceeded(payload: Payload): void {
        this.track(APP_RUNTIME_TELEMETRY_EVENTS.jobOutcome, { outcome: 'succeeded' }, payload);
    }

    @OnEvent('app.job.failed', { async: true })
    onJobFailed(payload: Payload): void {
        this.track(APP_RUNTIME_TELEMETRY_EVENTS.jobOutcome, { outcome: 'failed' }, payload);
    }

    @OnEvent('app.smoke.passed', { async: true })
    onSmokePassed(payload: Payload): void {
        this.smokeOutcome('passed', payload);
    }

    @OnEvent('app.smoke.failed', { async: true })
    onSmokeFailed(payload: Payload): void {
        this.smokeOutcome('failed', payload);
    }

    private smokeOutcome(outcome: 'passed' | 'failed', payload: Payload): void {
        this.track(
            APP_RUNTIME_TELEMETRY_EVENTS.smokeOutcome,
            {
                outcome,
                // `smoke_warnings` is the one code a smoke event carries (warnings only, nothing failed).
                classification: code(payload?.code),
                checks: count(payload?.names),
            },
            payload,
        );
    }

    // ── Health ────────────────────────────────────────────────────────────────

    @OnEvent('app.health.degraded', { async: true })
    onHealthDegraded(payload: Payload): void {
        this.healthTransition('degraded', payload);
    }

    @OnEvent('app.health.recovered', { async: true })
    onHealthRecovered(payload: Payload): void {
        this.healthTransition('recovered', payload);
    }

    @OnEvent('app.health.unreachable', { async: true })
    onHealthUnreachable(payload: Payload): void {
        this.healthTransition('unreachable', payload);
    }

    private healthTransition(to: 'degraded' | 'recovered' | 'unreachable', payload: Payload): void {
        this.track(
            APP_RUNTIME_TELEMETRY_EVENTS.healthTransition,
            { to, target: code(payload?.target), code: code(payload?.code) },
            payload,
        );
    }

    // ── Lifecycle and deletion ────────────────────────────────────────────────

    @OnEvent('app.deploy.paused', { async: true })
    onPaused(payload: Payload): void {
        this.track(APP_RUNTIME_TELEMETRY_EVENTS.lifecycleAction, { action: 'pause' }, payload);
    }

    @OnEvent('app.deploy.resumed', { async: true })
    onResumed(payload: Payload): void {
        this.track(APP_RUNTIME_TELEMETRY_EVENTS.lifecycleAction, { action: 'resume' }, payload);
    }

    @OnEvent('app.deploy.removed', { async: true })
    onRemoved(payload: Payload): void {
        if (code(payload?.reason) === APP_WORK_DELETED_REASON) {
            this.track(
                APP_RUNTIME_TELEMETRY_EVENTS.workDeletionOutcome,
                {
                    code: code(payload?.code),
                    deletedCount: count(payload?.deletedCount),
                    keptCount: count(payload?.kept),
                    mayRemainCount: count(payload?.mayRemain),
                },
                payload,
            );
            return;
        }
        this.track(APP_RUNTIME_TELEMETRY_EVENTS.lifecycleAction, { action: 'remove' }, payload);
    }

    // ── APW-07's dependency events (plan §9.1) ────────────────────────────────

    @OnEvent('app.dependency.provisioned', { async: true })
    onDependencyProvisioned(payload: Payload): void {
        this.track(
            APP_RUNTIME_TELEMETRY_EVENTS.dependencyProvisioned,
            { kind: code(payload?.kind), providerId: code(payload?.providerId) },
            payload,
        );
    }

    @OnEvent('app.dependency.failed', { async: true })
    onDependencyFailed(payload: Payload): void {
        this.track(
            APP_RUNTIME_TELEMETRY_EVENTS.dependencyFailed,
            {
                kind: code(payload?.kind),
                providerId: code(payload?.providerId),
                reason: code(payload?.reason),
            },
            payload,
        );
    }

    @OnEvent('app.dependency.data_deleted', { async: true })
    onDependencyDataDeleted(payload: Payload): void {
        this.track(
            APP_RUNTIME_TELEMETRY_EVENTS.dependencyDataDeleted,
            { kind: code(payload?.kind) },
            payload,
        );
    }
}
