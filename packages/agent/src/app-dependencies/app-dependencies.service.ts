/**
 * APW-07 T16 — `AppDependenciesService`: reconcile, readiness, release and the
 * card's own reads (plan §2.3, §4.8, §4.9, §4.9a, §4.12).
 *
 * Spec: `docs/specs/features/app-works/APW-07-app-env-and-dependencies/spec.md`
 * FR-35…FR-50, FR-56…FR-63. Plan: §2.3 is the reconcile diagram this file
 * implements, §4.8 names the entry points, §4.9a adds `awaiting_config` and
 * §4.12 is the release/deletion table.
 *
 * ## What this service owns, and what it deliberately does not
 *
 * It owns the **decisions**: which rows exist, which provider serves each kind,
 * which state each row is in, what a release does, what the card is allowed to
 * see. It does not own the **queue**: `app-dependency-provision` and its
 * re-dispatch timing are T17's (`app-dependency-provision.runner.ts`), reached
 * here through the {@link AppDependencyProvisionDispatcher} seam. A missing
 * dispatcher is reported, never worked around — a reconcile that silently
 * "succeeded" with nothing scheduled is how a card sits at *Pending* forever.
 *
 * ## The four transitions `reconcile` implements (plan §2.3:154-168)
 *
 * | The spec says                | The row becomes                                                                              |
 * | ---------------------------- | -------------------------------------------------------------------------------------------- |
 * | a kind the Work did not have | `pending` **and dispatched**, or `awaiting_config` with **no dispatch and no deadline** (§4.9a) |
 * | a kind that left the spec    | `inSpec = false`, nothing deprovisioned, no dispatch                                          |
 * | the deploy target changed    | the old row `kept`, then the new row `pending` (and dispatched)                                |
 * | the target is `none`         | every row `kept` — nothing is provisioned (FR-35, spec §6.5)                                   |
 *
 * Ordering matters in the target-change case and is not cosmetic: the partial
 * unique index is on `(workId, kind) WHERE status NOT IN ('kept','deleted')`
 * (plan §3.2:225), so the old row must be `kept` **before** the new one is
 * inserted or the insert is refused.
 *
 * ## Never deletes data
 *
 * FR-45/FR-56: removing a kind from the spec, changing the target, releasing on
 * App Work deletion and `onAppRemoved({ deleteData: false })` all keep the
 * volume, the database or the bucket. The ONLY paths that destroy anything are
 * the explicit delete-data ones — `onAppRemoved({ deleteData: true })`,
 * `onAppWorkDeleting({ deleteStoredData: true })` and `requestDataDeletion`
 * after the typed slug — and each of those is the only place
 * `provider.deprovision(…, { deleteData: true })` is ever reached.
 *
 * ## Every collaborator is optional, and every absence has an answer
 *
 * The class must be constructible with nothing bound (a lean module graph, this
 * file's own spec), so every dependency is `@Optional()` in a fixed order. None
 * of the absent answers is "pretend it worked":
 *
 * | Absent seam                        | The answer                                                                       |
 * | ---------------------------------- | -------------------------------------------------------------------------------- |
 * | `AppDependencySpecSource` (APW-03) | `reconcile` reports `specUnavailable` and changes nothing                          |
 * | `AppDependencyFacadeService`       | a declared kind with no row is reported `providerNotSupported`, never invented      |
 * | `AppDependencyProvisionDispatcher` | the row stays `pending`, `dispatchUnavailable: true`, and the caller retries        |
 * | `WorkAppDependencyRepository`      | reads answer `[]`/`null`, so nothing is released and nothing is claimed             |
 * | `Repository<WorkAppDependency>`    | no row can be created: `reconcile` reports it and schedules nothing                 |
 * | `AppDependencyConfigCipher` (T9)   | `configure` refuses (`secureStorageUnavailable`); a plaintext config is never stored |
 * | `APP_DEPENDENCY_CLUSTER_ACCESS`    | a provider that needs a cluster is not called; the row is reported `mayRemain`      |
 * | `AppRuntimeTargetPort` (APW-06)    | an attempt fails with `target_not_checked` and nothing is dialled                   |
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
    APP_DEPENDENCY_BUCKET_OUTPUT_PREFIX,
    APP_DEPENDENCY_KINDS,
    APP_DEPENDENCY_TRANSIENT_ATTEMPTS,
    appDependencyBlocksDeploy,
    appDependencyDefaultSizeGiB,
    appDependencyOutputNames,
    appDependencyReadyDeadlineMs,
    canDeleteAppDependencyData,
    isAppDependencyOutputSecret,
    isAppDependencyReason,
    isAppDependencySizeChangeAllowed,
    type AppDependencyBackupState,
    type AppDependencyBackupView,
    type AppDependencyKind,
    type AppDependencyOutputRef,
    type AppDependencyReason,
    type AppDependencyResourceRefs,
    type AppDependencyStatus,
    type AppDependencyStatusDetail,
    type AppDependencyTarget,
    type AppDependencyView,
    type AppDeployTarget,
} from '@ever-works/contracts';
import type { AppDependencyContext, IAppDependencyProvider } from '@ever-works/plugin';
import {
    WorkAppDependencyRepository,
    type WorkAppDependencyMetadata,
} from '../database/repositories/work-app-dependency.repository';
import { WorkAppDependency } from '../entities/work-app-dependency.entity';
import {
    APP_RUNTIME_EVENT_SINK,
    APP_RUNTIME_TARGET,
    type AppRuntimeEventSink,
    type AppRuntimeTargetPort,
    type AppRuntimeTargetUnavailable,
} from '../app-runtime/ports';
import {
    AppDependencyFacadeService,
    type AppDependencyFacadeOptions,
    type AppDependencySelection,
} from '../facades/app-dependency.facade';

/* -------------------------------------------------------------------------- *
 * Shapes the callers read
 * -------------------------------------------------------------------------- */

/** One dependency that is not ready, and why (APW-06's Deploy preflight, plan §4.8:558-559). */
export interface AppDependencyNotReady {
    kind: AppDependencyKind;
    status: AppDependencyStatus;
    /** A reason code from the closed vocabulary, or a raw `prepareDependencyTarget` discriminant. */
    reason: string | null;
}

/** `ensureReadyForDeploy`'s answer. `reason` is set only when the question could not be answered. */
export interface AppDependencyReadiness {
    ready: boolean;
    notReady: AppDependencyNotReady[];
    /** Declared kinds whose provider makes them optional (FR-62's `smtp.required: false`). */
    optional: AppDependencyKind[];
    /** Set when the App spec or the deploy target could not be read — then `ready` is `false`. */
    reason?: string;
}

/** What one `reconcile` did, per kind. Kinds, never values. */
export interface AppDependencyReconcileResult {
    workId: string;
    /** `null` when the App spec or the target could not be read — nothing was changed. */
    deployTarget: AppDeployTarget | null;
    created: AppDependencyKind[];
    awaitingConfig: AppDependencyKind[];
    dispatched: AppDependencyKind[];
    /** Kinds whose existing row was marked `kept` (target change / target `none`). */
    kept: AppDependencyKind[];
    /** Kinds that left the App spec and were marked `inSpec: false`. */
    outOfSpec: AppDependencyKind[];
    unsupported: Array<{ kind: AppDependencyKind; reason: string }>;
    /** True when something needed dispatching and no dispatcher is bound. */
    dispatchUnavailable: boolean;
    /** Set when nothing could be reconciled at all. */
    reason?: string;
}

/** One dependency as a page lists it — the card, plus the names a delete dialog needs. */
export interface AppDependencyListEntry extends AppDependencyView {
    /** The provider's own label, hoisted for the delete preview (plan §5:794). */
    label: string;
    /** Bare object names from `resourceRefs.objects` — names only, never a value. */
    names: string[];
}

/** The report §4.12's table and APW-06's deletion service both read. */
export interface AppDependencyDeletionReport {
    kept: Array<{ kind: string; name: string }>;
    mayRemain: Array<{ kind: string; name: string }>;
    /** True when a provider reported `pending`/`remaining` on the delete path. */
    remaining: boolean;
}

/** The refusal codes a write path can answer with — the controller maps each to its status. */
export type AppDependencyRefusalCode =
    | 'dependencyNotDeclared'
    | 'confirmationMismatch'
    | 'deleteInProgress'
    | 'sizeShrinkRefused'
    | 'providerNotSupported'
    | 'secureStorageUnavailable';

/** The typed refusal every write path throws. */
export class AppDependencyRefusalError extends Error {
    constructor(
        readonly code: AppDependencyRefusalCode,
        message: string,
        readonly status: number,
    ) {
        super(message);
        this.name = 'AppDependencyRefusalError';
    }
}

