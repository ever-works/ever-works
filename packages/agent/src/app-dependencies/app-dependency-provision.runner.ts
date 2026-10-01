/**
 * APW-07 T17 — `app-dependency-provision` runner (plan §7:864-888; spec FR-41,
 * FR-42, FR-43, FR-44, FR-45, FR-46).
 *
 * One run of this runner is one message on APW-06's `app-cluster-io` queue: the
 * isolated worker's job for "make this dependency exist / re-read it / release
 * it". It owns the four things a provider call cannot own for itself —
 * **the lease**, **the deadline**, **the re-dispatch** and **the release
 * verdict** — and delegates every decision about *what* to do to
 * `AppDependenciesService` (`runAttempt`, `onAppRemoved`, `onAppWorkDeleting`),
 * which is where the reconcile rules, the provider selection, the context
 * assembly, the outputs encryption and the Activity events live (plan §4.8,
 * T16's file). Nothing here re-implements them.
 *
 * ## The lifecycle of one kind, in order
 *
 * 1. **Lease.** `WorkAppDependencyRepository.claimLease` is the parameterised
 *    compare-and-set of plan §4.8:563-566. `null` means another worker is
 *    already dialling this row: this run leaves it alone and reports
 *    `leaseHeld` — the loser must never call the provider. The lease is handed
 *    back the moment the attempt settles ({@link AppDependencyProvisionRunner.releaseLease}):
 *    it protects a LIVE run, and a lease that outlived its run would make the
 *    five-minute re-dispatch below answer `leaseHeld` forever.
 * 2. **Deadline.** For a row that is `pending` the run is a continuation of a
 *    `pending` chain, so the kind's readiness deadline (FR-41: Postgres and
 *    object storage 10 minutes, Redis 5, mail 30 seconds) is checked BEFORE the
 *    provider is called. Past it the row is `failed deadlineExceeded` and
 *    nothing is dialled — a card that has said *Provisioning* for twelve
 *    minutes must stop saying it.
 * 3. **Attempt.** `AppDependenciesService.runAttempt(workId, kind, { mode, signal })`
 *    with an `AbortSignal` the runner aborts at the kind's deadline (FR-41 — a
 *    provider must stop when its budget is gone), then persist and events,
 *    which is the service's own work.
 * 4. **Re-dispatch, or not.** Two different budgets, deliberately not one:
 *    - a `pending` outcome means the provider is still working, so the SAME
 *      payload is re-dispatched after `retryAfterMs` **capped at 30 s**
 *      (plan §7:875-876) — and if the next attempt would land at or past the
 *      deadline, the kind fails `deadlineExceeded` instead of scheduling work
 *      nobody will honour;
 *    - a **transient** failure (`clusterUnreachable` — an unreachable API, a
 *      timeout) is retried after 5 minutes
 *      (`APP_DEPENDENCY_RETRY_DELAY_MS`) up to `APP_DEPENDENCY_TRANSIENT_ATTEMPTS`
 *      (3) attempts, which is FR-43's "3 times over 15 minutes" and ACC-07-20;
 *    - a **definite** failure (`noDefaultStorageClass`, `clusterPermissionMissing`,
 *      `namespaceNotOwned`, …) fails at once with its reason (FR-43).
 *
 *    Nothing sleeps: the delay rides the payload (`notBefore` / `deferUntil`) and
 *    the dispatcher turns it into the runtime's own `delay` (see
 *    `app-dependency-provision.types.ts`).
 * 5. **Release** (`mode: 'deprovision'`) never calls a provider from here. It
 *    hands the row to the service's release path, which is the only code that
 *    knows what "kept" means: `deleteData: false` → row `kept` +
 *    `app.dependency.released` (ACC-07-21), `deleteData: true` → row `deleted` +
 *    `app.dependency.data_deleted` (ACC-07-22).
 *
 * ## Why the running job re-dispatches instead of looping
 *
 * A worker that slept 5 minutes would hold its queue slot, could not be
 * cancelled, and would lose the whole chain on a deploy. Re-dispatching makes
 * every attempt its own observable run — which is also what the runtime's
 * dashboard, the retry counters and the `app.dependency.failed` event are
 * written against.
 *
 * ## Everything is optional, and every absence has an answer
 *
 * Like `AppDependenciesService` itself, this runner is constructible with
 * nothing bound (a lean module graph, this file's own spec), and no absence is
 * answered with "pretend it worked":
 *
 * | Absent seam                            | The answer                                                            |
 * | -------------------------------------- | --------------------------------------------------------------------- |
 * | `AppDependenciesService`               | `serviceUnavailable` — nothing is dialled and nothing is re-dispatched  |
 * | `WorkAppDependencyRepository`          | `storeUnavailable` — a run that cannot claim a lease must not dial       |
 * | `APP_DEPENDENCY_PROVISION_DISPATCHER`  | the verdict is reported, no re-dispatch is scheduled (`dispatcherUnavailable`) |
 * | `Repository<WorkAppDependency>`        | the deadline verdict is reported without the row patch                  |
 * | `APP_RUNTIME_EVENT_SINK`               | no Activity row; the row's own status is still the record                |
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
    APP_DEPENDENCY_RETRY_DELAY_MS,
    APP_DEPENDENCY_TRANSIENT_ATTEMPTS,
    appDependencyReadyDeadlineMs,
    type AppDependencyKind,
} from '@ever-works/contracts';
import { WorkAppDependency } from '../entities/work-app-dependency.entity';
import { WorkAppDependencyRepository } from '../database/repositories/work-app-dependency.repository';
import { APP_RUNTIME_EVENT_SINK, type AppRuntimeEventSink } from '../app-runtime/ports';
import {
    APP_DEPENDENCY_PROVISION_DISPATCHER,
    type AppDependencyProvisionDispatcher,
} from '../tasks/app-dependency-provision-dispatcher';
import type {
    AppDependencyProvisionMode,
    AppDependencyProvisionPayload,
} from '../tasks/app-dependency-provision.types';
import {
    AppDependenciesService,
    AppDependencyRefusalError,
    type AppDependencyAttemptResult,
} from './app-dependencies.service';

/* -------------------------------------------------------------------------- *
 * Limits and shapes the callers read
 * -------------------------------------------------------------------------- */

