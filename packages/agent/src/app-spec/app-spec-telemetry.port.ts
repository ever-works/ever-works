import { Inject, Injectable, Optional } from '@nestjs/common';
import type {
    AppSpecEvaluationTrigger,
    AppSpecValidationStatus,
    LicenseClass,
} from '@ever-works/contracts';
import {
    AppWorksTelemetryService,
    type AppWorksTelemetrySink,
    type AppWorksTelemetryStats,
} from '../app-works/app-works-telemetry.service';

/**
 * APW-03 T49 (Gauzy Ever Works #37, 2026-10-29) — the App spec, Apps catalog, Blueprint and
 * licence telemetry of plan §9.1.
 *
 * ## The port the plan names, over the programme's one sanitizer
 *
 * Plan §9.1 declares `APP_SPEC_TELEMETRY_SINK` in this file. It is a token of its own, so the
 * API binds it explicitly (`apps/api/src/telemetry/app-works-telemetry-binding.module.ts`, a
 * `@Global()` alias to the monitoring package's PostHog `AnalyticsService` — the same alias
 * `APP_WORKS_TELEMETRY_SINK` has), but every event goes through APW-01 T36's
 * {@link AppWorksTelemetryService} sanitizer (`trackEvent`) exactly as the Builds events of
 * `app-builds/app-builds.telemetry.ts` do. So the three rules there hold here too:
 *
 * 1. unbound is supported (the worker, a spec, an API without PostHog): events are counted
 *    and dropped, never a refusal;
 * 2. telemetry never fails the operation it observes — every emitter takes
 *    {@link AppSpecTelemetry} `@Optional()`, and `track` never throws;
 * 3. only codes, counters, flags and ids leave the process: a string that is not a short code
 *    (a path, an `owner/repo`, a sentence) is dropped by the sanitizer and counted.
 *
 * ## What never appears
 *
 * No App spec text or value, no env name, no repository name or owner, no SPDX expression
 * (the class is enough), no query text (`apps.catalog.browsed` carries `hasQuery` only), no
 * Blueprint prompt. `workId` travels as a property (plan §9.1); the owner's user id is the
 * distinct id, never a property.
 *
 * ## Who emits what
 *
 * | Event | Emitted by |
 * | --- | --- |
 * | `app.spec.evaluated` | `AppSpecService.evaluate`, once per call, after the lock is released |
 * | `app.spec.draft_validated` | `AppSpecService.validateDraft` (the editor's `POST …/app-spec/validate`) |
 * | `app.blueprint.resolved` | `AppBlueprintResolverService.resolve` (cache answers included) |
 * | `app.blueprint.apply_finished` | `AppBlueprintApplyService.recordOutcome` (create-time apply) and `AppBlueprintUpgradeService` (a run's pull request or failure) |
 * | `app.license.evaluated` | `AppLicenseService.evaluate` |
 * | `app.license.attested` | `AppLicenseService.attest` |
 *
 * `apps.catalog.read` and `apps.catalog.browsed` are declared here so the catalog half of the
 * API (`apps/api/src/works/apps-catalog-manifest.service.ts`) can emit them through the same
 * port; see the PR body for which of them are wired.
 */

/** DI token for the App spec telemetry sink; the API binds it to its `AnalyticsService`. */
export const APP_SPEC_TELEMETRY_SINK = Symbol('APP_SPEC_TELEMETRY_SINK');

/** The PostHog-shaped client the token is bound to — the same shape as APW-01's sink. */
export type AppSpecTelemetrySink = AppWorksTelemetrySink;

/** The eight events of plan §9.1, by the names the analytics backend receives. */
export const APP_SPEC_TELEMETRY_EVENTS = {
    specEvaluated: 'app.spec.evaluated',
    draftValidated: 'app.spec.draft_validated',
    catalogRead: 'apps.catalog.read',
    catalogBrowsed: 'apps.catalog.browsed',
    blueprintResolved: 'app.blueprint.resolved',
    blueprintApplyFinished: 'app.blueprint.apply_finished',
    licenseEvaluated: 'app.license.evaluated',
    licenseAttested: 'app.license.attested',
} as const;

export type AppSpecTelemetryEvent =
    (typeof APP_SPEC_TELEMETRY_EVENTS)[keyof typeof APP_SPEC_TELEMETRY_EVENTS];

