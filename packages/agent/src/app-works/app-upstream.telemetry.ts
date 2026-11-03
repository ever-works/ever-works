import { Inject, Injectable, Optional } from '@nestjs/common';
import {
    APP_WORKS_TELEMETRY_SINK,
    AppWorksTelemetryService,
    type AppWorksTelemetrySink,
    type AppWorksTelemetryStats,
} from './app-works-telemetry.service';

/**
 * APW-02 T39 (Gauzy Ever Works #37, 2026-10-29) — the fork lifecycle telemetry of plan §9.1:
 * counters, durations and codes only.
 *
 * ## The pattern, reused rather than re-made
 *
 * Exactly `app-builds/app-builds.telemetry.ts`'s shape: a closed event map, typed payloads,
 * and a thin class over APW-01 T36's {@link AppWorksTelemetryService} sanitizer and its
 * `@Optional()` `APP_WORKS_TELEMETRY_SINK` (the API's `@Global()` PostHog alias) — rather
 * than the plan's separate `APP_UPSTREAM_TELEMETRY_SINK` port: one sink, one sanitizer, for
 * the programme. The sanitizer is the plan's "allow-list enforced at the port boundary",
 * made stricter: no value that is not a code, a counter, a flag or `null` reaches the sink,
 * so no repository name, URL, owner login, token or file content can travel even by mistake.
 *
 * ## Where each event runs, and what that means today
 *
 * | Event | Emitted by | Process |
 * | --- | --- | --- |
 * | `app_fork.readiness_finished` | `AppForkReadinessService.run` | API (its readiness run) |
 * | `app_actions.hygiene` | `AppActionsHygieneService.apply` | API (readiness) and worker (sync) |
 * | `app_upstream.dispatch_tick` | `AppUpstreamSyncDispatcherService.dispatchDue` | API (the cron) |
 * | `app_upstream.sync_finished` | `AppUpstreamSyncService.run` | the Trigger worker |
 *
 * The worker binds no sink, so an event emitted there is counted and dropped (rule 1) until
 * the worker gets one or relays to the API. `app_fork.copy_pushed` and
 * `git_checkout.not_ready` are declared for the plan's catalog and not wired yet (the
 * private-copy push and the facade's `RepositoryNotReadyError` catch).
 */

/** Plan §9.1's six events, by the names the analytics backend receives. */
export const APP_UPSTREAM_TELEMETRY_EVENTS = {
    readinessFinished: 'app_fork.readiness_finished',
    copyPushed: 'app_fork.copy_pushed',
    hygiene: 'app_actions.hygiene',
    syncFinished: 'app_upstream.sync_finished',
    dispatchTick: 'app_upstream.dispatch_tick',
    checkoutNotReady: 'git_checkout.not_ready',
} as const;

export type AppUpstreamTelemetryEvent =
    (typeof APP_UPSTREAM_TELEMETRY_EVENTS)[keyof typeof APP_UPSTREAM_TELEMETRY_EVENTS];

/** Each event's properties — plan §9.1 (additions are marked). */
export interface AppUpstreamTelemetryPayloads {
    'app_fork.readiness_finished': {
        /** Addition: the attempt number (the plan's `relation` is not on the run's payload). */
        attempt: number;
        outcome: string;
        reason?: string;
        durationMs: number;
        probes: number;
        /** Addition: whether hygiene ran in this attempt. */
        hygieneRan: boolean;
    };
    'app_fork.copy_pushed': { sizeKb: number; durationMs: number; alreadyUpToDate: boolean };
    'app_actions.hygiene': {
        disabled: number;
        kept: number;
        /** Workflows judged and left as they were (seen before, or enabled by a person). */
        skipped: number;
        state: string;
        truncated: boolean;
        /** Addition: provider calls the pass made. */
        calls: number;
    };
    'app_upstream.sync_finished': {
        trigger: string;
        result: string | null;
        reason?: string;
        commits: number | null;
        providerCalls: number;
        durationMs: number;
        /** Addition: `settled` (the run claimed the Work) or `refused`. */
        outcome: string;
    };
    'app_upstream.dispatch_tick': {
        dueCount: number;
        dispatched: number;
        redispatchedReadiness: number;
        timedOut: number;
        rechecked: number;
        setupChecked: number;
        failed: number;
        /** Addition: claimed rows deliberately not dispatched. */
        skipped: number;
        /** Addition: open sync pull requests checked for a merge. */
        syncPullRequestChecked: number;
    };
    'git_checkout.not_ready': { provider: string };
}

/**
 * The fork lifecycle events, over APW-01's sink and sanitizer. Provided (and exported) by
 * the agent `AppWorksModule`; every emitter takes it `@Optional()`.
 */
@Injectable()
export class AppUpstreamTelemetry {
    private readonly inner: AppWorksTelemetryService;

    constructor(
        @Optional()
        @Inject(APP_WORKS_TELEMETRY_SINK)
        sink?: AppWorksTelemetrySink,
    ) {
        this.inner = new AppWorksTelemetryService(sink);
    }

    /** Emit one event. Never throws (the inner service catches everything). */
    track<E extends AppUpstreamTelemetryEvent>(
        event: E,
        properties: AppUpstreamTelemetryPayloads[E],
        distinctId?: string | null,
    ): void {
        try {
            this.inner.trackEvent(
                event,
                properties as unknown as Record<string, unknown>,
                distinctId ?? null,
            );
        } catch {
            // `trackEvent` already never throws; kept so a caller's `void` stays honest.
        }
    }

    /** A copy of the counters, for diagnostics and specs. */
    stats(): AppWorksTelemetryStats {
        return this.inner.stats();
    }
}
