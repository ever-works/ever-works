import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
    APP_BUILD_RUNNER_CLASSES,
    type AppBuildBlockedReason,
    type AppBuildEventPayload,
    type AppBuildFailureClass,
    type AppBuildPrepareWorkflowState,
    type AppBuildRunnerClass,
    type AppBuildRunSource,
    type AppBuildStatus,
    type AppBuildTrigger,
    type AppBuildWebhookState,
} from '@ever-works/contracts';
import {
    APP_WORKS_TELEMETRY_SINK,
    AppWorksTelemetryService,
    type AppWorksTelemetrySink,
    type AppWorksTelemetryStats,
} from '../app-works/app-works-telemetry.service';
import { AppBuildRepository } from '../database/repositories/app-build.repository';

/**
 * APW-05 T38 (C-17, lane aw-builds-bindings, 2026-10-27) — the Builds telemetry of plan §9.1.
 *
 * ## The pattern, reused rather than re-made
 *
 * APW-01 T36's {@link AppWorksTelemetryService} is the programme's one telemetry service: an
 * `@Optional()` sink token (`APP_WORKS_TELEMETRY_SINK`) that the API binds to its analytics
 * client with a `@Global()` alias, because `packages/agent` takes no dependency on the
 * monitoring package. This file owns the eleven Builds events and their typed payloads and
 * hands every one to that service's sanitizer (`trackEvent`), so the three rules there hold
 * here too: unbound is supported (events are counted and dropped), telemetry never fails the
 * operation it observes, and only codes, counters and flags leave the process.
 *
 * Every Builds job runs in the API process (the worker's `app-build-*` tasks are remote
 * proxies of the API's runners), so the API's global sink reaches all of them.
 *
 * ## What never appears (plan §9.1's last sentence, and the spec that pins it)
 *
 * No env or check names, no repository names, no commit messages or shas, no check commands,
 * no log lines, no tokens. Each payload type admits closed codes, counters and booleans only;
 * the user id travels as the analytics distinct id, never as a property.
 *
 * ## Who emits what
 *
 * | Event | Emitted by |
 * | --- | --- |
 * | `app_build_recorded`, `app_build_terminal` | {@link AppBuildsTelemetryListener}, off the `app.build.*` events `AppBuildsService.publish` already emits |
 * | `app_build_blocked` | `AppBuildPrepareRunner` (a requested Build blocked) and `AppBuildsService` (a verification blocked) |
 * | `app_build_rebuild_requested`, `app_build_dispatch_fallback` | `AppBuildsService` |
 * | `app_build_workflow_written`, `app_build_checks_written`, `app_build_webhook` | `AppBuildPrepareRunner` |
 * | `app_build_pull_token_validated` | `AppBuildPullTokenService` |
 * | `app_build_sweep_tick` | `AppBuildSweepService` |
 * | `app_build_runs_discovered` | `AppBuildRunDiscoveryService` |
 */

/** The eleven events of plan §9.1, by the names the analytics backend receives. */
export const APP_BUILD_TELEMETRY_EVENTS = {
    recorded: 'app_build_recorded',
    terminal: 'app_build_terminal',
    blocked: 'app_build_blocked',
    rebuildRequested: 'app_build_rebuild_requested',
    workflowWritten: 'app_build_workflow_written',
    pullTokenValidated: 'app_build_pull_token_validated',
    sweepTick: 'app_build_sweep_tick',
    checksWritten: 'app_build_checks_written',
    runsDiscovered: 'app_build_runs_discovered',
    webhook: 'app_build_webhook',
    dispatchFallback: 'app_build_dispatch_fallback',
} as const;

export type AppBuildTelemetryEvent =
    (typeof APP_BUILD_TELEMETRY_EVENTS)[keyof typeof APP_BUILD_TELEMETRY_EVENTS];

/**
 * Plan §9.1's duration buckets (<5, 5–15, 15–30, 30–60, >60 min), spelled as codes: the
 * sanitizer keeps only `[A-Za-z0-9_.-]`, so `<5` would be dropped as a non-code.
 */