/** What one attempt against a provider produced. T17's runner turns this into a re-dispatch. */
export interface AppDependencyAttemptResult {
    kind: AppDependencyKind;
    state: 'ready' | 'pending' | 'failed';
    /** A definite reason, present on `failed`. */
    reason?: string;
    /** True when a retry can help (FR-43's three attempts over fifteen minutes). */
    transient?: boolean;
    /** What a `pending` outcome asked the runner to wait before re-dispatching. */
    retryAfterMs?: number;
    /** The row's `outputsVersion` when outputs changed on this attempt. */
    outputsVersion?: number;
}

/** `provisionEphemeral`'s answer (plan §5:831-833) — outputs in memory, never stored (R-10). */
export interface AppEphemeralProvisionResult {
    outputs: Partial<Record<AppDependencyKind, Record<string, string>>>;
    failed: Array<{ kind: AppDependencyKind; reason: string }>;
}

/** `provisionEphemeral`'s object form (plan §5:831) — the positional form is what APW-06 calls. */
export interface AppEphemeralProvisionOptions {
    readonly namespace: string;
    readonly kinds: readonly string[];
    readonly signal?: AbortSignal;
}

/** The two shapes a single row's context can be assembled from. */
interface RowContextInput {
    workId: string;
    kind: AppDependencyKind;
    deployTarget: AppDeployTarget;
    declared: Record<string, unknown>;
    sizeGiB: number | null;
    appName?: string;
    providerPluginId?: string;
}

/* -------------------------------------------------------------------------- *
 * Provisional seams — every one of them is another owner's, named as its owner
 * fixes it (the programme's established pattern: `app-runtime/ports.ts`,
 * `app-runtime-deletion.service.ts:276-390`).
 * -------------------------------------------------------------------------- */

// ── provisional — APW-03 T12 `AppSpecService` + APW-06 T17 ───────────────────
//
// `AppSpecService` (`packages/agent/src/app-spec/app-spec.service.ts`) does not
// exist in this tree: APW-03 owns it, and its read is
// `getEffectiveSpec(workId, commitSha?)` (`APW-03/tasks.md:274`). The deploy
// target is APW-06's `work_app_runtime_states.target`, read through
// `WORK_APP_RUNTIME_STATES.getOrCreate(workId)` (the token APW-11 T5 declared in
// `app-launcher.service.ts:223` — reused, never re-declared: a second Symbol of
// the same name is a different token, which is the drift
// `app-runtime-deletion.service.ts:289-292` warns about).
//
// The swap is one adapter, bound by APW-07's module owner (T25):
// `{ provide: APP_DEPENDENCY_SPEC_SOURCE, useExisting: … }`. Nothing else in
// this file changes.

/** The declared dependencies of one App Work, and where it deploys. */
export interface AppDependencySpecSnapshot {
    readonly deployTarget: AppDeployTarget;
    readonly appName: string;
    readonly dependencies: readonly AppDependencySpecEntry[];
}

/** One declared kind: the App spec block, and whether the spec makes it required (FR-62). */
export interface AppDependencySpecEntry {
    readonly kind: AppDependencyKind;
    readonly declared: Record<string, unknown>;
    readonly required: boolean;
}

/** The effective App spec + deploy target, for one Work. */
export interface AppDependencySpecSource {
    read(workId: string): Promise<AppDependencySpecSnapshot | null>;
}

/** DI token for {@link AppDependencySpecSource} — bound by APW-07's module owner (T25). */
export const APP_DEPENDENCY_SPEC_SOURCE = Symbol('APP_DEPENDENCY_SPEC_SOURCE');

// ── APW-07 T17 — the `app-dependency-provision` dispatcher (landed) ──────────
//
// These three names were declared **provisionally** here while T17 was in flight,
// with a warning that a temporary `Symbol` and T17's real one are two different
// keys: leaving both in place would let the binding in `TriggerModule` resolve
// nothing, and every dispatch would report `dispatchUnavailable` **silently**.
// T17 has landed (`packages/agent/src/tasks/app-dependency-provision-dispatcher.ts`
// and `…types.ts`), so the declarations are gone and the real ones are imported and
// **re-exported under the same names** — a consumer that imported them from this
// module keeps compiling and, more importantly, keeps receiving the one token that
// is actually bound.
import {
    APP_DEPENDENCY_PROVISION_DISPATCHER,
    type AppDependencyProvisionDispatcher,
} from '../tasks/app-dependency-provision-dispatcher';
import type { AppDependencyProvisionPayload } from '../tasks/app-dependency-provision.types';

export { APP_DEPENDENCY_PROVISION_DISPATCHER };
export type { AppDependencyProvisionDispatcher, AppDependencyProvisionPayload };

// ── provisional — APW-07 T9 `AppEnvCrypto` ───────────────────────────────────
//
// `packages/agent/src/app-env/app-env-crypto.ts` (T9) is the epic's one
// encryption surface: `encrypt` refuses without a key in every `NODE_ENV` with
// `AppEnvEncryptionUnavailableError` (→ `secureStorageUnavailable`), and
// `decrypt` refuses anything without the `enc::v1::` prefix (plan §4.1:355-359).
// It is shared deliberately: prompted provider configuration and dependency
// outputs are the same kind of secret as an env value, and a second envelope
// format would be a second thing to rotate.
//
// The swap is `{ provide: APP_DEPENDENCY_CONFIG_CIPHER, useExisting: AppEnvCrypto }`.

/** Encrypt/decrypt one dependency secret envelope. */
export interface AppDependencyConfigCipher {
    encrypt(value: string): Promise<string>;
    decrypt(envelope: string): Promise<string>;
}

/** DI token for {@link AppDependencyConfigCipher} — bound to APW-07 T9's `AppEnvCrypto`. */
export const APP_DEPENDENCY_CONFIG_CIPHER = Symbol('APP_DEPENDENCY_CONFIG_CIPHER');

// ── provisional — APW-06 T20, the cluster access an attempt dials ────────────
//
// `AppRuntimeFacadeService.resolveClusterAccess(workId)` IS landed
// (`packages/agent/src/facades/app-runtime.facade.ts:569`) and is worker-only by
// design (`requireAppClusterWorkerContext`). This port is a narrow reading of
// it, so this file does not import a facade that refuses outside the isolated
// worker; the swap is
// `{ provide: APP_DEPENDENCY_CLUSTER_ACCESS, useExisting: AppRuntimeFacadeService }`.

/** The narrowed answer of `resolveClusterAccess`. */
export interface AppDependencyClusterAccessResult {
    outcome: 'access' | 'refused';
    access?: { credential?: string | null; ref?: { namespace?: string } };
}

/** APW-06 T20's `resolveClusterAccess`, as this service consumes it. */
export interface AppDependencyClusterAccess {
    resolveClusterAccess(workId: string): Promise<AppDependencyClusterAccessResult | null>;
}

/** DI token for {@link AppDependencyClusterAccess} — bound to APW-06 T20's `AppRuntimeFacadeService`. */
export const APP_DEPENDENCY_CLUSTER_ACCESS = Symbol('APP_DEPENDENCY_CLUSTER_ACCESS');

/* -------------------------------------------------------------------------- *
 * The service
 * -------------------------------------------------------------------------- */

@Injectable()
export class AppDependenciesService {
    private readonly logger = new Logger(AppDependenciesService.name);

    /**
     * In-flight row creations, keyed `<workId>:<kind>`.
     *
     * Two concurrent `reconcile` calls for one Work (the App-spec listener and
     * a deploy preflight, say) race on the same insert. The database's partial
     * unique index settles it across processes; this settles it inside one, so
     * the loser never even attempts the write and **one** provider call is
     * scheduled. It is an in-flight map, never a cache: the entry is removed as
     * soon as the operation settles.
     */
    private readonly rowCreations = new Map<
        string,
        Promise<{ row: WorkAppDependencyMetadata | null; reason: string | null }>
    >();

    constructor(
        // The store every read and release goes through, first, because the
        // class is unusable without it and every `@Optional()` parameter after
        // it has a defined absent answer.
        @Optional() private readonly dependencies?: WorkAppDependencyRepository,
        // Row CREATION lives here rather than in the repository, and
        // deliberately: T8's docstring reserves it ("Row creation is not here on
        // purpose … `reconcile` (T16) creates the `pending`/`awaiting_config`
        // row it is about to dispatch"), and the entity's own repository is the
        // write path that keeps every column the entity declares.
        @Optional()
        @InjectRepository(WorkAppDependency)
        private readonly rows?: Repository<WorkAppDependency>,
        @Optional() private readonly facade?: AppDependencyFacadeService,
        @Optional()
        @Inject(APP_DEPENDENCY_SPEC_SOURCE)
        private readonly spec?: AppDependencySpecSource,
        @Optional()
        @Inject(APP_DEPENDENCY_PROVISION_DISPATCHER)
        private readonly dispatcher?: AppDependencyProvisionDispatcher,
        @Optional()
        @Inject(APP_DEPENDENCY_CONFIG_CIPHER)
        private readonly cipher?: AppDependencyConfigCipher,
        @Optional()
        @Inject(APP_RUNTIME_TARGET)
        private readonly target?: AppRuntimeTargetPort,
        @Optional()
        @Inject(APP_DEPENDENCY_CLUSTER_ACCESS)
        private readonly cluster?: AppDependencyClusterAccess,
        @Optional()
        @Inject(APP_RUNTIME_EVENT_SINK)
        private readonly events?: AppRuntimeEventSink,
    ) {}