/**
 * The longest a `pending` outcome may defer its own re-dispatch (plan §7:875-876
 * — "`pending` outcomes re-dispatch after `retryAfterMs` (≤ 30 s) until the
 * deadline"). A provider asking for longer than this is answered with this
 * cap: the Dependencies page polls while a card is `pending`, and a card that
 * moves once every ten minutes reads as broken.
 */
export const APP_DEPENDENCY_PROVISION_MAX_REDISPATCH_MS = 30_000 as const;

/** How long one claim holds a row. Longer than any kind's deadline, so a live run is never taken over. */
export const APP_DEPENDENCY_PROVISION_LEASE_MS = 900_000 as const;

/** What one kind's run did. */
export interface AppDependencyProvisionKindResult {
    kind: AppDependencyKind;
    /**
     * A **string** discriminant on purpose: `packages/agent` compiles with
     * `strictNullChecks: false`, under which a boolean flag does not narrow a
     * union for the caller — a string does.
     */
    status: 'ready' | 'pending' | 'failed' | 'skipped' | 'released' | 'deleted';
    /** A reason from the contract's closed vocabulary, when there is one. */
    reason?: string;
    /** Epoch ms the runner asked the runtime to run this kind again at (re-dispatch only). */
    notBefore?: number;
    /** The row's `outputsVersion` once the attempt produced one (FR-44). */
    outputsVersion?: number;
}

/** What one run of the job did — all kinds, plus the re-dispatches it scheduled. */
export interface AppDependencyProvisionRunResult {
    workId: string;
    mode: AppDependencyProvisionMode;
    kinds: AppDependencyProvisionKindResult[];
    /** The payloads this run enqueued, exactly as they were sent (empty for a settled run). */
    redispatch: AppDependencyProvisionPayload[];
    /** Set when the run could not do anything at all (`serviceUnavailable`, `storeUnavailable`, …). */
    reason?: string;
}

/* -------------------------------------------------------------------------- *
 * The runner
 * -------------------------------------------------------------------------- */

@Injectable()
export class AppDependencyProvisionRunner {
    private readonly logger = new Logger(AppDependencyProvisionRunner.name);

