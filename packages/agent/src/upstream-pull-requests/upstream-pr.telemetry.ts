import { Inject, Injectable, Optional } from '@nestjs/common';
import {
    APP_WORKS_TELEMETRY_SINK,
    AppWorksTelemetryService,
    type AppWorksTelemetrySink,
    type AppWorksTelemetryStats,
} from '../app-works/app-works-telemetry.service';

/**
 * APW-09 (Gauzy Ever Works #37, 2026-10-29) — the upstream pull request telemetry of plan
 * §9.1: counters and ids only, never titles, bodies, diffs, logins or repository names.
 *
 * ## The pattern, reused rather than re-made
 *
 * Exactly `app-builds/app-builds.telemetry.ts`'s shape: a closed event map, typed payloads,
 * and a thin class over APW-01 T36's {@link AppWorksTelemetryService} sanitizer and its
 * `@Optional()` `APP_WORKS_TELEMETRY_SINK` (the API's `@Global()` PostHog alias) — rather
 * than the plan's `packages/monitoring/src/posthog/upstream-pr-events.ts` plus an
 * `UPSTREAM_PR_TELEMETRY` port: the agent package takes no monitoring dependency, and the
 * programme has ONE sanitizer. That sanitizer is stricter than the plan's key-strip
 * (`title`, `body`, `diff`, `login`, `owner`, `repo`): it drops ANY value that is not a code,
 * a counter, a flag or `null`, so a title or an `owner/repo` cannot travel under any key.
 *
 * ## Who emits what
 *
 * | Event | Emitted by |
 * | --- | --- |
 * | `upstream_pr.proposed` | `UpstreamPullRequestOpenService.open`, when the record is claimed |
 * | `upstream_pr.refused` | `UpstreamPullRequestOpenService.open`, for every refusal (phase `eligibility` before the provider, `open` when the provider refused) |
 * | `upstream_pr.opened` | `UpstreamPullRequestOpenService.open`, when the provider opened it |
 *
 * `approval_decided`, `review`, `final` and `status_sweep` are declared for the plan's
 * catalog; the shipped path opens directly (no approval step) and there is no status sweep
 * of upstream pull requests in this tree yet, so nothing emits them.
 */

/** Plan §9.1's seven events, by the names the analytics backend receives. */
export const UPSTREAM_PR_TELEMETRY_EVENTS = {
    proposed: 'upstream_pr.proposed',
    refused: 'upstream_pr.refused',
    approvalDecided: 'upstream_pr.approval_decided',
    opened: 'upstream_pr.opened',
    review: 'upstream_pr.review',
    final: 'upstream_pr.final',
    statusSweep: 'upstream_pr.status_sweep',
} as const;

export type UpstreamPrTelemetryEvent =
    (typeof UPSTREAM_PR_TELEMETRY_EVENTS)[keyof typeof UPSTREAM_PR_TELEMETRY_EVENTS];

/** Where a refusal happened — plan §9.1. */
export type UpstreamPrRefusedPhase = 'eligibility' | 'verification' | 'open';

/** Each event's properties — plan §9.1 (additions are marked). */
export interface UpstreamPrTelemetryPayloads {
    'upstream_pr.proposed': {
        workId: string;
        /** `null` for a proposal of a named branch rather than a Task's. */
        taskId: string | null;
    };
    'upstream_pr.refused': { code: string; phase: UpstreamPrRefusedPhase };
    'upstream_pr.approval_decided': { outcome: string; hoursToDecision: number };
    'upstream_pr.opened': {
        /** `null` on the direct path, which has no approval step. */
        minutesApprovalToOpen: number | null;
        /** Addition: opened as a draft. */
        draft: boolean;
        /** Addition: the change came from one of the Work's Tasks. */
        fromTask: boolean;
    };
    'upstream_pr.review': { summary: string };
    'upstream_pr.final': { outcome: 'merged' | 'closed'; daysOpen: number };
    'upstream_pr.status_sweep': {
        scanned: number;
        changed: number;
        failed: number;
        providerRequests: number;
    };
}

/** The phase of an open refusal: the provider's own refusal is `open`, the rest come first. */
export function upstreamPrRefusedPhase(code: string): UpstreamPrRefusedPhase {
    return code === 'providerRefused' ? 'open' : 'eligibility';
}

/**
 * The upstream pull request events, over APW-01's sink and sanitizer. Provided by
 * `UpstreamPullRequestsModule`; every emitter takes it `@Optional()`.
 */
@Injectable()
export class UpstreamPrTelemetry {
    private readonly inner: AppWorksTelemetryService;

    constructor(
        @Optional()
        @Inject(APP_WORKS_TELEMETRY_SINK)
        sink?: AppWorksTelemetrySink,
    ) {
        this.inner = new AppWorksTelemetryService(sink);
    }

    /** Emit one event. Never throws (the inner service catches everything). */
    track<E extends UpstreamPrTelemetryEvent>(
        event: E,
        properties: UpstreamPrTelemetryPayloads[E],
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
