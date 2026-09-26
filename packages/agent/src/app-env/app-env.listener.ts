/**
 * APW-07 T15 — `AppEnvListener`: the in-process `app.spec.applied` handler.
 *
 * Plan §2.1:84-92 draws the fan-out — `app.spec.applied` reaches BOTH
 * `AppEnvService.ensureGenerated()` and `AppDependenciesService.reconcile()`,
 * and T15's task line (`tasks.md:226-231`) fixes the order between them:
 * generation first, then reconcile (plan §7:878 "Triggers: `app.spec.applied` →
 * `reconcile`").
 *
 * ## Why a listener and not a job (plan §7:866-867)
 *
 * Generation is "inserts only, milliseconds", so it runs **in process** and is
 * awaited: the handler's promise does not settle until the rows exist, which is
 * the property ACC-07-01's 60-second window (FR-9) is measured on. The second
 * line of defence is that every resolve calls `ensureGenerated` first, so a
 * missed event still cannot leave a generated value missing at Build or Deploy
 * time — this listener is the fast path, never the only path.
 *
 * ## What a failure may NOT do
 *
 * `ensureGenerated` throws → reported as `generationError`; a value that is
 * already stored is never touched by this handler (FR-12: a generated secret is
 * produced once and never implicitly rotated).
 *
 * `reconcile` throws → reported as `reconcileError`, and **nothing generation
 * just stored is rolled back, unset or deleted**. There is nothing to roll back
 * to: T8's `insertIfAbsent` committed the row and T9's envelope is the stored
 * form. So a reconcile failure is contained rather than propagated, which is
 * also this package's listener idiom (`InboxBudgetAlertListener`), and its
 * consequence is bounded rather than silent — `ensureReadyForDeploy` reconciles
 * again inside every Deploy preflight (plan §5:826, GAP-05), and APW-06's
 * target/cluster change, the card's 15-minute `refresh` and the user's Retry all
 * re-enter `reconcile` (plan §7:878-883).
 *
 * The two calls are SIBLINGS in plan §2.1's diagram (one event, two reactions),
 * so a generation failure does not cancel the reconcile: the dependency rows
 * still appear on the Dependencies tab, which is what the owner needs to fix the
 * configuration that blocked generation in the first place.
 *
 * ## 🛑 The event seam is PROVISIONAL, and it is APW-03's to own
 *
 * APW-03 (`tasks.md:101-103`, `CONTRACTS.md:327`) defines the event class at
 * `packages/agent/src/events/app-spec-applied.event.ts`, `EVENT_NAME =
 * 'app.spec.applied'`, payload `{ workId, commitSha, previousCommitSha,
 * specHash, addedDependencies, changedEnvNames, changedBlocks }` — and that file
 * does NOT exist in this tree. `grep -r "app\.spec\.applied" packages/**\/*.ts`
 * finds prose only (`app-env.resolver.ts:118`, `:365`, its spec), so T15 has no
 * class to subscribe to.
 *
 * This file therefore declares the NARROWEST working seam and no more:
 *
 * - {@link APP_ENV_SPEC_APPLIED_EVENT} — the canonical event-name STRING, so
 *   the listener, its spec and the eventual emitter cannot drift apart by
 *   typo; and
 * - {@link AppEnvListenerSpecAppliedEvent} — the one field this handler reads
 *   (`workId`) plus APW-03's other payload fields as OPTIONAL passthroughs, so
 *   a real `AppSpecAppliedEvent` instance is assignable here without this file
 *   having to re-declare (or narrow) the contract it does not own.
 *
 * **The swap when APW-03 lands** is two lines, both additive-safe:
 * `@OnEvent(APP_ENV_SPEC_APPLIED_EVENT)` → `@OnEvent(AppSpecAppliedEvent.EVENT_NAME)`,
 * and the parameter type → `AppSpecAppliedEvent`; delete nothing, because this
 * constant and type are also re-exported by the epic's barrel and a consumer may
 * legitimately keep using them. Whoever owns the module graph must ALSO register
 * this class as a provider (see the class docstring below) or Nest never scans
 * its `@OnEvent` metadata and the handler is never subscribed.
 *
 * ## The collaborators, and what an unbound one answers
 *
 * Both are `@Optional()`, matching every other collaborator in this epic
 * (`app-env.service.ts`, `app-dependencies.service.ts`, `app-env.resolver.ts`):
 * a lean module graph that provides the listener without one of the two services
 * must still bootstrap, and the outcome names the missing seam
 * (`envServiceUnavailable` / `dependenciesServiceUnavailable`) instead of
 * reporting a success that did not happen.
 *
 * ## ⚠️ Registration is NOT in this file (T15, reported, not fixed here)
 *
 * `app-env.module.ts:1-41` lists exactly what it binds — and says "and nothing
 * more"; its "seams this module does NOT bind" block names other owners' seams,
 * not this listener. So this class is deliberately NOT added to that module
 * (the module's own comment is the authority T15 defers to), and it is not in
 * `WorkModule` either, whose spec pins its provider/export counts
 * (`services/work.module.spec.ts:249-254`, `:323-339`). Routing: the module that
 * imports both `AppEnvModule` and `AppDependenciesModule` — APW-07 T24/T25's
 * `apps/api/src/app-env/app-env.module.ts` + `apps/api/src/api.module.ts`
 * (`tasks.md:362-364`, `:382`) — is where `AppEnvListener` belongs in `providers`
 * (never in `exports`: Nest scans a PROVIDER's prototypes, and a listener is
 * internal).
 *
 * ## Where it IS registered (2026-09-26) — once
 *
 * That module turned out to be `AppRuntimeEnvModule` (`app-runtime-env.module.ts`),
 * which imports both and provides this class — and only it. It reached the API on
 * 2026-09-26, when `AppDeployRequestModule` began importing it for the deploy
 * preconditions; before that it was imported nowhere, so the handler was subscribed
 * in no process. A class module is one instance however many modules import it, so
 * the listener is subscribed exactly once
 * (`app-runtime/__tests__/app-deploy-request.graph.spec.ts` asserts one listener on
 * the emitter `AppSpecService` publishes on). T24/T25's API modules should IMPORT
 * `AppRuntimeEnvModule`, never provide this class again: a second provider is a
 * second instance and a second subscription, and every `app.spec.applied` would
 * then generate and reconcile twice.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
    AppDependenciesService,
    type AppDependencyReconcileResult,
} from '../app-dependencies/app-dependencies.service';
import { AppSpecAppliedEvent } from '../events/app-spec-applied.event';
import { AppEnvService, type AppEnvEnsureGeneratedResult } from './app-env.service';

/**
 * `'app.spec.applied'` — PROVISIONAL (see the file docstring).
 *
 * The canonical definition is APW-03's `AppSpecAppliedEvent.EVENT_NAME` in
 * `packages/agent/src/events/app-spec-applied.event.ts` (`APW-03/tasks.md:101`).
 * This constant exists so this epic's subscriber, its spec and the future
 * emitter reference ONE string rather than three literals; the day APW-03's class
 * lands, `@OnEvent` takes `AppSpecAppliedEvent.EVENT_NAME` and this constant
 * keeps working for anyone already importing it.
 */