    constructor(
        // The decision-maker: reconcile rules, provider selection, context
        // assembly, outputs encryption and the Activity events are all T16's.
        @Optional() private readonly dependencies?: AppDependenciesService,
        // The lease and the row reads live here (T8's repository).
        @Optional() private readonly store?: WorkAppDependencyRepository,
        // The job's own enqueue path — the same symbol the service dispatches
        // through, so a re-dispatch is indistinguishable from a first dispatch.
        @Optional()
        @Inject(APP_DEPENDENCY_PROVISION_DISPATCHER)
        private readonly dispatcher?: AppDependencyProvisionDispatcher,
        @Optional()
        @Inject(APP_RUNTIME_EVENT_SINK)
        private readonly events?: AppRuntimeEventSink,
        // The deadline verdict's row patch. It is the entity repository rather
        // than a named method because T8's method list (`findActiveByWork`,
        // `findByWorkAndKind`, `claimLease`, `markKept`, `markDeleted`,
        // `updateOutputs`) deliberately has no `markFailed`, and the service's
        // own `recordAttemptFailure` is private — the deadline is the JOB's
        // verdict (plan §7:875), so the job writes it.
        @Optional()
        @InjectRepository(WorkAppDependency)
        private readonly rows?: Repository<WorkAppDependency>,
    ) {}

    /** The clock, as a method, so a spec can pin an instant without touching a global. */
    protected nowMs(): number {
        return Date.now();
    }

    /**
     * Run one `app-dependency-provision` message.
     *
     * Never throws for a dependency-level problem: a kind that fails is a kind
     * that is REPORTED as failed (with its row and its event written by the
     * service). It throws only for a payload that cannot be acted on at all —
     * `workId` or `mode` missing — because that is a producer bug, and a
     * silently acked message would hide it forever.
     */
    async run(payload: AppDependencyProvisionPayload): Promise<AppDependencyProvisionRunResult> {
        const mode: AppDependencyProvisionMode | undefined = payload?.mode;
        if (!payload?.workId || !mode) {
            throw new Error(
                'app-dependency-provision: a payload needs a workId and a mode ' +
                    '(provision | refresh | deprovision).',
            );
        }

        const result: AppDependencyProvisionRunResult = {
            workId: payload.workId,
            mode,
            kinds: [],
            redispatch: [],
        };

        if (!this.dependencies) {
            result.reason = 'serviceUnavailable';
            return result;
        }
        if (!this.store) {
            // A run that cannot claim a lease must not dial: without one, two
            // workers would provision the same row at the same time.
            result.reason = 'storeUnavailable';
            return result;
        }

        const kinds = await this.kindsFor(payload);
        if (kinds.length === 0) {
            result.reason = 'noDependencies';
            return result;
        }

        for (const kind of kinds) {
            const kindResult =
                mode === 'deprovision'
                    ? await this.release(payload, kind)
                    : await this.attempt(payload, kind, mode);
            result.kinds.push(kindResult);

            const scheduled = await this.schedule(payload, kindResult);
            if (scheduled) result.redispatch.push(scheduled);
        }

        return result;
    }

    /* ---------------------------------------------------------------------- *
     * One kind
     * ---------------------------------------------------------------------- */

    /**
     * Claim the lease, check the deadline, ask the service for one attempt and
     * translate its verdict into this run's next step.
     *
     * The lease is **released when the attempt settles** (see
     * {@link releaseLease}) — it protects a live run, not a finished one, and a
     * `pending` chain's next attempt is five minutes away by design.
     */
    private async attempt(
        payload: AppDependencyProvisionPayload,
        kind: AppDependencyKind,
        mode: AppDependencyProvisionMode,
    ): Promise<AppDependencyProvisionKindResult> {
        const store = this.store as WorkAppDependencyRepository;

        const row = await store.findByWorkAndKind(payload.workId, kind);
        if (!row) {
            // `reconcile` creates the row it dispatches, so this means the row
            // was released or deleted between enqueue and run — not a reason to
            // dial anything, and not a reason to retry either.
            return { kind, status: 'failed', reason: 'dependencyNotDeclared' };
        }

        const lease = await store.claimLease(row.id, APP_DEPENDENCY_PROVISION_LEASE_MS);
        if (!lease) {
            return { kind, status: 'skipped', reason: 'leaseHeld' };
        }

        try {
            return await this.attemptClaimed(payload, kind, mode, lease.status);
        } finally {
            await this.releaseLease(row.id, lease.provisionLeaseUntil ?? null);
        }
    }