export const APP_BUILD_DURATION_BUCKETS = ['lt5', '5to15', '15to30', '30to60', 'gt60'] as const;
export type AppBuildDurationBucket = (typeof APP_BUILD_DURATION_BUCKETS)[number];

/** `app_build_workflow_written.path` — plan §9.1. */
export type AppBuildWorkflowWrittenPath = 'commit' | 'pullRequest' | 'editedByHand';

/** `app_build_pull_token_validated.result` — plan §9.1. */
export type AppBuildPullTokenValidationResult = 'ok' | 'tooBroad' | 'cannotRead';

/** Each event's properties — plan §9.1, one key per listed field. */
export interface AppBuildTelemetryPayloads {
    app_build_recorded: { trigger: AppBuildTrigger };
    app_build_terminal: {
        status: AppBuildStatus;
        failureClass: AppBuildFailureClass | null;
        /** `null` when the Build carries no duration (cancelled before it ran). */
        durationBucket: AppBuildDurationBucket | null;
        runnerClass: AppBuildRunnerClass | null;
    };
    app_build_blocked: { reason: AppBuildBlockedReason };
    app_build_rebuild_requested: { deduped: boolean };
    app_build_workflow_written: { path: AppBuildWorkflowWrittenPath };
    app_build_pull_token_validated: { result: AppBuildPullTokenValidationResult };
    app_build_sweep_tick: { observed: number; lost: number; verifySecretsRemoved: number };
    app_build_checks_written: { count: number; advisory: number; checksOnly: boolean };
    app_build_runs_discovered: { recorded: number; notModified: boolean; source: AppBuildRunSource };
    app_build_webhook: { state: Exclude<AppBuildWebhookState, 'none'> };
    app_build_dispatch_fallback: { job: 'prepare' | 'watch' };
}

/** The bucket a Build's duration falls in; `null` for a Build with no (or a nonsense) duration. */
export function appBuildDurationBucket(
    durationSeconds: number | null | undefined,
): AppBuildDurationBucket | null {
    if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds)) return null;
    if (durationSeconds < 0) return null;
    const minutes = durationSeconds / 60;
    if (minutes < 5) return 'lt5';
    if (minutes < 15) return '5to15';
    if (minutes < 30) return '15to30';
    if (minutes <= 60) return '30to60';
    return 'gt60';
}

/**
 * The §9.1 `path` of a preparation's workflow write, or `null` when nothing was written
 * (`unchanged`) — an unchanged workflow is not an event.
 */
export function appBuildWorkflowWrittenPath(
    state: AppBuildPrepareWorkflowState | string | null | undefined,
): AppBuildWorkflowWrittenPath | null {
    switch (state) {
        case 'committed':
            return 'commit';
        case 'pullRequestOpened':
        case 'pullRequestUpdated':
            return 'pullRequest';
        case 'editedByHand':
            return 'editedByHand';
        default:
            return null;
    }
}

/** A stored `runnerClass` narrowed to the closed set; anything else is `null`. */
function knownRunnerClass(value: unknown): AppBuildRunnerClass | null {
    return typeof value === 'string' &&
        (APP_BUILD_RUNNER_CLASSES as readonly string[]).includes(value)
        ? (value as AppBuildRunnerClass)
        : null;
}

/**
 * The Builds events, over APW-01's sink and sanitizer. Provided by `AppBuildsModule`; every
 * emitter takes it `@Optional()`, so a spec or a process without it emits nothing.
 */
@Injectable()
export class AppBuildsTelemetry {
    private readonly inner: AppWorksTelemetryService;

    constructor(
        @Optional()
        @Inject(APP_WORKS_TELEMETRY_SINK)
        sink?: AppWorksTelemetrySink,
    ) {
        this.inner = new AppWorksTelemetryService(sink);
    }