    /** The clock, as a method, so a spec can pin an instant without touching a global. */
    protected nowMs(): number {
        return Date.now();
    }

    /* ---------------------------------------------------------------------- *
     * reconcile — plan §2.3
     * ---------------------------------------------------------------------- */

    /**
     * Bring the rows in line with the App spec and the deploy target, and
     * dispatch what has to be provisioned.
     *
     * Idempotent by construction: a row that is already `pending` is
     * re-dispatched (that is how a lost dispatch is repaired), a row that is
     * `ready` is left alone, and a row in `awaiting_config` is left alone —
     * dispatching it would burn the kind's deadline before the owner could type
     * anything (plan §4.9a:637-644).
     */
    async reconcile(workId: string): Promise<AppDependencyReconcileResult> {
        const result = emptyReconcile(workId);

        const snapshot = await this.readSnapshot(workId).catch((error: unknown) => {
            this.logger.warn(`App spec read failed for work ${workId}: ${errorName(error)}`);
            return null;
        });
        if (!snapshot) {
            // Fail closed: without the spec there is no way to tell a new kind
            // from a removed one, and guessing would either provision something
            // nobody declared or keep something the owner removed.
            return { ...result, reason: 'specUnavailable' };
        }
        result.deployTarget = snapshot.deployTarget;

        const active = (await this.dependencies?.findActiveByWork(workId)) ?? [];
        const declared = new Set(snapshot.dependencies.map((entry) => entry.kind));

        // ── the kinds that left the spec (plan §2.3: "inSpec=false") ────────
        for (const row of active) {
            if (declared.has(row.kind) || row.inSpec === false) continue;
            await this.updateRow(row.id, { inSpec: false });
            result.outOfSpec.push(row.kind);
        }

        // ── nothing is provisioned without a target (FR-35, spec §6.5) ─────
        if (snapshot.deployTarget === 'none') {
            for (const row of active) {
                if (
                    row.status === 'kept' ||
                    row.status === 'deleted' ||
                    row.status === 'deleting'
                ) {
                    continue;
                }
                await this.markKept(row.id);
                result.kept.push(row.kind);
            }
            return result;
        }

        const target = snapshot.deployTarget as AppDependencyTarget;

        // ── the declared kinds ──────────────────────────────────────────────
        for (const entry of snapshot.dependencies) {
            const existing = active.find((row) => row.kind === entry.kind);

            if (existing && existing.deployTarget !== target) {
                // Plan §2.3: "old row → kept; new row pending". The order is
                // forced by the partial unique index on (workId, kind).
                await this.markKept(existing.id);
                result.kept.push(entry.kind);
            }

            if (!existing || existing.deployTarget !== target) {
                const created = await this.createAndDispatch(
                    workId,
                    entry,
                    target,
                    snapshot,
                    result,
                );
                if (created) result.unsupported.push({ kind: entry.kind, reason: created });
                continue;
            }

            if (existing.inSpec === false) {
                // Re-declared after leaving the spec: the SAME row comes back,
                // and nothing about it is re-provisioned — its data was kept
                // (FR-45), so re-provisioning would build a second database.
                await this.updateRow(existing.id, { inSpec: true });
            }

            if (!sameJson(existing.declared, entry.declared)) {
                await this.updateRow(existing.id, { declared: entry.declared });
            }

            if (existing.status === 'pending') {
                // The repair path: a dispatch that never reached the queue, or a
                // worker that died before claiming the lease, is fixed here.
                await this.dispatch(workId, entry.kind, result);
            }
        }

        return result;
    }

    /* ---------------------------------------------------------------------- *
     * ensureReadyForDeploy — APW-06's Deploy preflight
     * ---------------------------------------------------------------------- */

    /**
     * Is every required dependency ready, and if not, which are not?
     *
     * It reconciles first, because "not ready" must mean "not ready after
     * everything possible was attempted", and APW-06 calls this at the moment a
     * Deployment starts (plan §4.8:558-559).
     *
     * FR-62: an `smtp` the App spec does not mark `required` never blocks — it is
     * reported under `optional` instead, so the resolver can warn rather than
     * refusing a Deploy over a dependency the spec itself calls optional.
     */
    async ensureReadyForDeploy(workId: string): Promise<AppDependencyReadiness> {
        const reconciled = await this.reconcile(workId);
        if (reconciled.reason === 'specUnavailable') {
            return { ready: false, notReady: [], optional: [], reason: 'specUnavailable' };
        }

        const snapshot = await this.readSnapshot(workId).catch(() => null);
        if (!snapshot) {
            return { ready: false, notReady: [], optional: [], reason: 'specUnavailable' };
        }
        if (snapshot.deployTarget === 'none') {
            // Spec §6.5: dependencies are created when the app has somewhere to
            // run, so a target-less Work has nothing to block on.
            return { ready: true, notReady: [], optional: [] };
        }

        const active = (await this.dependencies?.findActiveByWork(workId)) ?? [];
        const notReady: AppDependencyNotReady[] = [];
        const optional: AppDependencyKind[] = [];

        for (const entry of snapshot.dependencies) {
            const row = active.find((candidate) => candidate.kind === entry.kind);
            if (row && row.status === 'ready' && row.inSpec !== false) continue;

            if (!appDependencyBlocksDeploy(entry.kind, entry.required)) {
                optional.push(entry.kind);
                continue;
            }

            notReady.push({
                kind: entry.kind,
                status: (row?.status ?? 'pending') as AppDependencyStatus,
                reason:
                    row?.statusReason ??
                    (row
                        ? null
                        : (reconciled.unsupported.find((u) => u.kind === entry.kind)?.reason ??
                          'providerNotSupported')),
            });
        }

        return { ready: notReady.length === 0, notReady, optional };
    }

    /* ---------------------------------------------------------------------- *
     * Release — plan §4.12
     * ---------------------------------------------------------------------- */

    /**
     * The app left its cluster (APW-06's Remove op). Every row is released and
     * **no data is touched** unless the owner asked for it.
     *
     * 🛑 `deleteData: false` makes **no provider call at all** — asserted by
     * this file's spec. That is the point of the flag: the workloads are already
     * being removed by APW-06's `destroyApp`, and a deprovision here would be a
     * second, unrequested cluster mutation on the path whose whole promise is
     * "nothing is deleted" (ACC-07-21).
     */
    async onAppRemoved(
        workId: string,
        opts: { deleteData: boolean },
    ): Promise<AppDependencyDeletionReport> {
        const active = (await this.dependencies?.findActiveByWork(workId)) ?? [];
        const report = emptyReport();

        for (const row of active) {
            if (row.status === 'kept' || row.status === 'deleted') continue;

            if (!opts.deleteData) {
                await this.markKept(row.id);
                report.kept.push({ kind: row.kind, name: row.kind });
                continue;
            }

            await this.deprovisionRow(row, { deleteData: true }, report);
        }

        return report;
    }

    /**
     * The App Work itself is being deleted (R-15, APW-06's `delete-app-work`
     * op) — §4.12's table, row by row:
     *
     * - `pending`/`awaiting_config`/`deleting` (never provisioned) → `kept` with
     *   empty `resourceRefs`, and **no event** (FR-58: nothing was ever created,
     *   so there is nothing to report).
     * - `ready`/`degraded`/`failed` with `deleteStoredData: false` →
     *   `deprovision({ deleteData: false, stopWorkloads: true })`, row `kept`,
     *   `app.dependency.released` naming the kept resources (FR-56).
     * - the same rows with `deleteStoredData: true` →
     *   `deprovision({ deleteData: true })`, row `deleted`,
     *   `app.dependency.data_deleted`.
     *
     * Idempotent: a re-dispatched op finds `kept`/`deleted` rows and does
     * nothing (plan §4.12:762).
     */
    async onAppWorkDeleting(
        workId: string,
        opts: { deleteStoredData: boolean },
    ): Promise<AppDependencyDeletionReport> {
        const active = (await this.dependencies?.findActiveByWork(workId)) ?? [];
        const report = emptyReport();

        for (const row of active) {
            if (row.status === 'kept' || row.status === 'deleted') continue;

            const neverProvisioned =
                row.status === 'pending' ||
                row.status === 'awaiting_config' ||
                row.status === 'deleting';

            if (neverProvisioned) {
                await this.markKept(row.id);
                report.kept.push({ kind: row.kind, name: row.kind });
                continue;
            }

            await this.deprovisionRow(
                row,
                opts.deleteStoredData
                    ? { deleteData: true }
                    : { deleteData: false, stopWorkloads: true },
                report,
            );
        }

        return report;
    }