    /** The attempt itself, with the lease already held. */
    private async attemptClaimed(
        payload: AppDependencyProvisionPayload,
        kind: AppDependencyKind,
        mode: AppDependencyProvisionMode,
        rowStatus: string,
    ): Promise<AppDependencyProvisionKindResult> {
        const store = this.store as WorkAppDependencyRepository;
        const dependencies = this.dependencies as AppDependenciesService;

        const requestedAtMs = payload.requestedAtMs ?? this.nowMs();
        const deadlineAtMs = requestedAtMs + appDependencyReadyDeadlineMs(kind);

        // The row's own status says WHY this run exists: a `pending` row is a
        // continuation of a `pending` chain (deadline-governed), a
        // `provisioning` row is a transient-failure retry (attempt-governed).
        // Reading the discriminator off the persisted state keeps the two
        // budgets apart without a second payload field to drift.
        if (rowStatus === 'pending' && this.nowMs() >= deadlineAtMs) {
            return this.deadlineExceeded(payload, kind);
        }

        const abort = this.abortAt(deadlineAtMs);
        let attempt: AppDependencyAttemptResult;
        try {
            attempt = await dependencies.runAttempt(payload.workId, kind, {
                mode: mode === 'refresh' ? 'refresh' : 'provision',
                signal: abort.signal,
            });
        } catch (error) {
            if (error instanceof AppDependencyRefusalError) {
                return { kind, status: 'failed', reason: error.code };
            }
            this.logger.warn(
                `app-dependency-provision: ${kind} of work ${payload.workId} threw: ${
                    error instanceof Error ? error.name : typeof error
                }`,
            );
            return { kind, status: 'failed', reason: 'clusterUnreachable' };
        } finally {
            abort.dispose();
        }

        if (attempt.state === 'ready') {
            return { kind, status: 'ready', outputsVersion: attempt.outputsVersion };
        }

        if (attempt.state === 'pending') {
            const retryAfterMs = Math.min(
                Math.max(0, Number(attempt.retryAfterMs ?? 0)),
                APP_DEPENDENCY_PROVISION_MAX_REDISPATCH_MS,
            );
            // Scheduling a re-dispatch that lands after the deadline would only
            // produce a run that fails on entry: fail now, with the reason the
            // card can render (FR-41).
            if (this.nowMs() + retryAfterMs >= deadlineAtMs) {
                return this.deadlineExceeded(payload, kind);
            }
            return { kind, status: 'pending', notBefore: this.nowMs() + retryAfterMs };
        }

        // `failed`. A definite reason is final immediately (FR-43); a transient
        // one gets the 3-attempts / 15-minutes allowance, whose counter the
        // service has just incremented on the row.
        if (attempt.transient === true) {
            const attempts = (await store.findByWorkAndKind(payload.workId, kind))?.attempts ?? 1;
            if (attempts < APP_DEPENDENCY_TRANSIENT_ATTEMPTS) {
                return {
                    kind,
                    status: 'failed',
                    reason: attempt.reason,
                    notBefore: this.nowMs() + APP_DEPENDENCY_RETRY_DELAY_MS,
                };
            }
        }

        return { kind, status: 'failed', reason: attempt.reason };
    }

    /**
     * `mode: 'deprovision'` — hand the row to the service's release path.
     *
     * Two entries, deliberately, and each for a reason the service's own code
     * fixes:
     *
     * - **delete** (`deleteData: true`) → `onAppRemoved({ deleteData: true })`.
     *   `requestDataDeletion` marks the row `deleting` before it dispatches this
     *   job, and `onAppWorkDeleting` treats a `deleting` row as *never
     *   provisioned* (its first table row) — it would mark it `kept` and delete
     *   nothing. `onAppRemoved` has no such skip, so it is the path that
     *   actually reaches `provider.deprovision(…, { deleteData: true })`, the
     *   row `deleted`, and `app.dependency.data_deleted` (ACC-07-22, FR-46).
     * - **keep** (`deleteData` absent/false) → `onAppWorkDeleting({ deleteStoredData: false })`.
     *   It is the only public release entry that emits `app.dependency.released`
     *   for a kept row (ACC-07-21, FR-45/FR-56); `onAppRemoved({ deleteData: false })`
     *   marks the row `kept` and, by its own spec, makes NO provider call and
     *   records no event — which would leave the Activity log with no record of
     *   what was kept.
     *
     * Both calls are idempotent (plan §4.12:762): a re-dispatched release finds
     * `kept`/`deleted` rows and does nothing.
     */
    private async release(
        payload: AppDependencyProvisionPayload,
        kind: AppDependencyKind,
    ): Promise<AppDependencyProvisionKindResult> {
        const store = this.store as WorkAppDependencyRepository;
        const dependencies = this.dependencies as AppDependenciesService;

        const row = await store.findByWorkAndKind(payload.workId, kind);
        if (!row) {
            return { kind, status: 'skipped', reason: 'dependencyNotDeclared' };
        }

        const lease = await store.claimLease(row.id, APP_DEPENDENCY_PROVISION_LEASE_MS);
        if (!lease) {
            return { kind, status: 'skipped', reason: 'leaseHeld' };
        }

        try {
            return await this.releaseClaimed(payload, kind, row.id);
        } finally {
            await this.releaseLease(row.id, lease.provisionLeaseUntil ?? null);
        }
    }

