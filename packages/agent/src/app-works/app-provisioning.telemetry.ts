import { Inject, Injectable, Optional } from '@nestjs/common';
import {
    APP_WORKS_TELEMETRY_SINK,
    AppWorksTelemetryService,
    type AppWorksTelemetrySink,
    type AppWorksTelemetryStats,
} from './app-works-telemetry.service';

/**
 * APW-04 T28 (Gauzy Ever Works #37, 2026-10-29) — the App Provisioner telemetry of plan §10.1.
 *
 * ## The pattern, reused rather than re-made
 *
 * Exactly `app-builds/app-builds.telemetry.ts`'s shape: a closed event map, typed payloads,
 * and a thin class over APW-01 T36's {@link AppWorksTelemetryService} sanitizer and its
 * `@Optional()` `APP_WORKS_TELEMETRY_SINK` (the API's `@Global()` PostHog alias). Unbound ⇒
 * counted and dropped; telemetry never fails the operation it observes; only codes, counters,
 * flags and ids leave the process.
 *
 * ## Provisioning is a Task here, so `provisioningId` is the Task id
 *
 * The plan was written against a `WorkAppProvisioning` row; the shipped provisioner runs on
 * the Task machinery (an `app-provision` Task, `origin: 'app-provisioning'`). The id every
 * event carries is that Task's id — the thing a support person can open.
 *
 * ## What never appears (plan §10.1's last line)
 *
 * No repository name, no file path, no env name, no question text, no report text, no brief,
 * no draft. The guard event carries the refusal CODE, never its message or its paths.
 *
 * ## Who emits what
 *
 * | Event | Emitted by |
 * | --- | --- |
 * | `app.provision.started` | `AppProvisioningService.start`, once the Task is filed |
 * | `app.provision.attempt_finished` | `AppProvisioningFeedbackService.handle`, for each build / deploy / smoke outcome on the provisioning Task |
 * | `app.provision.finished` | `AppProvisioningService.cancel` (`cancelled`) and the feedback loop when it stops (`failed`, `attempts_exhausted`) |
 * | `app.provision.guard_rejected` | `AppWorkChangeGateService.evaluate`, when the output guard refuses a provisioning Task's branch |
 *
 * `app.provision.question_asked` and `app.provision.suggested` are declared for the plan's
 * catalog; the shipped provisioner has no question round-trip and no Blueprint suggestion
 * (APW-04 T38/T39), so nothing emits them yet.
 */

/** The six events of plan §10.1, by the names the analytics backend receives. */
export const APP_PROVISION_TELEMETRY_EVENTS = {
    started: 'app.provision.started',
    attemptFinished: 'app.provision.attempt_finished',
    questionAsked: 'app.provision.question_asked',
    finished: 'app.provision.finished',
    suggested: 'app.provision.suggested',
    guardRejected: 'app.provision.guard_rejected',
} as const;

export type AppProvisionTelemetryEvent =
    (typeof APP_PROVISION_TELEMETRY_EVENTS)[keyof typeof APP_PROVISION_TELEMETRY_EVENTS];

/** What the feedback loop did with one outcome (its `handle` answer, minus `ignored`). */
export type AppProvisionAttemptDecision = 'posted' | 'iterated' | 'exhausted' | 'reprovisioned';

/** Each event's properties — plan §10.1, one key per listed field (additions are marked). */
export interface AppProvisionTelemetryPayloads {
    'app.provision.started': {
        provisioningId: string;
        /** `auto-create`, `manual`, `smoke-failed`, `target-updated`, `build-failed`. */
        trigger: string;
        /** Addition: an Agent was resolved and the Task assigned to it. */
        agentAssigned: boolean;
        /** Addition: the Task is held for the owner (`awaiting-owner`). */
        held: boolean;
        /** Addition: the draft handed to the Agent validated. */
        draftValid: boolean;
        /** Where the draft came from — `detection` or `ai` (the plan's `detectionSource`). */
        detectionSource: 'detection' | 'ai';
        /** Addition: the no-Agent path opened a pull request with the draft. */
        pullRequestOpened: boolean;
        /** Addition: the detector's closed build strategy code. */
        buildStrategy: string | null;
    };
    'app.provision.attempt_finished': {
        provisioningId: string;
        /** The iteration this outcome belongs to (1 = the first run). */
        n: number;
        verdict: 'succeeded' | 'failed';
        /** The step that failed; `null` on success. */
        failedStep: 'build' | 'deploy' | 'smoke' | null;
        /** Addition: what the loop did next. */
        decision: AppProvisionAttemptDecision;
    };
    'app.provision.question_asked': { provisioningId: string; reason: string };
    'app.provision.finished': {
        provisioningId: string;
        status: 'cancelled' | 'failed';
        /** A closed code (`attempts_exhausted`), `null` for a cancel. */
        failureReason: string | null;
        /** Follow-up iterations counted on the Task. */
        attempts: number;
    };
    'app.provision.suggested': { provisioningId: string };
    'app.provision.guard_rejected': {
        /** `null` when the gate's caller did not name the Task. */
        provisioningId: string | null;
        /** The output guard's refusal codes — never its message or paths. */
        codes: string[];
    };
}

/** The label prefix the feedback loop counts iterations with (`app-provisioning-feedback.service.ts`). */
const PROVISION_ATTEMPT_LABEL_PREFIX = 'provision-attempt-';

/**
 * The iterations counted on a provisioning Task — the same reading as the feedback loop's
 * `attemptOf`, restated so this leaf imports neither service.
 */
export function provisionAttemptsOf(labels: readonly string[] | null | undefined): number {
    let max = 0;
    for (const label of labels ?? []) {
        if (typeof label !== 'string' || !label.startsWith(PROVISION_ATTEMPT_LABEL_PREFIX)) {
            continue;
        }
        const n = Number.parseInt(label.slice(PROVISION_ATTEMPT_LABEL_PREFIX.length), 10);
        if (Number.isInteger(n) && n > max) max = n;
    }
    return max;
}

/**
 * The provisioning events, over APW-01's sink and sanitizer. Provided by the agent
 * `AppWorksModule` (the provisioner and its feedback loop) and `TasksDomainModule` (the
 * change gate); every emitter takes it `@Optional()`.
 */
@Injectable()
export class AppProvisioningTelemetry {
    private readonly inner: AppWorksTelemetryService;

    constructor(
        @Optional()
        @Inject(APP_WORKS_TELEMETRY_SINK)
        sink?: AppWorksTelemetrySink,
    ) {
        this.inner = new AppWorksTelemetryService(sink);
    }

    /** Emit one event. Never throws (the inner service catches everything). */
    track<E extends AppProvisionTelemetryEvent>(
        event: E,
        properties: AppProvisionTelemetryPayloads[E],
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