    /**
     * One row's provider release, with the report updated from what actually
     * happened. A provider that cannot be reached leaves the row **as it was**
     * and the resources in `mayRemain`: nothing is reported as released that a
     * provider still holds.
     */
    private async deprovisionRow(
        row: WorkAppDependencyMetadata,
        opts: { deleteData: boolean; stopWorkloads?: boolean },
        report: AppDependencyDeletionReport,
    ): Promise<void> {
        const resolved = await this.facade?.resolve(row.providerPluginId, row.providerId, row.kind);
        const access = resolved ? await this.prepareTarget(row.workId) : null;
        const ctx =
            resolved && access && !('unavailable' in access)
                ? await this.buildProviderContext(row, access)
                : null;

        if (!this.facade || !resolved || !ctx) {
            report.mayRemain.push({ kind: row.kind, name: row.kind });
            return;
        }

        try {
            const outcome = await this.facade.deprovision(resolved.selection, ctx, {
                deleteData: opts.deleteData,
                ...(opts.stopWorkloads === undefined ? {} : { stopWorkloads: opts.stopWorkloads }),
            });

            if (outcome?.state === 'deleted') {
                await this.markDeleted(row.id);
                report.kept.push({ kind: row.kind, name: row.kind });
                await this.emit('app.dependency.data_deleted', row, {});
                return;
            }

            // `released` — and `pending`, which means the provider is still
            // working: the data is NOT gone, so the caller is told it may remain.
            await this.markKept(row.id);
            report.kept.push({ kind: row.kind, name: row.kind });

            if (outcome?.state === 'pending') {
                report.remaining = true;
                report.mayRemain.push({ kind: row.kind, name: row.kind });
                return;
            }
            if (opts.deleteData) {
                // A provider that answered `released` to a delete request did
                // not delete: the volumes stay, and §9.7's op must not go on to
                // delete the namespace around them.
                report.remaining = true;
                report.mayRemain.push({ kind: row.kind, name: row.kind });
            }
            await this.emit('app.dependency.released', row, { kept: refNames(row.resourceRefs) });
        } catch (error) {
            this.logger.warn(
                `Deprovision of ${row.kind} for work ${row.workId} failed: ${errorName(error)}`,
            );
            report.mayRemain.push({ kind: row.kind, name: row.kind });
        }
    }

    /* ---------------------------------------------------------------------- *
     * The card's reads
     * ---------------------------------------------------------------------- */

    /**
     * Every dependency of one App Work, as `AppDependencyView[]` — plus the two
     * fields APW-06's delete dialog needs (`label`, `names`), which is why the
     * return type extends the contract's view rather than replacing it.
     *
     * No output VALUE is on this shape, ever (FR-5, plan §5:795): `outputs`
     * carries names and whether each is secret, and `keptResources` carries
     * names. `statusDetail` is names and numbers only.
     */
    async list(workId: string, opts: { userId?: string } = {}): Promise<AppDependencyListEntry[]> {
        const snapshot = await this.readSnapshot(workId).catch(() => null);
        const active = (await this.dependencies?.findActiveByWork(workId)) ?? [];
        const target = (snapshot?.deployTarget ?? 'your-cluster') as AppDependencyTarget;

        const entries: AppDependencyListEntry[] = [];
        for (const row of active) {
            const resolved = await this.facade?.resolve(
                row.providerPluginId,
                row.providerId,
                row.kind,
            );
            const available = this.facade
                ? await this.facade
                      .availableProviders(row.kind, target, {
                          workId,
                          userId: opts.userId,
                          configSet: await this.configKeys(row),
                      })
                      .catch(() => [])
                : [];

            entries.push({
                kind: row.kind,
                declared: row.inSpec !== false,
                provider: {
                    pluginId: row.providerPluginId,
                    providerId: row.providerId,
                    label: resolved?.selection.label ?? row.providerId,
                },
                availableProviders: available,
                status: row.status,
                statusReason: asReason(row.statusReason),
                statusDetail: row.statusDetail ?? null,
                awaitingConfig: row.status === 'awaiting_config',
                actualVersion: row.actualVersion ?? null,
                sizeGiB: row.sizeGiB ?? null,
                backup: backupView(row),
                inSpec: row.inSpec !== false,
                keptResources: row.resourceRefs ?? null,
                outputs: outputRefs(row.kind, row.resourceRefs),
                lastProvisionedAt: iso(row.lastProvisionedAt),
                lastCheckedAt: iso(row.lastCheckedAt),
                label: resolved?.selection.label ?? row.providerId,
                names: refNames(row.resourceRefs),
            });
        }

        return entries;
    }

    /* ---------------------------------------------------------------------- *
     * Writes the routes drive
     * ---------------------------------------------------------------------- */

    /**
     * `PUT /api/works/:id/app-dependencies/:kind` — the owner's explicit
     * provider, the prompted configuration and the volume size.
     *
     * The configuration is encrypted **before** it is stored and is never read
     * back (FR-5): with no cipher bound the write is refused
     * (`secureStorageUnavailable`), because storing a prompted credential in
     * the clear is worse than refusing the save.
     *
     * A `sizeGiB` below the provisioned size is refused (`sizeShrinkRefused`,
     * FR-63); equal or larger is stored, and the provisioning job resizes the
     * claim.
     */
    async configure(
        workId: string,
        kind: AppDependencyKind,
        input: {
            providerId?: string;
            config?: Record<string, string>;
            sizeGiB?: number;
            userId?: string;
        } = {},
    ): Promise<AppDependencyListEntry | null> {
        const snapshot = await this.readSnapshot(workId);
        const entry = snapshot?.dependencies.find((candidate) => candidate.kind === kind);
        if (!snapshot || !entry) {
            throw new AppDependencyRefusalError(
                'dependencyNotDeclared',
                `The App spec does not declare ${kind}.`,
                404,
            );
        }
        if (snapshot.deployTarget === 'none') {
            throw new AppDependencyRefusalError(
                'dependencyNotDeclared',
                'Dependencies are created when this app has a deploy target.',
                404,
            );
        }

        const target = snapshot.deployTarget as AppDependencyTarget;
        const row =
            (await this.dependencies?.findByWorkAndKind(workId, kind)) ??
            (await this.createRow(workId, entry, target));

        if (input.sizeGiB !== undefined && row) {
            const allowed = isAppDependencySizeChangeAllowed(row.sizeGiB ?? null, input.sizeGiB);
            if (!allowed.allowed) {
                throw new AppDependencyRefusalError(
                    'sizeShrinkRefused',
                    "A dependency's storage can't be shrunk. Delete its data first if you need a smaller one.",
                    422,
                );
            }
        }

        const selection = await this.selectForWrite(kind, target, entry, row, input.providerId);
        if (!selection) {
            throw new AppDependencyRefusalError(
                'providerNotSupported',
                `No provider supports ${kind} on this deploy target.`,
                422,
            );
        }
        if (!row) {
            throw new AppDependencyRefusalError(
                'providerNotSupported',
                `No ${kind} row could be created.`,
                422,
            );
        }

        const patch: Record<string, unknown> = {
            providerPluginId: selection.providerPluginId,
            providerId: selection.providerId,
            backupPolicy: selection.backupPolicy,
            status: 'pending',
            statusReason: null,
            statusDetail: null,
            attempts: 0,
        };

        if (input.sizeGiB !== undefined) patch.sizeGiB = input.sizeGiB;
        if (input.config !== undefined)
            patch.configEncrypted = await this.encryptConfig(input.config);
        // A different provider means the previous attempt's version no longer
        // describes this row, and its outputs belong to the other provider.
        if (selection.providerId !== row.providerId) {
            patch.actualVersion = null;
            patch.resourceRefs = null;
        }

        await this.updateRow(row.id, patch);

        const result = emptyReconcile(workId);
        await this.dispatch(workId, kind, result);

        const entries = await this.list(workId, { userId: input.userId });
        return entries.find((candidate) => candidate.kind === kind) ?? null;
    }

    /**
     * `POST /api/works/:id/app-dependencies/:kind/provision` — the owner's
     * **Retry**.
     *
     * It clears the failure and schedules a fresh attempt. A lease another
     * worker holds is respected: the call reports `leaseHeld` and dispatches
     * nothing rather than racing that worker for the same dependency.
     */
    async retry(
        workId: string,
        kind: AppDependencyKind,
    ): Promise<{ dispatched: boolean; reason?: string }> {
        const row = await this.dependencies?.findByWorkAndKind(workId, kind);
        if (!row) {
            throw new AppDependencyRefusalError(
                'dependencyNotDeclared',
                `This App Work has no ${kind} dependency.`,
                404,
            );
        }
        if (this.leaseHeld(row)) {
            return { dispatched: false, reason: 'leaseHeld' };
        }

        await this.updateRow(row.id, {
            status: 'pending',
            statusReason: null,
            statusDetail: null,
            attempts: 0,
        });

        const result = emptyReconcile(workId);
        await this.dispatch(workId, kind, result);

        return result.dispatched.includes(kind)
            ? { dispatched: true }
            : { dispatched: false, reason: 'dispatcherUnavailable' };
    }

