import { HttpException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
    isAppSourceReasonCode,
    type AppDeployTargetChoice,
    type AppRepositoryMode,
    type AppSourceBlueprintStatus,
    type AppSourceLicenseClass,
} from '@ever-works/contracts';

/**
 * APW-01 T36 — App Works telemetry (FR-53, plan §9.1).
 *
 * The five events of plan §9.1, emitted by the inspector, the create path, the ready
 * handler and the delete path through ONE service, over a sink this epic declares as a
 * token rather than imports: `packages/agent`, `packages/plugin` and `packages/tasks`
 * take no dependency on the monitoring package (T36's Done-when greps for its import
 * specifier here and expects nothing), so the API binds
 * {@link APP_WORKS_TELEMETRY_SINK} to its PostHog `AnalyticsService` with a `@Global()`
 * alias (`apps/api/src/telemetry/app-works-telemetry-binding.module.ts`) — the pattern
 * `ZERO_FRICTION_FUNNEL_ANALYTICS` already uses.
 *
 * ## The three rules this file keeps
 *
 * 1. **Unbound is a supported installation.** No sink (the worker, the CLI, a spec, an
 *    API without PostHog configured) ⇒ every event is counted and dropped. Never a
 *    refusal, never a throw, and the only thing logged is a count — once on the first
 *    drop and then every {@link DROP_LOG_EVERY} drops.
 * 2. **Telemetry never fails the operation it observes.** `track` catches everything,
 *    including a throwing sink, and counts it.
 * 3. **Counters, codes, flags and ids only** (FR-53: "without repository names or
 *    tokens"). The typed payloads below admit nothing else, and every value is checked
 *    again at run time: a string that is not a short code (a URL, an `owner/repo`, a
 *    sentence) is dropped from the payload and counted as `redacted`. The user id travels
 *    as PostHog's distinct id, never as a property.
 *
 * 🛑 **A leaf file on purpose.** It imports nothing from the App Works services, so every
 * one of them (and `WorkLifecycleService`) can import it without closing a require ring.
 */

/** DI token for {@link AppWorksTelemetrySink}; the API binds it to its `AnalyticsService`. */
export const APP_WORKS_TELEMETRY_SINK = Symbol('APP_WORKS_TELEMETRY_SINK');

/**
 * The PostHog-shaped client the sink token is bound to: the monitoring package's
 * `AnalyticsService.track`, restated so this package does not import it.
 */
export interface AppWorksTelemetrySink {
    track(
        distinctId: string,
        event: string,
        properties?: Record<string, unknown>,
        groups?: Record<string, string | number>,
    ): void;
    /** When present and `false`, the sink is treated as unbound (PostHog not configured). */
    isAvailable?(): boolean;
    isInitialized?(): boolean;
}

/** The five events of plan §9.1, by the names PostHog receives. */
export const APP_WORKS_TELEMETRY_EVENTS = {
    sourceInspected: 'app_source.inspected',
    createStarted: 'app_work.create_started',
    createFinished: 'app_work.create_finished',
    sourceReady: 'app_work.source_ready',
    deleted: 'app_work.deleted',
} as const;

export type AppWorksTelemetryEvent =
    (typeof APP_WORKS_TELEMETRY_EVENTS)[keyof typeof APP_WORKS_TELEMETRY_EVENTS];

/**
 * How one create call ended.
 *
 * `failed` is the one member plan §9.1 does not list: an unexpected fault (a transaction
 * that threw, anything that is not an HTTP answer) is neither a create nor a refusal, and
 * reporting it as `refused` would count a platform fault as the member's.
 */
export type AppWorkCreateOutcome = 'created' | 'already_existed' | 'refused' | 'failed';

/** Each event's properties — plan §9.1's table, one row per key. */
export interface AppWorksTelemetryPayloads {
    'app_source.inspected': {
        defaultMode: AppRepositoryMode | null;
        modesAvailable: AppRepositoryMode[];
        /** The modes' reason codes, de-duplicated and sorted. */
        reasons: string[];
        blueprint: AppSourceBlueprintStatus;
        licenseClass: AppSourceLicenseClass;
        durationMs: number;
        /** Provider calls this inspection made; `0` for an answer served from the cache. */
        providerCalls: number;
    };
    'app_work.create_started': {
        mode: AppRepositoryMode;
        deployTarget: AppDeployTargetChoice;
        adoptedExistingFork: boolean;
    };
    'app_work.create_finished': {
        /** `null` when the request named no valid mode. */
        mode: AppRepositoryMode | null;
        outcome: AppWorkCreateOutcome;
        /** A closed-set reason code, `http_<status>` or `unexpected` — never a message. */
        reason?: string;
        durationMs: number;
    };
    'app_work.source_ready': {
        mode: AppRepositoryMode;
        /** Since the state row's `readinessStartedAt`; `null` when the row carries none. */
        preparingMs: number | null;
        setupPullRequest: boolean;
    };
    'app_work.deleted': {
        mode: AppRepositoryMode;
        repositoryDeleted: boolean;
    };
}