export const APP_ENV_SPEC_APPLIED_EVENT = 'app.spec.applied';

/**
 * The `app.spec.applied` payload as THIS handler needs it — PROVISIONAL.
 *
 * `workId` is the only field read. The rest mirror APW-03's documented payload
 * (`APW-03/tasks.md:102`) as optional fields so an `AppSpecAppliedEvent` is
 * assignable without this epic re-declaring a contract it does not own: a
 * handler that ignored `changedEnvNames`/`addedDependencies` is still correct,
 * because plan §2.1 fans the whole event out to generation and reconcile rather
 * than gating on those fields.
 */
export interface AppEnvListenerSpecAppliedEvent {
    readonly workId: string;
    readonly commitSha?: string | null;
    readonly previousCommitSha?: string | null;
    readonly specHash?: string | null;
    readonly addedDependencies?: readonly string[] | null;
    readonly changedEnvNames?: readonly string[] | null;
    readonly changedBlocks?: readonly string[] | null;
}

/**
 * Why the handler could not do its work. Every value is a NAMED absence, never a
 * silent success — the same convention `AppEnvEnsureGeneratedResult.reason`
 * (`app-env.service.ts:509`) and `AppDependencyReconcileResult.reason` follow.
 */
export type AppEnvListenerSkipReason =
    | 'workIdMissing'
    | 'envServiceUnavailable'
    | 'dependenciesServiceUnavailable';