    /**
     * `DELETE /api/works/:id/app-dependencies/:kind` — **Delete data**, the one
     * irreversible path (FR-46).
     *
     * Three gates, all of them required: edit access, the typed App Work slug,
     * and no provisioning lease in flight. The third is not cosmetic — a
     * provider mid-provision would otherwise be deleting volumes while a
     * `StatefulSet` it just created is being written, and the row would race
     * between `deleting` and `ready`.
     */
    async requestDataDeletion(
        workId: string,
        kind: AppDependencyKind,
        input: {
            confirmSlug: string | null;
            workSlug: string;
            hasEditAccess?: boolean;
        },
    ): Promise<AppDependencyListEntry | null> {
        const confirmed = canDeleteAppDependencyData({
            hasEditAccess: input.hasEditAccess !== false,
            confirmSlug: input.confirmSlug,
            workSlug: input.workSlug,
        });
        if (!confirmed) {
            throw new AppDependencyRefusalError(
                'confirmationMismatch',
                'Type the App Work slug to confirm deleting this data.',
                422,
            );
        }

        const row = await this.dependencies?.findByWorkAndKind(workId, kind);
        if (!row) {
            throw new AppDependencyRefusalError(
                'dependencyNotDeclared',
                `This App Work has no ${kind} dependency.`,
                404,
            );
        }
        if (this.leaseHeld(row)) {
            throw new AppDependencyRefusalError(
                'deleteInProgress',
                'This dependency is being provisioned right now. Try again in a moment.',
                409,
            );
        }

        await this.updateRow(row.id, { status: 'deleting' });
        await this.dispatchPayload({ workId, kind, mode: 'deprovision', deleteData: true });

        const entries = await this.list(workId);
        return entries.find((candidate) => candidate.kind === kind) ?? null;
    }

    /* ---------------------------------------------------------------------- *
     * Ephemeral provisioning — R-10, FR-59/FR-60
     * ---------------------------------------------------------------------- */

    /**
     * Provision a verification's dependencies: the same objects, in the
     * verification namespace, with `emptyDir` instead of every PVC, the plain
     * path always, and the outputs handed back **in memory only**.
     *
     * Two shapes are accepted on purpose. APW-06's
     * `AppVerificationTargetService` calls the positional form
     * (`provisionEphemeral(workId, namespace, kinds)`,
     * `app-verification-target.service.ts:789`) and plan §5:831 writes the
     * object form (`provisionEphemeral(workId, { namespace, kinds, signal })`);
     * both are supported so neither caller has to change.
     *
     * 🛑 **No row is created, no output is stored, no PVC is drawn** — R-10 and
     * FR-60 are properties of this method, asserted by this file's spec: the
     * outputs exist in the returned object and nowhere else.
     */
    async provisionEphemeral(
        workId: string,
        namespaceOrOptions: string | AppEphemeralProvisionOptions,
        kinds?: readonly string[],
    ): Promise<AppEphemeralProvisionResult> {
        const options: AppEphemeralProvisionOptions =
            typeof namespaceOrOptions === 'string'
                ? { namespace: namespaceOrOptions, kinds: kinds ?? [] }
                : namespaceOrOptions;

        const result: AppEphemeralProvisionResult = { outputs: {}, failed: [] };
        const wanted = (options.kinds ?? []).filter((kind): kind is AppDependencyKind =>
            (APP_DEPENDENCY_KINDS as readonly string[]).includes(kind),
        );
        if (wanted.length === 0) return result;

        const snapshot = await this.readSnapshot(workId).catch(() => null);
        const target = (snapshot?.deployTarget ?? 'your-cluster') as AppDependencyTarget;
        const access = await this.prepareTarget(workId);

        for (const kind of wanted) {
            const entry = snapshot?.dependencies.find((candidate) => candidate.kind === kind);
            if (!snapshot || !entry) {
                result.failed.push({ kind, reason: 'dependencyNotDeclared' });
                continue;
            }
            if (!this.facade || 'unavailable' in access) {
                result.failed.push({
                    kind,
                    reason:
                        'unavailable' in access
                            ? reasonForUnavailableTarget(access.unavailable)
                            : 'targetNotChecked',
                });
                continue;
            }

            try {
                const selection = await this.selectForWrite(kind, target, entry, null, undefined, {
                    ephemeral: true,
                });
                if (!selection) {
                    result.failed.push({ kind, reason: 'providerNotSupported' });
                    continue;
                }

                const ctx = await this.buildContext(
                    {
                        workId,
                        kind,
                        deployTarget: target,
                        declared: entry.declared,
                        sizeGiB: defaultSizeFor(kind),
                        appName: snapshot.appName,
                        providerPluginId: selection.providerPluginId,
                    },
                    {
                        // R-10: the SAME objects in the VERIFICATION namespace,
                        // with `ephemeral: true` so no provider draws a PVC.
                        ephemeral: true,
                        namespace: options.namespace,
                        kubeconfig: access.credential,
                        kubeContext: access.ref.kubeContext ?? null,
                        appLabels: access.podLabels,
                        signal: options.signal,
                    },
                );

                const outcome = await this.facade.provision(selection, ctx);
                if (outcome?.state === 'ready') {
                    // In memory, and only in memory: nothing below this line
                    // writes a row, an envelope or a resource reference.
                    result.outputs[kind] = { ...outcome.outputs };
                } else {
                    result.failed.push({
                        kind,
                        reason: outcome?.state === 'failed' ? outcome.reason : 'deadlineExceeded',
                    });
                }
            } catch (error) {
                result.failed.push({ kind, reason: errorName(error) });
            }
        }

        return result;
    }

    /* ---------------------------------------------------------------------- *
     * The worker-side attempt — what T17's runner calls
     * ---------------------------------------------------------------------- */

    /**
     * Run **one** attempt of the `app-dependency-provision` job against a
     * provider, and persist what it produced.
     *
     * The lease, the re-dispatch timing and the deadline accounting stay T17's
     * (`app-dependency-provision.runner.ts`); this method is what that runner
     * calls per attempt, and it is here because T16's own acceptance text pins
     * its behaviour in this file's spec: a Work with a declared Postgres and no
     * Deployment must call `AppRuntimeTargetPort.prepareDependencyTarget` and
     * reach `ready` with **zero** `app-deploy` dispatches (the GAP-06/APW07-G01
     * deadlock regression), `target_not_checked` and `namespace_owned_elsewhere`
     * must fail with that reason, and `cluster_unreachable` must be retryable.
     *
     * A provider that throws — or whose call is aborted at the kind's readiness
     * deadline — leaves the row **retryable**, never `ready`.
     */
    async runAttempt(
        workId: string,
        kind: AppDependencyKind,
        opts: { mode?: 'provision' | 'refresh'; signal?: AbortSignal } = {},
    ): Promise<AppDependencyAttemptResult> {
        const row = await this.dependencies?.findByWorkAndKind(workId, kind);
        if (!row) {
            throw new AppDependencyRefusalError(
                'dependencyNotDeclared',
                `This App Work has no ${kind} dependency.`,
                404,
            );
        }
        if (!this.facade) {
            return { kind, state: 'failed', reason: 'providerNotSupported', transient: false };
        }

        const prepared = await this.prepareTarget(workId);
        if ('unavailable' in prepared) {
            // Definite for every reason but an unreachable cluster (FR-43,
            // plan §4.8:554-556). The row carries the CONTRACT reason, not the
            // port's discriminant (APW07-G28): `asReason` reads a stored reason
            // back through the closed union, so storing `target_not_checked`
            // verbatim left the card reading *Failed* with no reason at all.
            return this.recordAttemptFailure(
                row,
                reasonForUnavailableTarget(prepared.unavailable),
                prepared.unavailable === 'cluster_unreachable',
            );
        }

        const snapshot = await this.readSnapshot(workId).catch(() => null);
        const entry = snapshot?.dependencies.find((candidate) => candidate.kind === kind);
        const resolved = await this.facade.resolve(row.providerPluginId, row.providerId, kind);
        if (!resolved) {
            return { kind, state: 'failed', reason: 'providerNotSupported', transient: false };
        }

        const ctx = await this.buildContext(
            {
                workId,
                kind,
                deployTarget: row.deployTarget,
                declared: entry?.declared ?? row.declared ?? {},
                sizeGiB: row.sizeGiB ?? null,
                appName: snapshot?.appName,
                providerPluginId: row.providerPluginId,
            },
            {
                namespace: prepared.ref.namespace,
                kubeconfig: prepared.credential,
                kubeContext: prepared.ref.kubeContext ?? null,
                appLabels: prepared.podLabels,
                signal: opts.signal,
                // The provider's own budget is the kind's readiness deadline (FR-41).
                deadlineMs: appDependencyReadyDeadlineMs(kind),
            },
        );

        await this.updateRow(row.id, { status: 'provisioning' });

        if ((opts.mode ?? 'provision') === 'refresh') {
            return this.refresh(row, ctx);
        }

        try {
            const outcome = await this.facade.provision(resolved.selection, ctx);

            if (outcome?.state === 'ready') {
                const stored = await this.storeOutputs(row, outcome.outputs ?? {});
                await this.updateRow(row.id, {
                    status: 'ready',
                    statusReason: null,
                    statusDetail: stored.detail ?? null,
                    actualVersion: outcome.actualVersion ?? row.actualVersion ?? null,
                    resourceRefs: outcome.resourceRefs ?? { objects: [] },
                    attempts: 0,
                    lastProvisionedAt: new Date(this.nowMs()),
                    lastCheckedAt: new Date(this.nowMs()),
                });
                await this.emit('app.dependency.provisioned', row, {
                    actualVersion: outcome.actualVersion ?? null,
                });
                return { kind, state: 'ready', outputsVersion: stored.version };
            }

            if (outcome?.state === 'pending') {
                await this.updateRow(row.id, { status: 'pending', statusReason: null });
                return { kind, state: 'pending', retryAfterMs: outcome.retryAfterMs };
            }

            const failure = outcome ?? {
                state: 'failed' as const,
                reason: 'clusterUnreachable',
                transient: true,
                detail: undefined,
            };
            return this.recordAttemptFailure(
                row,
                failure.reason,
                failure.transient,
                failure.detail,
            );
        } catch (error) {
            // A provider that threw did NOT provision anything. It is recorded
            // as a transient failure with its own retry allowance (FR-43), so a
            // single bad call can never look like a `ready` dependency.
            const aborted = opts.signal?.aborted === true || errorName(error) === 'AbortError';
            return this.recordAttemptFailure(
                row,
                aborted ? 'deadlineExceeded' : 'clusterUnreachable',
                true,
                { error: errorName(error) },
            );
        }
    }