    /** The release itself, with the lease already held. */
    private async releaseClaimed(
        payload: AppDependencyProvisionPayload,
        kind: AppDependencyKind,
        rowId: string,
    ): Promise<AppDependencyProvisionKindResult> {
        const dependencies = this.dependencies as AppDependenciesService;

        try {
            payload.deleteData === true
                ? await dependencies.onAppRemoved(payload.workId, { deleteData: true })
                : await dependencies.onAppWorkDeleting(payload.workId, {
                      deleteStoredData: false,
                  });
        } catch (error) {
            if (error instanceof AppDependencyRefusalError) {
                return { kind, status: 'failed', reason: error.code };
            }
            this.logger.warn(
                `app-dependency-provision: releasing ${kind} of work ${payload.workId} threw: ${
                    error instanceof Error ? error.name : typeof error
                }`,
            );
            return { kind, status: 'failed', reason: 'clusterUnreachable' };
        }

        // The row's own status is the record of what happened — `kept` and
        // `deleted` are exactly the two things a release can produce. It is read
        // through the ENTITY repository, not `findByWorkAndKind`, because the
        // latter deliberately never returns a `deleted` row (T8's docstring) and
        // a delete would otherwise look like a release that never happened.
        const status = await this.rowStatus(rowId, payload.workId, kind);
        if (status === 'deleted') return { kind, status: 'deleted' };
        if (status === 'kept') return { kind, status: 'released' };
        // The provider could not be reached: the row is deliberately left as it
        // was and the resources are reported as possibly still present, which is
        // the one honest answer (FR-45's promise is about what was KEPT).
        return { kind, status: 'failed', reason: 'clusterUnreachable' };
    }

    /** One row's status, from the entity repository when it is bound. */
    private async rowStatus(
        rowId: string,
        workId: string,
        kind: AppDependencyKind,
    ): Promise<string | null> {
        if (this.rows) {
            try {
                const stored = await this.rows.findOne({ where: { id: rowId } });
                if (stored?.status) return stored.status;
            } catch (error) {
                this.logger.warn(
                    `app-dependency-provision: could not read row ${rowId}: ${
                        error instanceof Error ? error.name : typeof error
                    }`,
                );
            }
        }
        const fallback = await this.store?.findByWorkAndKind(workId, kind);
        return fallback?.status ?? null;
    }

    /**
     * Hand the row back to the pool when the run is done with it.
     *
     * The claim is a compare-and-set on `provisionLeaseUntil`, and a claim that
     * was never given back would outlive the run it protected: the next
     * re-dispatch (five minutes later, by FR-43's spacing) would answer
     * `leaseHeld` and the chain would stop dead — which is exactly the kind of
     * "card says Provisioning forever" failure the lease exists to prevent, not
     * to cause. T8's repository has no `releaseLease` (its method list is
     * `findActiveByWork`, `findByWorkAndKind`, `claimLease`, `markKept`,
     * `markDeleted`, `updateOutputs`), so the release goes through the same
     * entity repository the deadline verdict uses, and it is a compare-and-clear
     * on the instant THIS run set: if the lease had already expired and another
     * worker claimed it, this run clears nothing.
     *
     * A worker that dies mid-run leaves the lease alone and it expires on its
     * own after {@link APP_DEPENDENCY_PROVISION_LEASE_MS} — the safety net the
     * timestamp compare-and-set is there for.
     */
    private async releaseLease(rowId: string, heldUntil: Date | string | null): Promise<void> {
        if (!this.rows || !heldUntil || !rowId) return;
        try {
            await this.rows.update(
                { id: rowId, provisionLeaseUntil: new Date(heldUntil) } as never,
                { provisionLeaseUntil: null } as never,
            );
        } catch (error) {
            this.logger.warn(
                `app-dependency-provision: could not release the lease on row ${rowId}: ${
                    error instanceof Error ? error.name : typeof error
                }`,
            );
        }
    }

    /* ---------------------------------------------------------------------- *
     * Re-dispatch
     * ---------------------------------------------------------------------- */

