import { Inject, Injectable, Optional } from '@nestjs/common';
import {
    APP_WORKS_TELEMETRY_SINK,
    AppWorksTelemetryService,
    type AppWorksTelemetrySink,
    type AppWorksTelemetryStats,
} from './app-works-telemetry.service';

/**
 * APW-08 (Gauzy Ever Works #37, 2026-10-29) — the evolve loop's telemetry of plan §8.1.
 *
 * ## The pattern, reused rather than re-made
 *
 * Exactly `app-builds/app-builds.telemetry.ts`'s shape: a closed event map, typed payloads,
 * and a thin class over APW-01 T36's {@link AppWorksTelemetryService} sanitizer and its
 * `@Optional()` `APP_WORKS_TELEMETRY_SINK` (the API's `@Global()` PostHog alias) — rather
 * than the plan's `packages/monitoring/src/posthog/app-change-events.ts`, because the agent
 * package takes no dependency on the monitoring package and the programme has ONE sanitizer.
 * Its rule 3 is the plan's forbidden-key rule made stricter: no free text of any kind passes
 * (a prompt, a diff, a path, a log line, a title are all not codes and are dropped).
 *
 * ## Who emits what
 *
 * | Event | Emitted by |
 * | --- | --- |
 * | `app.change.started` | `AppChangeRequestService.request`, when the change Task is filed |
 * | `app.change.blocked_by_switch` | `AppChangeRequestService.request`, when `EVER_WORKS_APP_CHANGES_ENABLED` is off |
 * | `app.change.guard_refused` | `AppWorkChangeGateService.evaluate`, when the change guard refuses a branch that is not a provisioning Task's |
 *
 * The delivery-tracking events (`merged`, `delivered`, `delivery_failed`,
 * `closed_without_deploy`, `delivery.sweep`), the Mission task-output events and
 * `run_admitted` / `tool_denied` are declared for the plan's catalog; the moments they
 * describe (the delivery reconciler, the Mission fan-out, the XC-05/06 admission) are not in
 * this tree yet, so nothing emits them.
 */

/** Plan §8.1's events, by the names the analytics backend receives. */
export const APP_CHANGE_TELEMETRY_EVENTS = {
    started: 'app.change.started',
    guardRefused: 'app.change.guard_refused',
    merged: 'app.change.merged',
    delivered: 'app.change.delivered',
    deliveryFailed: 'app.change.delivery_failed',
    closedWithoutDeploy: 'app.change.closed_without_deploy',
    deliverySweep: 'app.change.delivery.sweep',
    missionTaskOutputTick: 'mission.task_output.tick',
    runAdmitted: 'app.change.run_admitted',
    blockedBySwitch: 'app.change.blocked_by_switch',
    toolDenied: 'app.change.tool_denied',
    missionNothingToFile: 'mission.task_output.nothing_to_file',
} as const;

export type AppChangeTelemetryEvent =
    (typeof APP_CHANGE_TELEMETRY_EVENTS)[keyof typeof APP_CHANGE_TELEMETRY_EVENTS];

/** Plan §8.1's `guard_refused.reason`. */
export type AppChangeGuardRefusedReason =
    | 'protected'
    | 'too_many_files'
    | 'too_large'
    | 'spec_field';

/** Each event's properties — plan §8.1 (additions are marked). */
export interface AppChangeTelemetryPayloads {
    'app.change.started': {
        workId: string;
        taskId: string;
        /** Where the request came from: `chat`, `card`, `api` or `other`. */
        source: string;
        /** Addition: the run was dispatched now (not held, not refused by a gate). */
        dispatched: boolean;
        /** Addition: the Task is held for the owner. */
        awaitingOwner: boolean;
        /** Addition: how the Agent was chosen (`explicit`, or the resolution rule's source). */
        agentSource: string;
    };
    'app.change.guard_refused': {
        workId: string;
        /** `null` when the gate's caller did not name the Task. */
        taskId: string | null;
        reason: AppChangeGuardRefusedReason;
        /** Addition: the guard's own refusal code (`protectedPath`, `workflowPath`, …). */
        code: string;
    };
    'app.change.merged': { workId: string; taskId: string };
    'app.change.delivered': {
        workId: string;
        taskId: string;
        minutesMergeToLive: number;
        carried: boolean;
    };
    'app.change.delivery_failed': {
        workId: string;
        taskId: string;
        phase: 'build' | 'deploy';
        followUp: boolean;
    };
    'app.change.closed_without_deploy': { workId: string; taskId: string };
    'app.change.delivery.sweep': {
        scanned: number;
        changed: number;
        failed: number;
        durationMs: number;
    };
    'mission.task_output.tick': {
        missionId: string;
        worksConsidered: number;
        tasksFiled: number;
        skippedCap: number;
        skippedDuplicate: number;
    };
    'app.change.run_admitted': {
        workId: string;
        taskId: string;
        placement: 'fleet' | 'cloud';
        containmentPath: string;
        isolatedHome: boolean;
        downgraded: boolean;
    };
    'app.change.blocked_by_switch': {
        workId: string;
        /** `null` when the switch stopped the request before a Task existed. */
        taskId: string | null;
        switch: 'evolve' | 'auto_deploy';
    };
    'app.change.tool_denied': { workId: string; taskId: string; group: string };
    'mission.task_output.nothing_to_file': { missionId: string };
}

/**
 * The change guard's refusal code, as plan §8.1's `reason`; `null` for a code the plan has
 * no reason for (a provisioning-only code, which `app.provision.guard_rejected` reports).
 */
export function appChangeGuardRefusedReason(
    code: string | null | undefined,
): AppChangeGuardRefusedReason | null {
    switch (code) {
        case 'protectedPath':
        case 'workflowPath':
            return 'protected';
        case 'diffTooLarge':
            return 'too_many_files';
        case 'tooManyLines':
        // APW08-G22 — the file guidance's 3× refusal is a SIZE refusal on FR-27's shape, like
        // the line guidance's; `too_many_files` stays FR-21's "cannot verify" ceiling. The
        // event's `code` still tells the two apart.
        case 'tooManyFiles':
            return 'too_large';
        case 'guardedSpecBlock':
            return 'spec_field';
        default:
            return null;
    }
}

/** A request channel narrowed to a closed code. */
export function appChangeSource(channel: string | null | undefined): string {
    return channel === 'chat' || channel === 'card' || channel === 'api' ? channel : 'other';
}

/**
 * The evolve-loop events, over APW-01's sink and sanitizer. Provided by the agent
 * `AppWorksModule` (the change request service) and `TasksDomainModule` (the change gate);
 * every emitter takes it `@Optional()`.
 */
@Injectable()
export class AppChangeTelemetry {
    private readonly inner: AppWorksTelemetryService;

    constructor(
        @Optional()
        @Inject(APP_WORKS_TELEMETRY_SINK)
        sink?: AppWorksTelemetrySink,
    ) {
        this.inner = new AppWorksTelemetryService(sink);
    }

    /** Emit one event. Never throws (the inner service catches everything). */
    track<E extends AppChangeTelemetryEvent>(
        event: E,
        properties: AppChangeTelemetryPayloads[E],
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