    /** The `refresh` mode: re-read the outputs and the backup state (FR-42, FR-48). */
    private async refresh(
        row: WorkAppDependencyMetadata,
        ctx: AppDependencyContext,
    ): Promise<AppDependencyAttemptResult> {
        const resolved = await this.facade?.resolve(row.providerPluginId, row.providerId, row.kind);
        if (!this.facade || !resolved) {
            return { kind: row.kind, state: 'failed', reason: 'providerNotSupported' };
        }

        try {
            const outputs = await this.facade.getOutputs(resolved.selection, ctx);
            const stored = await this.storeOutputs(row, outputs ?? {});
            const backup = await this.facade
                .backupStatus(resolved.selection, ctx)
                .catch(() => null);

            await this.updateRow(row.id, {
                status: 'ready',
                statusReason: null,
                statusDetail: stored.detail ?? null,
                backupState: backup?.state ?? row.backupState ?? null,
                lastBackupAt: backup?.lastBackupAt
                    ? new Date(backup.lastBackupAt)
                    : row.lastBackupAt,
                backupCheckedAt: new Date(this.nowMs()),
                lastCheckedAt: new Date(this.nowMs()),
            });

            return { kind: row.kind, state: 'ready', outputsVersion: stored.version };
        } catch (error) {
            // A first failure to answer is not a failing dependency: the row
            // keeps its status and records that the check happened (FR-48's
            // "Couldn't check" is the card's rendering of an unknown state).
            this.logger.warn(
                `Refresh of ${row.kind} for work ${row.workId} failed: ${errorName(error)}`,
            );
            await this.updateRow(row.id, { lastCheckedAt: new Date(this.nowMs()) });
            return {
                kind: row.kind,
                state: 'failed',
                reason: 'clusterUnreachable',
                transient: true,
            };
        }
    }

    /**
     * Record a failed attempt. Under the allowance it stays retryable
     * (`provisioning`, so the card says *Provisioning* rather than *Failed*,
     * FR-43); at the allowance it becomes `failed` with its reason.
     */
    private async recordAttemptFailure(
        row: WorkAppDependencyMetadata,
        reason: string,
        transient = true,
        detail?: Record<string, string | number | string[]>,
    ): Promise<AppDependencyAttemptResult> {
        const attempts = (row.attempts ?? 0) + 1;
        const exhausted = !transient || attempts >= APP_DEPENDENCY_TRANSIENT_ATTEMPTS;

        await this.updateRow(row.id, {
            status: exhausted ? 'failed' : 'provisioning',
            statusReason: reason,
            statusDetail: detail ?? null,
            attempts,
        });

        if (exhausted) {
            await this.emit('app.dependency.failed', row, { reason });
        }

        return { kind: row.kind, state: 'failed', reason, transient: !exhausted };
    }

    /* ---------------------------------------------------------------------- *
     * Cluster access — the only way this service reaches a cluster
     * ---------------------------------------------------------------------- */

    /**
     * `AppRuntimeTargetPort.prepareDependencyTarget` plus the Work-scoped
     * credential (plan §4.8:547-557).
     *
     * Called **once per attempt** and before any provider call, because
     * preparation is what makes the namespace, its `LimitRange` and the baseline
     * policies exist first: a provider never waits for and never dispatches a
     * Deployment (GAP-06 / APW07-G01).
     */
    private async prepareTarget(
        workId: string,
    ): Promise<PreparedTarget | { unavailable: AppRuntimeTargetUnavailable }> {
        if (!this.target) {
            return { unavailable: 'target_not_checked' };
        }

        let prepared: Awaited<ReturnType<AppRuntimeTargetPort['prepareDependencyTarget']>>;
        try {
            prepared = await this.target.prepareDependencyTarget(workId);
        } catch (error) {
            this.logger.warn(
                `prepareDependencyTarget failed for work ${workId}: ${errorName(error)}`,
            );
            return { unavailable: 'cluster_unreachable' };
        }
        if ('unavailable' in prepared) {
            return { unavailable: prepared.unavailable };
        }

        const access = await this.resolveClusterAccess(workId);
        if (!access) {
            // The namespace is prepared but no credential can be assembled:
            // transient, because the tier or the cluster may simply not be
            // reachable from this process right now (FR-43).
            return { unavailable: 'cluster_unreachable' };
        }

        return { ...prepared, credential: access };
    }

    /** The Work's cluster credential, through APW-06's own resolver. */
    private async resolveClusterAccess(workId: string): Promise<string | null> {
        if (!this.cluster) return null;
        try {
            const answer = await this.cluster.resolveClusterAccess(workId);
            const credential = answer?.access?.credential;
            return answer?.outcome === 'access' && credential ? credential : null;
        } catch (error) {
            this.logger.warn(`Cluster access for work ${workId} failed: ${errorName(error)}`);
            return null;
        }
    }

    /* ---------------------------------------------------------------------- *
     * Row bookkeeping
     * ---------------------------------------------------------------------- */

    /**
     * Create the row for a newly declared kind, **and** dispatch it.
     *
     * ## First writer wins (and that is asserted, not assumed)
     *
     * Two callers can arrive here for one `(workId, kind)` at the same moment.
     * Three things settle it, in order:
     *
     * 1. `rowCreations` coalesces the two INSIDE this process, so the loser
     *    awaits the winner's result and never attempts a write or a dispatch.
     * 2. The insert itself is attempted; a unique violation (the migration's
     *    partial index on `(workId, kind) WHERE status NOT IN ('kept','deleted')`)
     *    means another PROCESS won.
     * 3. The loser then **re-reads** and adopts the stored row, and dispatches
     *    nothing — one row, one provider call.
     *
     * Step 3 is deliberately a re-read rather than a retry: the row that exists
     * is the row that will be provisioned, whichever caller created it.
     *
     * Returns a reason string when the kind could not be created at all.
     */
    private async createAndDispatch(
        workId: string,
        entry: AppDependencySpecEntry,
        target: AppDependencyTarget,
        snapshot: AppDependencySpecSnapshot,
        result: AppDependencyReconcileResult,
    ): Promise<string | null> {
        const key = `${workId}:${entry.kind}`;
        const inFlight = this.rowCreations.get(key);
        if (inFlight) {
            // Somebody in this process is already creating (and dispatching)
            // this exact row. Adopting its answer is what keeps the dispatch
            // count at one.
            const adopted = await inFlight;
            if (adopted.row) return null;
        }

        const pending = this.createRowIfAbsent(workId, entry, target, snapshot);
        this.rowCreations.set(key, pending);
        let row: WorkAppDependencyMetadata | null;
        let reason: string | null = null;
        try {
            const created = await pending;
            row = created.row;
            reason = created.reason;
        } finally {
            this.rowCreations.delete(key);
        }

        if (!row) return reason;

        result.created.push(entry.kind);

        if (row.status === 'awaiting_config') {
            // Plan §4.9a: the row waits for the owner. No dispatch, no deadline.
            result.awaitingConfig.push(entry.kind);
            return null;
        }

        await this.dispatch(workId, entry.kind, result);
        return null;
    }