/**
 * What one `app.spec.applied` produced. Carries **no value**: `generation.created`
 * holds names, versions and fingerprints (`app-env.service.ts:484-491`), and
 * `reconcile` holds kinds and flags only — so this object is safe to log or
 * return, which is what ACC-07-05's "no stored value in any output" needs.
 */
export interface AppEnvListenerOutcome {
    /** The event's `workId`, or `''` when the event carried none. */
    readonly workId: string;
    /** T13's report, or `null` when the pass threw or no service is bound. */
    readonly generation: AppEnvEnsureGeneratedResult | null;
    /** T16's report, or `null` when it threw or no service is bound. */
    readonly reconcile: AppDependencyReconcileResult | null;
    /** The generation failure's message, when it threw. */
    readonly generationError: string | null;
    /** The reconcile failure's message, when it threw. */
    readonly reconcileError: string | null;
    /** Set when a seam is unbound or the event was malformed. */
    readonly reason?: AppEnvListenerSkipReason;
    /** Wall-clock time of the whole handler — ACC-07-01's 60-second window. */
    readonly durationMs: number;
}

/**
 * `app.spec.applied` → `ensureGenerated` → `reconcile`.
 *
 * Registered as a provider by the module that imports both `AppEnvModule` and
 * `AppDependenciesModule` (see the file docstring — NOT `app-env.module.ts`),
 * exported for whoever wires APW-03's emit side.
 */
@Injectable()
export class AppEnvListener {
    private readonly logger = new Logger(AppEnvListener.name);

    constructor(
        @Optional() private readonly env?: AppEnvService,
        @Optional() private readonly dependencies?: AppDependenciesService,
    ) {}

    /**
     * The handler. `{ async: true }` so a slow dependency reconcile cannot block
     * the emitter's other subscribers (APW-05's build listener is on the same
     * event), while `ensureGenerated` is still awaited INSIDE this call — the
     * property ACC-07-01 is measured on.
     */
    @OnEvent(AppSpecAppliedEvent.EVENT_NAME, { async: true })
    async handleAppSpecApplied(
        event: AppSpecAppliedEvent | AppEnvListenerSpecAppliedEvent,
    ): Promise<AppEnvListenerOutcome> {
        const startedAt = Date.now();
        const workId = typeof event?.workId === 'string' ? event.workId.trim() : '';
        if (!workId) {
            this.logger.warn(
                'App env: app.spec.applied carried no workId — nothing was generated and nothing was reconciled.',
            );
            return {
                workId: '',
                generation: null,
                reconcile: null,
                generationError: null,
                reconcileError: null,
                reason: 'workIdMissing',
                durationMs: Date.now() - startedAt,
            };
        }

        let reason: AppEnvListenerSkipReason | undefined;
        let generation: AppEnvEnsureGeneratedResult | null = null;
        let generationError: string | null = null;

        if (!this.env) {
            reason = 'envServiceUnavailable';
            this.logger.warn(
                `App env: no AppEnvService is bound, so work ${workId}'s generated values were not produced.`,
            );
        } else {
            try {
                // AWAITED on purpose: the rows exist when this promise settles.
                generation = await this.env.ensureGenerated(workId);
            } catch (error) {
                generationError = errorText(error);
                this.logger.warn(
                    `App env: generation for work ${workId} failed (${generationError}); nothing already stored was changed.`,
                );
            }
        }

        let reconcile: AppDependencyReconcileResult | null = null;
        let reconcileError: string | null = null;

        if (!this.dependencies) {
            reason = reason ?? 'dependenciesServiceUnavailable';
            this.logger.warn(
                `App env: no AppDependenciesService is bound, so work ${workId}'s declared dependencies were not reconciled.`,
            );
        } else {
            try {
                reconcile = await this.dependencies.reconcile(workId);
            } catch (error) {
                reconcileError = errorText(error);
                this.logger.warn(
                    `App env: dependency reconcile for work ${workId} failed after its values were generated (${reconcileError}); the generated rows are kept as they are and the next Deploy preflight reconciles again.`,
                );
            }
        }

        const outcome: AppEnvListenerOutcome = {
            workId,
            generation,
            reconcile,
            generationError,
            reconcileError,
            durationMs: Date.now() - startedAt,
        };
        return reason ? { ...outcome, reason } : outcome;
    }
}

/** `error.message` when there is one, `String(error)` otherwise. */
function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