/** What this process did with the events it was handed — for diagnostics and specs. */
export interface AppWorksTelemetryStats {
    emitted: number;
    dropped: number;
    failed: number;
    /** Property values removed because they were not a code, a counter or a flag. */
    redacted: number;
}

/** The distinct id used when a caller has no user id to give. */
export const APP_WORKS_TELEMETRY_ANONYMOUS_ID = 'app-works';

/** After the first drop, the count is logged again every this many drops. */
const DROP_LOG_EVERY = 1000;

/**
 * A code: `fork`, `no_push_access`, `your-cluster`, `http_409`. No `/`, no `:`, no
 * whitespace, so a URL, an `owner/repo` pair or a sentence can never pass.
 */
const CODE_SHAPE = /^[A-Za-z0-9_.-]{1,64}$/;

@Injectable()
export class AppWorksTelemetryService {
    private readonly logger = new Logger(AppWorksTelemetryService.name);
    private readonly counts: AppWorksTelemetryStats = {
        emitted: 0,
        dropped: 0,
        failed: 0,
        redacted: 0,
    };

    constructor(
        @Optional()
        @Inject(APP_WORKS_TELEMETRY_SINK)
        private readonly sink?: AppWorksTelemetrySink,
    ) {}

    /**
     * Emit one event. Never throws, and never blocks: the sink's `track` is synchronous
     * fire-and-forget on the PostHog client.
     */
    track<E extends AppWorksTelemetryEvent>(
        event: E,
        properties: AppWorksTelemetryPayloads[E],
        distinctId?: string | null,
    ): void {
        try {
            if (!this.sink || !isSinkReady(this.sink)) {
                this.drop();
                return;
            }
            const clean = this.sanitize(properties as unknown as Record<string, unknown>);
            this.sink.track(distinctId || APP_WORKS_TELEMETRY_ANONYMOUS_ID, event, clean);
            this.counts.emitted += 1;
        } catch (error) {
            this.counts.failed += 1;
            // The event name and the error's class only: a sink's message could carry
            // anything, and this line must stay as clean as the payload.
            this.logger.warn(
                `App Works telemetry: the sink refused ${event} (${errorClass(error)}).`,
            );
        }
    }

    /** A copy of the counters. */
    stats(): AppWorksTelemetryStats {
        return { ...this.counts };
    }

    private drop(): void {
        this.counts.dropped += 1;
        if (this.counts.dropped === 1 || this.counts.dropped % DROP_LOG_EVERY === 0) {
            this.logger.log(
                `App Works telemetry: no sink is bound; ${this.counts.dropped} event(s) counted and dropped.`,
            );
        }
    }

    /** Keep booleans, finite numbers, `null`, codes and arrays of codes; drop the rest. */
    private sanitize(properties: Record<string, unknown>): Record<string, unknown> {
        const clean: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(properties ?? {})) {
            if (value === undefined) {
                continue;
            }
            if (isSafeScalar(value)) {
                clean[key] = value;
            } else if (Array.isArray(value) && value.every(isCode)) {
                clean[key] = [...value];
            } else {
                this.counts.redacted += 1;
            }
        }
        return clean;
    }
}

/**
 * How a create call that threw ended, for `app_work.create_finished`.
 *
 * - an HTTP answer carrying one of the closed reason codes ⇒ `refused` with that code;
 * - any other HTTP answer below 500 (Nest's validation body, the per-user slug `409`) ⇒
 *   `refused` with `http_<status>`;
 * - everything else ⇒ `failed` (`http_<status>` for a 5xx without a code, `unexpected`
 *   for a thrown error that is not an HTTP answer at all).
 *
 * Only the code is read — never the message, which names repositories.
 */
export function appWorkCreateOutcomeOf(error: unknown): {
    outcome: Extract<AppWorkCreateOutcome, 'refused' | 'failed'>;
    reason: string;
} {
    if (error instanceof HttpException) {
        const status = error.getStatus();
        const body = error.getResponse();
        const code =
            body && typeof body === 'object' ? (body as { code?: unknown }).code : undefined;
        if (isAppSourceReasonCode(code)) {
            return { outcome: 'refused', reason: code };
        }
        return { outcome: status < 500 ? 'refused' : 'failed', reason: `http_${status}` };
    }
    return { outcome: 'failed', reason: 'unexpected' };
}

function isSinkReady(sink: AppWorksTelemetrySink): boolean {
    if (typeof sink.isAvailable === 'function') {
        return sink.isAvailable();
    }
    if (typeof sink.isInitialized === 'function') {
        return sink.isInitialized();
    }
    return true;
}

function isCode(value: unknown): value is string {
    return typeof value === 'string' && CODE_SHAPE.test(value);
}

function isSafeScalar(value: unknown): boolean {
    return (
        value === null ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value)) ||
        isCode(value)
    );
}

function errorClass(error: unknown): string {
    return error instanceof Error && error.name ? error.name : typeof error;
}