    /** {@link createAndDispatch}'s body: select, insert (or adopt), and report why not. */
    private async createRowIfAbsent(
        workId: string,
        entry: AppDependencySpecEntry,
        target: AppDependencyTarget,
        snapshot: AppDependencySpecSnapshot,
    ): Promise<{ row: WorkAppDependencyMetadata | null; reason: string | null }> {
        const created = await this.createRow(workId, entry, target, undefined, snapshot);
        if (created) return { row: created, reason: null };
        return {
            row: null,
            reason: this.rows ? 'providerNotSupported' : 'rowStoreUnavailable',
        };
    }

    /**
     * Insert one `work_app_dependencies` row, or adopt the one another writer
     * inserted first.
     */
    private async createRow(
        workId: string,
        entry: AppDependencySpecEntry,
        target: AppDependencyTarget,
        selection?: AppDependencySelection,
        snapshot?: AppDependencySpecSnapshot,
    ): Promise<WorkAppDependencyMetadata | null> {
        if (!this.rows) {
            // The row store is unbound: without it nothing may be claimed as
            // scheduled, because no attempt could ever record its outcome.
            this.logger.warn(
                `No dependency row store is bound; work ${workId} has no row created.`,
            );
            return null;
        }

        const resolved =
            selection ?? (await this.selectForWrite(entry.kind, target, entry, null)) ?? undefined;
        if (!resolved) {
            this.logger.warn(
                `No provider supports ${entry.kind} on ${target} for work ${workId}; no row created.`,
            );
            return null;
        }

        const awaitingConfig = resolved.awaitingConfig === true;
        try {
            await this.rows.insert({
                workId,
                kind: entry.kind,
                deployTarget: target,
                providerPluginId: resolved.providerPluginId,
                providerId: resolved.providerId,
                status: awaitingConfig ? 'awaiting_config' : 'pending',
                statusReason: null,
                statusDetail: null,
                attempts: 0,
                declared: entry.declared,
                sizeGiB: defaultSizeFor(entry.kind),
                outputsVersion: 0,
                inSpec: true,
                backupPolicy: resolved.backupPolicy,
            } as WorkAppDependency);
        } catch (error) {
            if (!isUniqueViolation(error)) {
                throw error;
            }
            // Somebody else created this row first. Adopt it; never a second
            // insert, never a second dispatch (first writer wins).
            this.logger.log(
                `Dependency row for ${entry.kind} on work ${workId} was created concurrently; adopting it.`,
            );
        }
        void snapshot;

        return (await this.dependencies?.findByWorkAndKind(workId, entry.kind)) ?? null;
    }

    /** The provider choice for a write — the stored one, or the owner's, or the preference order. */
    private async selectForWrite(
        kind: AppDependencyKind,
        target: AppDependencyTarget,
        entry: AppDependencySpecEntry,
        row: WorkAppDependencyMetadata | null,
        providerId?: string,
        opts: { ephemeral?: boolean } = {},
    ): Promise<AppDependencySelection | null> {
        if (!this.facade) return null;

        const ctx = await this.buildContext(
            {
                workId: row?.workId ?? '',
                kind,
                deployTarget: target,
                declared: entry.declared,
                sizeGiB: row?.sizeGiB ?? defaultSizeFor(kind),
                providerPluginId: row?.providerPluginId,
            },
            // A selection asks the provider a question, not a cluster: the
            // context carries no credential (plan §4.8:543-546).
            { ephemeral: opts.ephemeral },
        );

        const answer = await this.facade.select(kind, target, ctx, {
            workId: row?.workId,
            providerId: providerId ?? row?.providerId ?? undefined,
        });

        return answer.supported ? answer : null;
    }

    /**
     * The `AppDependencyContext` a provider call is made with.
     *
     * `cluster` is present exactly when a credential was assembled, and the
     * caller decides that: a selection question passes no kubeconfig and gets a
     * context without one, which is what keeps the API process from ever
     * holding a cluster credential (R-5, APW-06 §6.2).
     */
    private async buildContext(
        input: RowContextInput,
        opts: {
            ephemeral?: boolean;
            namespace?: string;
            kubeconfig?: string;
            kubeContext?: string | null;
            appLabels?: Record<string, string>;
            signal?: AbortSignal;
            deadlineMs?: number;
        } = {},
    ): Promise<AppDependencyContext> {
        const target = (input.deployTarget ?? 'your-cluster') as AppDependencyTarget;
        const settings = this.facade
            ? await this.facade
                  .settingsFor(input.providerPluginId ?? '', { workId: input.workId })
                  .catch(() => ({}))
            : {};

        const ctx: AppDependencyContext = {
            workId: input.workId,
            appName: input.appName ?? '',
            target,
            declared: input.declared ?? {},
            ...(input.sizeGiB === null || input.sizeGiB === undefined
                ? {}
                : { sizeGiB: input.sizeGiB }),
            settings,
            // A selection question must not arm a timer nothing will clear.
            signal:
                opts.signal ??
                (opts.kubeconfig
                    ? AbortSignal.timeout(this.deadlineOf(opts, input))
                    : NEVER_ABORTED),
            ...(opts.ephemeral === undefined ? {} : { ephemeral: opts.ephemeral }),
        };

        if (opts.kubeconfig) {
            (ctx as { cluster?: unknown }).cluster = {
                kubeconfig: opts.kubeconfig,
                context: opts.kubeContext ?? null,
                namespace: opts.namespace ?? '',
                appLabels: opts.appLabels ?? {},
            };
        }

        const config = await this.decryptConfig(input.workId, input.kind);
        if (config) {
            (ctx as { config?: unknown }).config = config;
        }

        return ctx;
    }

    private deadlineOf(opts: { deadlineMs?: number }, input: RowContextInput): number {
        return opts.deadlineMs ?? appDependencyReadyDeadlineMs(input.kind);
    }

    /** The provider call's own context, for a row that is being released. */
    private buildProviderContext(
        row: WorkAppDependencyMetadata,
        prepared: PreparedTarget,
    ): Promise<AppDependencyContext> {
        return this.buildContext(
            {
                workId: row.workId,
                kind: row.kind,
                deployTarget: row.deployTarget,
                declared: row.declared ?? {},
                sizeGiB: row.sizeGiB ?? null,
                providerPluginId: row.providerPluginId,
            },
            {
                namespace: prepared.ref.namespace,
                kubeconfig: prepared.credential,
                kubeContext: prepared.ref.kubeContext ?? null,
                appLabels: prepared.podLabels,
                deadlineMs: appDependencyReadyDeadlineMs(row.kind),
            },
        );
    }

    /* ---------------------------------------------------------------------- *
     * Persistence helpers
     * ---------------------------------------------------------------------- */

    /** Encrypt a prompted configuration, or refuse — a plaintext secret is never stored (FR-5). */
    private async encryptConfig(config: Record<string, string>): Promise<string> {
        if (!this.cipher) {
            throw new AppDependencyRefusalError(
                'secureStorageUnavailable',
                'Secure storage is not configured, so provider settings cannot be saved.',
                503,
            );
        }
        return this.cipher.encrypt(JSON.stringify(config));
    }

    /**
     * The stored configuration of a row, decrypted, or `null`.
     *
     * It is read for exactly one purpose — handing it to the provider that is
     * about to dial the owner's server — and never logged, returned or put on a
     * view (FR-5).
     */
    private async decryptConfig(
        workId: string,
        kind: AppDependencyKind,
    ): Promise<Record<string, string> | null> {
        if (!this.cipher || !this.rows || !workId) return null;
        const row = await this.dependencies?.findByWorkAndKind(workId, kind);
        if (!row?.id) return null;
        const stored = await this.rows.findOne({ where: { id: row.id } });
        if (!stored?.configEncrypted) return null;
        try {
            const parsed: unknown = JSON.parse(await this.cipher.decrypt(stored.configEncrypted));
            return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : null;
        } catch (error) {
            this.logger.warn(
                `Stored provider configuration could not be read: ${errorName(error)}`,
            );
            return null;
        }
    }

    /** The prompt-schema keys a row already holds — the card renders `set`, never a value (FR-5). */
    private async configKeys(row: WorkAppDependencyMetadata): Promise<string[]> {
        if (!this.cipher || !this.rows || !row?.id) return [];
        const stored = await this.rows.findOne({ where: { id: row.id } });
        if (!stored?.configEncrypted) return [];
        try {
            const parsed: unknown = JSON.parse(await this.cipher.decrypt(stored.configEncrypted));
            return parsed && typeof parsed === 'object' ? Object.keys(parsed) : [];
        } catch {
            return [];
        }
    }

    /**
     * Store the provider's outputs as one envelope, bumping `outputsVersion`
     * **only when they changed** (plan §7:876).
     *
     * The comparison is over the DECRYPTED JSON, because the envelope of two
     * identical output sets differs every time (a fresh IV): comparing
     * envelopes would bump the version on every refresh and restart every app
     * that derives a value from them (FR-44).
     */
    private async storeOutputs(
        row: WorkAppDependencyMetadata,
        outputs: Record<string, string>,
    ): Promise<{ stored: boolean; version?: number; detail?: AppDependencyStatusDetail }> {
        if (!this.cipher) {
            return { stored: false, detail: { outputsUnavailable: 'secureStorageUnavailable' } };
        }

        const next = JSON.stringify(outputs ?? {});
        const previous = await this.readStoredOutputs(row.id);
        if (previous === next) {
            return { stored: true, version: row.outputsVersion };
        }

        const envelope = await this.cipher.encrypt(next);
        const updated = await this.dependencies?.updateOutputs(row.id, envelope);
        return { stored: true, version: updated?.outputsVersion };
    }