/**
 * How `AppBlueprintResolverService.resolve` answered: from its in-process cache, by the
 * explicit path (a named Blueprint id), or by FR-43's probe.
 */
export type AppBlueprintResolvedSource = 'cache' | 'explicit' | 'probe';

/** `app.blueprint.apply_finished.outcome`. */
export type AppBlueprintApplyFinishedOutcome = 'applied' | 'proposed' | 'failed';

/** Each event's properties — plan §9.1, one key per listed field (additions are marked). */
export interface AppSpecTelemetryPayloads {
    'app.spec.evaluated': {
        workId: string;
        /** The trigger the evaluation served (`lastEvaluationTrigger`); `null` when no row. */
        trigger: AppSpecEvaluationTrigger | null;
        /**
         * The head's validation status (`valid`, `invalid`, `missing`, `unreadable`, …) when the
         * pass evaluated, else the outcome's own status (`locked`, `no_state`, `work_missing`).
         */
        status: string;
        errorCount: number;
        warningCount: number;
        durationMs: number;
        /** More than one pass ran under the lock: a trigger that arrived mid-run was served. */
        coalesced: boolean;
        /** Addition: a newer evaluation had already stored its result, so this one wrote nothing. */
        superseded: boolean;
    };
    'app.spec.draft_validated': {
        workId: string;
        status: AppSpecValidationStatus;
        errorCount: number;
        /** The draft's size in UTF-8 bytes — never its text. */
        bytes: number;
    };
    'apps.catalog.read': {
        source: 'cache' | 'tokenless' | 'authenticated' | 'failed';
        entries: number;
        droppedRows: number;
        durationMs: number;
    };
    'apps.catalog.browsed': {
        hasQuery: boolean;
        /** A closed catalog category code, or `null` when none was chosen. */
        category: string | null;
        resultCount: number;
    };
    'app.blueprint.resolved': {
        source: AppBlueprintResolvedSource;
        /** Addition: `hit`, or the miss reason (`notListed`, `lookupFailed`, `blueprintNotFound`). */
        outcome: string;
        refMismatch: boolean;
        durationMs: number;
        /** Provider reads this resolution made; `0` for a cache answer. */
        providerReads: number;
    };
    'app.blueprint.apply_finished': {
        mode: 'apply' | 'upgrade';
        /** `null` for a failure that landed nothing. */
        path: 'commit' | 'pull_request' | null;
        outcome: AppBlueprintApplyFinishedOutcome;
        /** Files the landing wrote, when the caller knows the count. */
        files?: number;
        /** A closed failure code — never a message. */
        reason?: string;
    };
    'app.license.evaluated': {
        class: LicenseClass;
        mixed: boolean;
        scanIncomplete: boolean;
        registrySource: string;
        /** Evidence files the scan read (licence files and root manifests). */
        fileReads: number;
        durationMs: number;
    };
    'app.license.attested': { class: LicenseClass };
}

/**
 * The App spec events, over APW-01's sanitizer and this epic's own sink token. Provided by
 * `AppSpecModule`, `AppLicenseModule` and the agent `AppWorksModule` (where the Blueprint
 * services are declared); every emitter takes it `@Optional()`.
 */
@Injectable()
export class AppSpecTelemetry {
    private readonly inner: AppWorksTelemetryService;

    constructor(
        @Optional()
        @Inject(APP_SPEC_TELEMETRY_SINK)
        sink?: AppSpecTelemetrySink,
    ) {
        this.inner = new AppWorksTelemetryService(sink);
    }

    /** Emit one event. Never throws (the inner service catches everything). */
    track<E extends AppSpecTelemetryEvent>(
        event: E,
        properties: AppSpecTelemetryPayloads[E],
        distinctId?: string | null,
    ): void {
        try {
            this.inner.trackEvent(
                event,
                properties as unknown as Record<string, unknown>,
                distinctId ?? null,
            );
        } catch {
            // `trackEvent` already never throws; this guard keeps a caller's `void` honest.
        }
    }

    /** A copy of the counters, for diagnostics and specs. */
    stats(): AppWorksTelemetryStats {
        return this.inner.stats();
    }
}

/** UTF-8 byte length of a draft, without importing `Buffer` types into callers. */
export function appSpecDraftBytes(text: unknown): number {
    return typeof text === 'string' ? Buffer.byteLength(text, 'utf8') : 0;
}