    /** Emit one event. Never throws (the inner service catches everything). */
    track<E extends AppBuildTelemetryEvent>(
        event: E,
        properties: AppBuildTelemetryPayloads[E],
        distinctId?: string | null,
    ): void {
        this.inner.trackEvent(
            event,
            properties as unknown as Record<string, unknown>,
            distinctId ?? null,
        );
    }

    /** A copy of the counters, for diagnostics and specs. */
    stats(): AppWorksTelemetryStats {
        return this.inner.stats();
    }
}

/**
 * `app_build_recorded` and `app_build_terminal`, off the lifecycle events
 * `AppBuildsService.publish` already emits — so the two need no edit on the service's many
 * transition paths, and fire exactly when the feed and the notifications do.
 *
 * `app.build.queued` is published once, by the insert that creates the row (plan §7.8), which
 * is why it is the "recorded" event. The terminal event re-reads the row for the two fields the
 * event payload does not carry (the duration and the runner class); a failed read still emits,
 * with those two `null`.
 */
@Injectable()
export class AppBuildsTelemetryListener {
    private readonly logger = new Logger(AppBuildsTelemetryListener.name);

    constructor(
        @Optional() private readonly telemetry?: AppBuildsTelemetry,
        @Optional() private readonly builds?: AppBuildRepository,
    ) {}

    @OnEvent('app.build.queued', { async: true })
    onQueued(event: { payload?: AppBuildEventPayload } | AppBuildEventPayload): void {
        const payload = payloadOf(event);
        if (!payload || !this.telemetry) return;
        this.telemetry.track(
            APP_BUILD_TELEMETRY_EVENTS.recorded,
            { trigger: payload.trigger },
            payload.userId,
        );
    }

    @OnEvent('app.build.succeeded', { async: true })
    async onSucceeded(
        event: { payload?: AppBuildEventPayload } | AppBuildEventPayload,
    ): Promise<void> {
        await this.terminal(event);
    }

    @OnEvent('app.build.failed', { async: true })
    async onFailed(event: { payload?: AppBuildEventPayload } | AppBuildEventPayload): Promise<void> {
        await this.terminal(event);
    }

    @OnEvent('app.build.cancelled', { async: true })
    async onCancelled(
        event: { payload?: AppBuildEventPayload } | AppBuildEventPayload,
    ): Promise<void> {
        await this.terminal(event);
    }

    private async terminal(
        event: { payload?: AppBuildEventPayload } | AppBuildEventPayload,
    ): Promise<void> {
        const payload = payloadOf(event);
        if (!payload || !this.telemetry) return;

        let durationSeconds: number | null = null;
        let runnerClass: AppBuildRunnerClass | null = null;
        try {
            const row = await this.builds?.findByIdForWork(payload.workId, payload.buildId);
            durationSeconds = typeof row?.durationSeconds === 'number' ? row.durationSeconds : null;
            runnerClass = knownRunnerClass(row?.runnerClass);
        } catch (error) {
            this.logger.debug?.(
                `App builds telemetry: build ${payload.buildId} could not be re-read (${
                    error instanceof Error ? error.name : 'Error'
                }); emitting without duration and runner class.`,
            );
        }

        this.telemetry.track(
            APP_BUILD_TELEMETRY_EVENTS.terminal,
            {
                status: payload.status,
                failureClass: payload.failureClass ?? null,
                durationBucket: appBuildDurationBucket(durationSeconds),
                runnerClass,
            },
            payload.userId,
        );
    }
}

/** The event classes wrap the payload (`new EventClass(payload)`); accept either shape. */
function payloadOf(
    event: { payload?: AppBuildEventPayload } | AppBuildEventPayload | null | undefined,
): AppBuildEventPayload | null {
    if (!event || typeof event !== 'object') return null;
    const wrapped = (event as { payload?: AppBuildEventPayload }).payload;
    const payload = wrapped && typeof wrapped === 'object' ? wrapped : (event as AppBuildEventPayload);
    return typeof payload?.buildId === 'string' && typeof payload?.status === 'string'
        ? payload
        : null;
}