    /** The stored outputs, decrypted, for the change comparison — never returned to a caller. */
    private async readStoredOutputs(id: string): Promise<string | null> {
        if (!this.rows || !this.cipher || !id) return null;
        const stored = await this.rows.findOne({ where: { id } });
        if (!stored?.outputsEncrypted) return null;
        try {
            return await this.cipher.decrypt(stored.outputsEncrypted);
        } catch {
            return null;
        }
    }

    private async readSnapshot(workId: string): Promise<AppDependencySpecSnapshot | null> {
        if (!this.spec) return null;
        return (await this.spec.read(workId)) ?? null;
    }

    private markKept(id: string): Promise<boolean> {
        return this.dependencies?.markKept(id) ?? Promise.resolve(false);
    }

    private markDeleted(id: string): Promise<boolean> {
        return this.dependencies?.markDeleted(id) ?? Promise.resolve(false);
    }

    private async updateRow(id: string, patch: Record<string, unknown>): Promise<void> {
        if (!this.rows || !id) return;
        await this.rows.update({ id }, patch as never);
    }

    /** True while another worker holds this row's provisioning lease. */
    private leaseHeld(row: WorkAppDependencyMetadata): boolean {
        const until = row.provisionLeaseUntil;
        if (!until) return false;
        return new Date(until).getTime() > this.nowMs();
    }

    private async dispatch(
        workId: string,
        kind: AppDependencyKind,
        result: AppDependencyReconcileResult,
    ): Promise<void> {
        const scheduled = await this.dispatchPayload({ workId, kind, mode: 'provision' });
        if (scheduled) {
            result.dispatched.push(kind);
        } else {
            result.dispatchUnavailable = true;
        }
    }

    private async dispatchPayload(payload: AppDependencyProvisionPayload): Promise<boolean> {
        if (!this.dispatcher) {
            this.logger.warn(
                `No app-dependency-provision dispatcher is bound; ${payload.kind ?? 'all kinds'} for work ${payload.workId} stays pending.`,
            );
            return false;
        }
        const id = await this.dispatcher.dispatchAppDependencyProvision(payload);
        return id !== null && id !== undefined;
    }

    /** One Activity event — kinds, names and numbers only, never a value (plan §9.1:926-943). */
    private async emit(
        name: string,
        row: WorkAppDependencyMetadata,
        extra: Record<string, unknown>,
    ): Promise<void> {
        if (!this.events) return;
        try {
            await this.events.emit({
                name,
                payload: {
                    workId: row.workId,
                    kind: row.kind,
                    providerId: row.providerId,
                    ...extra,
                },
            });
        } catch (error) {
            this.logger.warn(`Activity event ${name} could not be written: ${errorName(error)}`);
        }
    }
}

/* -------------------------------------------------------------------------- *
 * Pure helpers
 * -------------------------------------------------------------------------- */

/** A prepared target and the credential a provider is dialled with. */
interface PreparedTarget {
    ref: {
        workId: string;
        namespace: string;
        target: AppDeployTarget;
        kubeContext?: string | null;
    };
    podLabels: Record<string, string>;
    credential: string;
}

/** A signal that never aborts — used where the call is a question, not a dial. */
const NEVER_ABORTED = new AbortController().signal;

function emptyReconcile(workId: string): AppDependencyReconcileResult {
    return {
        workId,
        deployTarget: null,
        created: [],
        awaitingConfig: [],
        dispatched: [],
        kept: [],
        outOfSpec: [],
        unsupported: [],
        dispatchUnavailable: false,
    };
}

function emptyReport(): AppDependencyDeletionReport {
    return { kept: [], mayRemain: [], remaining: false };
}

/** The object names a provider created — names only, never a value (FR-46, FR-56). */
function refNames(refs: AppDependencyResourceRefs | null | undefined): string[] {
    return (refs?.objects ?? []).map((object) => object.name).filter(Boolean);
}

/** The card's backup block (FR-48). */
function backupView(row: WorkAppDependencyMetadata): AppDependencyBackupView {
    const state: AppDependencyBackupState = row.backupState ?? 'none';
    return {
        policy: row.backupPolicy,
        state,
        lastBackupAt: iso(row.lastBackupAt),
        checkedAt: iso(row.backupCheckedAt),
    };
}

/** The output names a kind publishes here, by name and secrecy only (FR-40, FR-5). */
function outputRefs(
    kind: AppDependencyKind,
    refs: AppDependencyResourceRefs | null | undefined,
): AppDependencyOutputRef[] {
    const names = appDependencyOutputNames(kind).filter(
        (name) => name !== `${APP_DEPENDENCY_BUCKET_OUTPUT_PREFIX}*`,
    );
    const buckets = (refs?.buckets ?? []).map(
        (bucket) => `${APP_DEPENDENCY_BUCKET_OUTPUT_PREFIX}${bucket}`,
    );
    return [...names, ...buckets].map((name) => ({
        name,
        secret: isAppDependencyOutputSecret(kind, name),
    }));
}

/**
 * The one mapping from APW-06's port vocabulary to the card's reason vocabulary
 * — APW07-G28.
 *
 * Two sources, because the port and the card genuinely speak differently:
 *
 * - The four port codes are APW-06's, per APW-07 plan §4.8:550-556 and APW-06
 *   plan §9.9:1564-1567 (`AppRuntimeTargetUnavailable` in
 *   `packages/agent/src/app-runtime/ports.ts`): `target_none` (no target
 *   chosen), `target_not_checked` (no passing cluster check),
 *   `namespace_owned_elsewhere` (the ownership check failed) and
 *   `cluster_unreachable` (the credential or the API could not be used).
 * - `namespace_owned_elsewhere` → `namespaceNotOwned` is APW-07 plan §4.9:597-602
 *   verbatim: the provider's old policy check is replaced by "the definite
 *   failure reason **`namespaceNotOwned`** (APW-06's namespace ownership check
 *   failed)", and that member already existed in the contract. This is a
 *   mapping, not a new member.
 *
 * A total `Record`, so a fifth port code is a **compile error** here rather than
 * a silent `null` on the card: `asReason` drops any string the closed union does
 * not name, and a dropped reason is a card that reads *Failed* and explains
 * nothing.
 */
const TARGET_UNAVAILABLE_REASONS: Record<AppRuntimeTargetUnavailable, AppDependencyReason> = {
    target_none: 'targetNone',
    target_not_checked: 'targetNotChecked',
    namespace_owned_elsewhere: 'namespaceNotOwned',
    cluster_unreachable: 'clusterUnreachable',
};

/** The contract reason of one unavailable target — the only way one is stored or returned (APW07-G28). */
function reasonForUnavailableTarget(unavailable: AppRuntimeTargetUnavailable): AppDependencyReason {
    return TARGET_UNAVAILABLE_REASONS[unavailable];
}

/** A stored reason, as the vocabulary's own member or `null` (a raw discriminant is not copy). */
function asReason(reason: string | null | undefined): AppDependencyReason | null {
    return reason && isAppDependencyReason(reason) ? reason : null;
}

function iso(value: Date | string | number | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** The App spec's default volume for a kind, through contracts' own table (FR-37). */
function defaultSizeFor(kind: AppDependencyKind): number | null {
    return appDependencyDefaultSizeGiB(kind);
}

/** Compare two `simple-json` declared blocks without depending on key order. */
function sameJson(a: unknown, b: unknown): boolean {
    return stableJson(a) === stableJson(b);
}

function stableJson(value: unknown): string {
    if (value === null || value === undefined) return 'null';
    if (typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

/** A driver-portable unique-violation test — Postgres, SQLite and MySQL each spell it differently. */
export function isUniqueViolation(error: unknown): boolean {
    const text = `${errorName(error)} ${errorMessage(error)} ${driverCode(error)}`.toLowerCase();
    return (
        text.includes('unique') ||
        text.includes('duplicate key') ||
        text.includes('sqlite_constraint') ||
        text.includes('23505') ||
        text.includes('er_dup_entry')
    );
}

function driverCode(error: unknown): string {
    const carried = (error as { code?: unknown; driverError?: { code?: unknown } } | null) ?? {};
    return `${carried.code ?? ''} ${carried.driverError?.code ?? ''}`;
}

function errorName(error: unknown): string {
    return error instanceof Error ? error.name : typeof error;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : '';
}

/** Re-exported so a consumer can name these without a second import. */
export type {
    AppDependencyFacadeOptions,
    AppRuntimeTargetUnavailable,
    IAppDependencyProvider,
    WorkAppDependencyMetadata,
};