    /**
     * Enqueue the next run of this kind when the verdict asks for one.
     *
     * The payload is the same one, with the chain's original `requestedAtMs`
     * and the computed instant in both spellings — never a sleep, never an
     * in-process timer (plan §7:864-888).
     */
    private async schedule(
        payload: AppDependencyProvisionPayload,
        result: AppDependencyProvisionKindResult,
    ): Promise<AppDependencyProvisionPayload | null> {
        if (result.notBefore === undefined) return null;

        const next: AppDependencyProvisionPayload = {
            ...payload,
            kind: result.kind,
            mode: 'provision',
            requestedAtMs: payload.requestedAtMs ?? this.nowMs(),
            notBefore: result.notBefore,
            deferUntil: new Date(result.notBefore).toISOString(),
        };

        if (!this.dispatcher) {
            this.logger.warn(
                `app-dependency-provision: no dispatcher is bound, so ${result.kind} for work ` +
                    `${payload.workId} will not be re-run.`,
            );
            return null;
        }

        try {
            await this.dispatcher.dispatchAppDependencyProvision(next);
            return next;
        } catch (error) {
            // The run id is not needed by the caller, but the throw IS the
            // signal (APW07-G24): log it and report that nothing was scheduled
            // rather than letting a rejected enqueue look like a scheduled run.
            this.logger.error(
                `app-dependency-provision: re-dispatch of ${result.kind} for work ` +
                    `${payload.workId} was rejected: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                error as Error,
            );
            return null;
        }
    }

    /* ---------------------------------------------------------------------- *
     * Internals
     * ---------------------------------------------------------------------- */

    /** The kinds this run is for — the named one, or every active dependency of the Work. */
    private async kindsFor(payload: AppDependencyProvisionPayload): Promise<AppDependencyKind[]> {
        if (payload.kind) return [payload.kind];
        const active = (await this.store?.findActiveByWork(payload.workId)) ?? [];
        return active.map((row) => row.kind);
    }

    /**
     * The kind's deadline verdict: the row is `failed deadlineExceeded`, the
     * Activity row says so, and no provider is dialled (FR-41, plan §7:875).
     */
    private async deadlineExceeded(
        payload: AppDependencyProvisionPayload,
        kind: AppDependencyKind,
    ): Promise<AppDependencyProvisionKindResult> {
        const store = this.store as WorkAppDependencyRepository;
        const row = await store.findByWorkAndKind(payload.workId, kind);

        if (row?.id && this.rows) {
            try {
                await this.rows.update(
                    { id: row.id },
                    // Names and constants only, never a value (plan §9.1).
                    {
                        status: 'failed',
                        statusReason: 'deadlineExceeded',
                        statusDetail: null,
                    } as never,
                );
            } catch (error) {
                this.logger.warn(
                    `app-dependency-provision: could not record deadlineExceeded for ${kind} of ` +
                        `work ${payload.workId}: ${
                            error instanceof Error ? error.name : typeof error
                        }`,
                );
            }
        }

        await this.emit('app.dependency.failed', payload, kind, { reason: 'deadlineExceeded' });

        return { kind, status: 'failed', reason: 'deadlineExceeded' };
    }

    /**
     * An `AbortSignal` that fires at the kind's readiness deadline, plus the
     * disposal that clears the timer. `unref` so a pending abort never keeps a
     * worker process (or a spec) alive.
     */
    private abortAt(deadlineAtMs: number): { signal: AbortSignal; dispose(): void } {
        const controller = new AbortController();
        const remainingMs = Math.max(0, deadlineAtMs - this.nowMs());
        const timer = setTimeout(() => controller.abort(), remainingMs);
        (timer as { unref?: () => void }).unref?.();

        return {
            signal: controller.signal,
            dispose: () => clearTimeout(timer),
        };
    }

    /** One Activity event — kinds and reasons only, never a value (plan §9.1:926-943). */
    private async emit(
        name: string,
        payload: AppDependencyProvisionPayload,
        kind: AppDependencyKind,
        extra: Record<string, unknown>,
    ): Promise<void> {
        if (!this.events) return;
        try {
            await this.events.emit({
                name,
                payload: { workId: payload.workId, kind, ...extra },
            });
        } catch (error) {
            this.logger.warn(
                `app-dependency-provision: Activity event ${name} could not be written: ${
                    error instanceof Error ? error.name : typeof error
                }`,
            );
        }
    }
}
