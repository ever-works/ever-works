import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { AppBuildNotDeployableReason } from '@ever-works/contracts';
import type {
    BuildAuth,
    BuildRef,
    BuildRepositoryRef,
    BuildRunStatus,
    BuildSnapshot,
} from '@ever-works/plugin';
import { AppEnvService } from '../app-env/app-env.service';
import { AppBuildPreparationRepository } from '../database/repositories/app-build-preparation.repository';
import { AppBuildRepository } from '../database/repositories/app-build.repository';
import { WorkBuild } from '../entities/work-build.entity';
import {
    APP_BUILD_PLUGIN_RESOLVER,
    APP_BUILD_WORK_SOURCE,
    AppBuildsService,
    isTerminalBuildStatus,
    type AppBuildPluginBinding,
    type AppBuildWatchJobPayload,
    // T17's provisional PORT for this class, aliased because the class below
    // carries the same name — see the barrel's note on the collision, the same
    // one T19 resolved for the prepare runner.
    type AppBuildWatchRunner as AppBuildWatchRunnerPort,
    type AppBuildWorkContext,
    type AppBuildWorkSource,
} from './app-builds.service';

/**
 * APW-05 T20 — the `app-build-watch` runner (plan §7.3, §7.1, §4.8, §4.10).
 *
 * Spec: `docs/specs/features/app-works/APW-05-builds/spec.md` — FR-34/FR-35 (the
 * two intake paths and the observation), FR-31 and §5.1 (the deployable verdict),
 * FR-53/§4.10 (the per-run verification secret), FR-5 (the redactor);
 * ACC-05-07, ACC-05-11, ACC-05-12; `APW05-G03`, `APW05-G05`, `APW05-G11`,
 * `APW05-G20`.
 *
 * One dispatch is one **observation** of one Build. This file does the four
 * things §7.3 asks of the job and nothing else:
 *
 *   1. **the lease** — `AppBuildRepository.claimWatchLease(buildId, 2 min)`
 *      (the query-builder UPDATE of §7.3:1386-1388); 0 rows ⇒ a live lease
 *      covers the Build and this run exits as `leaseHeld`;
 *   2. **the read** — resolve the App Work and its build plugin, build the
 *      `BuildRef`, and call `IBuildPlugin.getBuild(ref, auth, redact)` with
 *      APW-07's redactor, so no unredacted log text ever reaches a row (FR-38);
 *   3. **the re-stamp** (`APW05-G03`) — when the first non-null `startedAt` is
 *      about to be recorded, copy `buildInputsHash`, `buildSecretNames` and
 *      `secretsSyncedAt` from the preparation row **only** when
 *      `secretsSyncedAt <= startedAt`, so the verdict of §5.1 judges the values
 *      this run actually read;
 *   4. **the release** — clear `watchLeaseUntil` in a `finally`, so the next
 *      delivery of the same run is not refused by a lease this run is done with.
 *
 * ## Everything a transition writes goes through T17's service
 *
 * Mapping the snapshot onto the row, `lastObservedAt`, the `startedAt` claim,
 * the terminal claim, the deployable verdict, the receipt and the terminal event
 * are `AppBuildsService.applySnapshot` → `finalize` → `publish` — §7.8's ONE
 * Activity + event writer. This file never writes a status, never emits an
 * event, and never writes an Activity row; a second writer is the one thing
 * §7.8 forbids. It follows that "the terminal transition finalises exactly once
 * across N deliveries" is a property of the ROW (the two conditional claims), not
 * of this lease — which is why a duplicated or late dispatch is harmless.
 *
 * ## The per-run verification secret (§4.10, `APW05-G11`)
 *
 * A verification Build whose run started carries the one sealed
 * `EW_VERIFY__PROMPTED` secret named in `verifySecretNames`. On its terminal
 * transition this job deletes it through the plugin
 * (`deleteVerifyPromptedSecret?`) and clears the column, so §7.4's orphan pass
 * does not delete it a second time. A missing or throwing member is logged, never
 * fatal: the sweep's `30 + 10` minute backstop exists for exactly that case.
 *
 * ## Fail closed, with the missing thing named
 *
 * An unbound collaborator is not a crash and not a silent success. The reasons
 * are in {@link APP_BUILD_WATCH_SKIP_REASONS} and each names its port —
 * `buildUnavailable` (the entity repository, or a row that is gone),
 * `workUnavailable` (`APP_BUILD_WORK_SOURCE`), `pluginUnavailable`
 * (`APP_BUILD_PLUGIN_RESOLVER`, or a binding with no `getBuild`),
 * `authUnavailable` (a binding with no resolved `BuildAuth`),
 * `redactorUnavailable` (neither the binding nor APW-07's
 * `AppEnvService.buildRedactor` can produce one — calling `getBuild` without a
 * redactor is how an unredacted log excerpt would reach `failureExcerpt`),
 * `snapshotUnavailable` (`getBuild` answered `null`: no such run),
 * `leaseHeld` (another observation holds the Build) and `concurrencyLimited`
 * (§7.1's ten in-process runs per process).
 *
 * A provider THROW is deliberately not caught, exactly as in the prepare runner:
 * §9.2 retries a GitHub 5xx "with the runtime's backoff", and §7.4's sweep
 * re-observes every silent Build within two minutes regardless. The lease is
 * still released, because the `finally` owns it rather than the happy path.
 */

/* -------------------------------------------------------------------------- *
 * Constants
 * -------------------------------------------------------------------------- */

/** The job id, exported so the task file and the specs never copy the string. */
export const APP_BUILD_WATCH_JOB_ID = 'app-build-watch' as const;

/** The lease of §7.3:1387-1388 — `:until = :now + 2 minutes`. */
export const APP_BUILD_WATCH_LEASE_MS = 2 * 60 * 1000;

/**
 * §7.1:1329-1330: "in-process watch runs are capped at 10 at a time per API
 * process; the excess is left to the next sweep tick".
 *
 * Counted on THIS instance, which Nest keeps as one singleton per process, so the
 * number is per-process by construction. The refusal is a named `skipped`, never
 * a queue: §7.4's two-minute tick already covers every silent non-terminal Build,
 * so an observation dropped here is deferred, not lost.
 *
 * 🛑 **Routed as a finding.** `AppBuildsService.runInProcess` guards its
 * fallbacks with a `Set` keyed `job:key` — one in-flight run per SUBJECT, not ten
 * per process — while its own docstring reads as if that were this cap
 * (`app-builds.service.ts:1117-1148`). The two are different bounds, and this
 * constant is the one §7.1 states.
 */
export const APP_BUILD_WATCH_MAX_CONCURRENT_RUNS = 10;

/* -------------------------------------------------------------------------- *
 * The watch-side view of the build plugin (provisional — T16)
 * -------------------------------------------------------------------------- */

/**
 * _Provisional — T16 (`packages/agent/src/facades/build.facade.ts`)._
 *
 * The **observe** half of `BuildFacadeService.resolve(workId, userId)`. T17
 * declared what its own service calls ({@link AppBuildPluginBinding}); an
 * observation needs four more things, and none of them is a second resolution
 * path:
 *
 *   - `auth` — the `BuildAuth` every `IBuildPlugin` call takes (`§4.1:599-601`).
 *     The facade resolves it and it is **never logged**; a binding without one is
 *     `authUnavailable`, because a provider call with no credential would be a
 *     request this job has no business making.
 *   - `getBuild` — §7.3:1388's observation. `null` means "no such run", which is
 *     not an error (the sweep will ask again).
 *   - `redact` — APW-07's redactor, which §4.8 says `getBuild` applies to every
 *     excerpt. When the binding does not carry one this job asks
 *     `AppEnvService.buildRedactor(workId)` (`app-env.service.ts:1596`) instead,
 *     so today's un-facaded graph still redacts.
 *   - `deleteVerifyPromptedSecret` — §4.10's removal half. It exists in T12's
 *     `packages/plugins/github-actions-build/src/repo/secret-sync.ts:314` and no
 *     contract member carries it yet.
 *
 * 🛑 **The swap is an import, not a rewrite.** The token is T17's
 * `APP_BUILD_PLUGIN_RESOLVER`, imported rather than re-declared: a second
 * `Symbol('APP_BUILD_PLUGIN_RESOLVER')` would be a different token and T16's
 * binding would reach neither injection. When T16 lands, `resolve`'s answer
 * widens to this interface and this declaration disappears.
 */
export interface AppBuildWatchPluginBinding extends AppBuildPluginBinding {
    /** The repository the Build runs against; R-4's `createdByAppWork` lives here. */
    readonly repository?: BuildRepositoryRef;
    /** Plan §4.4's resolved settings — what the observer needs them for. */
    readonly settings?: Record<string, unknown>;
    /** The resolved git credential. Never logged, never stored by this file. */
    readonly auth?: BuildAuth;
    /** APW-07's redactor for this App Work (§4.8:992-993), when the binding carries it. */
    readonly redact?: (text: string) => string;
    /** §7.3:1388 — one observation of one run. `null` = "no such run". */
    getBuild?(
        ref: BuildRef,
        auth: BuildAuth,
        redact: (text: string) => string,
    ): Promise<BuildSnapshot | null>;
    /**
     * §4.10:1032-1033 — delete the one per-run prompted-value secret.
     *
     * A binding without it is not an error: §7.4's orphan pass deletes a secret
     * still present `30 + 10` minutes after `startedAt`.
     */
    deleteVerifyPromptedSecret?(): Promise<unknown>;
}

/** The resolver, seen through the observe half. Token: T17's `APP_BUILD_PLUGIN_RESOLVER`. */
export interface AppBuildWatchPluginResolver {
    resolve(workId: string, userId: string): Promise<AppBuildWatchPluginBinding | null>;
}

/* -------------------------------------------------------------------------- *
 * The result
 * -------------------------------------------------------------------------- */

/**
 * Why a run did nothing. Every member names the missing thing rather than hiding
 * behind a generic "skipped" — the run log is the only place an unconfigured
 * installation is visible from.
 */
export const APP_BUILD_WATCH_SKIP_REASONS = [
    'invalidPayload',
    'concurrencyLimited',
    'buildUnavailable',
    'leaseHeld',
    'workUnavailable',
    'pluginUnavailable',
    'authUnavailable',
    'redactorUnavailable',
    'snapshotUnavailable',
] as const;

/** One skip reason. */
export type AppBuildWatchSkipReason = (typeof APP_BUILD_WATCH_SKIP_REASONS)[number];

/** What one run of the job reports. Ids, statuses and counts only — never a value. */
export interface AppBuildWatchRunResult {
    /** `observed` — a snapshot reached the row. `skipped` — a named reason. `failed` — a throw. */
    readonly status: 'observed' | 'skipped' | 'failed';
    readonly jobId: string;
    readonly buildId: string | null;
    /** The skip reason, or `null` on `observed`. */
    readonly reason: string | null;
    /** The status the provider reported, or `null` when nothing was read. */
    readonly observedStatus: BuildRunStatus | null;
    /** True when this run recorded the Build's first `startedAt` (§7.8:1565-1568). */
    readonly started: boolean;
    /** True when this run copied the three §3.1b stamps onto the row (`APW05-G03`). */
    readonly restamped: boolean;
    /** True when this run took the terminal claim — i.e. this run is the one that finalised. */
    readonly finalised: boolean;
    /** The settled verdict, read back from the row. */
    readonly deployable: boolean;
    readonly notDeployableReason: AppBuildNotDeployableReason | null;
    /** How many per-run verification secrets this run deleted (§4.10). */
    readonly verifySecretsRemoved: number;
    readonly error: string | null;
}

/* -------------------------------------------------------------------------- *
 * Pure helpers
 * -------------------------------------------------------------------------- */

/** `owner/repo` → its two halves; a full name this job cannot split answers `''`. */
export function repositoryCoordinates(fullName: string): { owner: string; repo: string } {
    const parts = String(fullName ?? '').split('/');
    return { owner: parts[0] ?? '', repo: parts.length > 1 ? (parts[1] ?? '') : '' };
}

/** A provider-reported instant as a `Date`, or `null` when it is missing or unparseable. */
function instantOf(value: string | Date | null | undefined): Date | null {
    if (!value) return null;
    const parsed = value instanceof Date ? value : new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * T17's `finalize` guard, read from a row: a Build whose verdict is settled has
 * already been finalised, so nothing may finalise it again.
 */
function isFinalised(row: WorkBuild | null | undefined): boolean {
    return Boolean(row && (row.deployable || row.notDeployableReason));
}

/** `error.message` when there is one, `String(error)` otherwise. */
function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/* -------------------------------------------------------------------------- *
 * The runner
 * -------------------------------------------------------------------------- */

@Injectable()
export class AppBuildWatchRunner implements AppBuildWatchRunnerPort {
    private readonly logger = new Logger(AppBuildWatchRunner.name);

    /** Observations in flight in THIS process — §7.1's ten, see the constant. */
    private inFlight = 0;

    constructor(
        private readonly builds: AppBuildRepository,
        private readonly preparations: AppBuildPreparationRepository,
        // §7.8's ONE writer: the row mapping, the two claims, the verdict, the
        // receipt and the terminal event are all its. This file writes no status
        // and emits no event on its own.
        private readonly service: AppBuildsService,
        @Optional()
        @Inject(APP_BUILD_PLUGIN_RESOLVER)
        private readonly plugins?: AppBuildWatchPluginResolver,
        @Optional()
        @Inject(APP_BUILD_WORK_SOURCE)
        private readonly works?: AppBuildWorkSource,
        // APW-07's redactor (`buildRedactor`), injected as the CLASS rather than
        // behind a new token — the same call the prepare runner makes for
        // `resolveForBuild` (`app-build-prepare.runner.ts:601-607`). Unbound, a
        // binding that carries no `redact` answers `redactorUnavailable` rather
        // than observing with no redactor at all.
        @Optional() private readonly env?: AppEnvService,
        // The entity's own repository, for the row read, the `APW05-G03`
        // re-stamp, the lease release and the verification-secret cleanup — the
        // same three-claim reason `AppBuildsService` injects it
        // (`app-builds.service.ts:937-944`) and the prepare runner does
        // (`app-build-prepare.runner.ts:608-615`): `AppBuildRepository` owns the
        // lease and the number arithmetic, and exposes no generic patch.
        @Optional()
        @InjectRepository(WorkBuild)
        private readonly rows?: Repository<WorkBuild>,
    ) {}

    /* ---------------------------------------------------------------------- *
     * run — one observation
     * ---------------------------------------------------------------------- */

    /**
     * One dispatch of `app-build-watch` (§7.1:1315, §7.3).
     *
     * The order is the contract: payload, the in-process cap, the row, the lease,
     * then everything else. A run that cannot take the lease must not touch the
     * provider — that is the whole of §7.3:1386-1388.
     */
    async run(payload: AppBuildWatchJobPayload): Promise<AppBuildWatchRunResult> {
        const buildId = typeof payload?.buildId === 'string' ? payload.buildId : null;
        if (!buildId) {
            return this.result({ status: 'skipped', buildId: null, reason: 'invalidPayload' });
        }

        if (this.inFlight >= APP_BUILD_WATCH_MAX_CONCURRENT_RUNS) {
            this.logger.debug(
                `App builds: build ${buildId} is not observed in process — ${
                    APP_BUILD_WATCH_MAX_CONCURRENT_RUNS
                } runs are already in flight here; §7.4's sweep will ask again.`,
            );
            return this.result({ status: 'skipped', buildId, reason: 'concurrencyLimited' });
        }

        this.inFlight += 1;
        try {
            return await this.observe(buildId, payload);
        } finally {
            this.inFlight -= 1;
        }
    }

    /** The observation itself, under the claimed lease. */
    private async observe(
        buildId: string,
        payload: AppBuildWatchJobPayload,
    ): Promise<AppBuildWatchRunResult> {
        if (!this.rows) {
            this.logger.warn(
                'App builds: the WorkBuild repository is not bound; the watch cannot read a Build.',
            );
            return this.result({ status: 'skipped', buildId, reason: 'buildUnavailable' });
        }

        const before = await this.readRow(buildId);
        if (!before) {
            // The row is gone (the App Work was deleted). Nothing to observe, and
            // nothing to release: no lease was taken.
            return this.result({ status: 'skipped', buildId, reason: 'buildUnavailable' });
        }

        const leased = await this.builds.claimWatchLease(buildId, APP_BUILD_WATCH_LEASE_MS);
        if (!leased) {
            this.logger.debug(
                `App builds: another observation holds build ${buildId} (${payload.reason}); this dispatch exits as leaseHeld.`,
            );
            return this.result({ status: 'skipped', buildId, reason: 'leaseHeld' });
        }

        try {
            return await this.observeLeased(buildId, before, payload);
        } finally {
            await this.releaseLease(buildId);
        }
    }

    /** Everything §7.3 does between the claim and the release. */
    private async observeLeased(
        buildId: string,
        before: WorkBuild,
        payload: AppBuildWatchJobPayload,
    ): Promise<AppBuildWatchRunResult> {
        const context = await this.readWork(before.workId);
        if (!context) {
            return this.result({ status: 'skipped', buildId, reason: 'workUnavailable' });
        }

        const binding = await this.resolvePlugin(before.workId, context.userId);
        if (!binding?.getBuild) {
            return this.result({ status: 'skipped', buildId, reason: 'pluginUnavailable' });
        }

        const auth = binding.auth;
        if (!auth || typeof auth.token !== 'string' || auth.token === '') {
            return this.result({ status: 'skipped', buildId, reason: 'authUnavailable' });
        }

        const redact = await this.resolveRedactor(before.workId, binding);
        if (!redact) {
            return this.result({ status: 'skipped', buildId, reason: 'redactorUnavailable' });
        }

        const ref = this.buildRef(before, binding, context);
        const snapshot = await binding.getBuild(ref, auth, redact);
        if (!snapshot) {
            // "No such run" — never "I could not tell", which is a throw. The
            // sweep asks again on its next tick.
            return this.result({ status: 'skipped', buildId, reason: 'snapshotUnavailable' });
        }

        // BEFORE the service maps the snapshot: `finalize` reads these three
        // columns, and a terminal snapshot finalises inside `applySnapshot`.
        const restamped = await this.restampInputs(before, snapshot);

        const settled = await this.service.applySnapshot(buildId, snapshot);
        const after = settled ?? (await this.readRow(buildId));

        const verifySecretsRemoved = await this.removeVerifySecret(before, after, binding);

        this.logger.debug(
            `App builds: build ${buildId} observed as ${snapshot.status} (${payload.reason}).`,
        );

        return this.result({
            status: 'observed',
            buildId,
            reason: null,
            observedStatus: snapshot.status,
            started: !before.startedAt && Boolean(after?.startedAt),
            restamped,
            finalised: !isFinalised(before) && isFinalised(after),
            deployable: after?.deployable ?? false,
            notDeployableReason:
                (after?.notDeployableReason as AppBuildNotDeployableReason | null | undefined) ??
                null,
            verifySecretsRemoved,
        });
    }

    /* ---------------------------------------------------------------------- *
     * §7.3 — the re-stamp, the lease release and the per-run secret
     * ---------------------------------------------------------------------- */

    /**
     * §7.3:1389-1391 and §5.1:1263 — "When the first non-null `startedAt` is
     * recorded, re-stamp `buildInputsHash`, `buildSecretNames` and
     * `secretsSyncedAt` from the preparation row **only** when
     * `row.secretsSyncedAt <= startedAt`" (`APW05-G03`).
     *
     * Three guards, and each is a fact rather than a formality:
     *
     *   - `before.startedAt` is NULL — this is the FIRST `startedAt`, the only
     *     moment §7.3 re-stamps. A later observation must not overwrite what the
     *     run actually read with values that have moved on since.
     *   - the snapshot carries a parseable `startedAt` — without it there is
     *     nothing to compare against, so there is nothing to justify a re-stamp.
     *   - `secretsSyncedAt <= startedAt` — a sync that finished AFTER the run
     *     started is exactly the case that must stay `staleInputs` (§5.1's S24),
     *     so those stamps are left alone.
     *
     * The write is one parameterised UPDATE through the query builder, guarded by
     * `startedAt IS NULL`. That predicate is the SAME one
     * `AppBuildsService.claimStarted` uses, so this can never stamp a Build whose
     * first `startedAt` a concurrent observation recorded a moment earlier — that
     * run owns the comparison, and it made it. `0 rows` is therefore a normal
     * outcome, not a failure.
     *
     * @returns `true` only when this call changed the row.
     */
    private async restampInputs(before: WorkBuild, snapshot: BuildSnapshot): Promise<boolean> {
        if (before.startedAt) {
            return false;
        }
        const startedAt = instantOf(snapshot.startedAt);
        if (!startedAt || !this.rows) {
            return false;
        }

        const preparation = await this.preparations.findByWork(before.workId);
        const syncedAt = instantOf(preparation?.secretsSyncedAt ?? null);
        if (!preparation || !syncedAt || syncedAt.getTime() > startedAt.getTime()) {
            return false;
        }

        const result = await this.rows
            .createQueryBuilder()
            .update(WorkBuild)
            .set({
                buildInputsHash: preparation.buildInputsHash ?? null,
                buildSecretNames: preparation.buildSecretNames ?? null,
                secretsSyncedAt: syncedAt,
            })
            .where('id = :id', { id: before.id })
            .andWhere('startedAt IS NULL')
            .execute();

        return (result.affected ?? 0) === 1;
    }

    /**
     * §7.3's last line: "Release the lease."
     *
     * One parameterised UPDATE clearing `watchLeaseUntil`. The claim of
     * §7.3:1386-1388 carries no token, so there is nothing to compare against and
     * this is an unconditional clear — which is safe for the reason §7.8 gives:
     * the two conditional claims on the row (`startedAt`, the terminal
     * transition) ARE the exactly-once mechanism, so a lease cleared early can
     * cost one extra provider call and can never cost a second transition. A
     * failure here is logged and swallowed: the lease expires on its own two
     * minutes later, and a release that threw would fail a run that already did
     * its job.
     */
    private async releaseLease(buildId: string): Promise<void> {
        if (!this.rows) return;
        try {
            await this.rows
                .createQueryBuilder()
                .update(WorkBuild)
                .set({ watchLeaseUntil: null })
                .where('id = :id', { id: buildId })
                .execute();
        } catch (error) {
            this.logger.warn(
                `App builds: releasing the watch lease of build ${buildId} failed (${errorText(
                    error,
                )}); the lease expires on its own.`,
            );
        }
    }

    /**
     * §4.10:1032-1033 — "`app-build-watch` deletes it on the Build's terminal
     * transition" (`APW05-G11`).
     *
     * A no-op for every non-verification Build, for a Build that never recorded a
     * secret, and for a Build that is not terminal yet. The column is the guard
     * that makes it once-only: the deletion clears `verifySecretNames`, so a
     * second delivery of the same terminal snapshot finds nothing to delete — the
     * same "the row is the state machine" shape the rest of this epic uses. A
     * failure to delete leaves the column alone on purpose, so the next
     * observation retries and §7.4's orphan pass still owns the backstop.
     *
     * @returns how many secrets this run deleted: `0` or `1`.
     */
    private async removeVerifySecret(
        before: WorkBuild,
        after: WorkBuild | null,
        binding: AppBuildWatchPluginBinding,
    ): Promise<number> {
        if (before.trigger !== 'verification') return 0;
        if ((before.verifySecretNames ?? []).length === 0) return 0;
        if (!after || !isTerminalBuildStatus(after.status)) return 0;

        if (typeof binding.deleteVerifyPromptedSecret !== 'function') {
            this.logger.warn(
                `App builds: build ${before.id} left its per-run verification secret behind — the build plugin exposes no deleteVerifyPromptedSecret; §7.4's orphan pass will remove it.`,
            );
            return 0;
        }

        try {
            await binding.deleteVerifyPromptedSecret();
        } catch (error) {
            this.logger.warn(
                `App builds: removing the per-run verification secret of build ${
                    before.id
                } failed (${errorText(error)}); §7.4's orphan pass will retry it.`,
            );
            return 0;
        }

        await this.clearVerifySecretNames(before.id);
        return 1;
    }

    /** The row half of the deletion above: the secret is gone, so the record of it goes too. */
    private async clearVerifySecretNames(buildId: string): Promise<void> {
        if (!this.rows) return;
        try {
            await this.rows
                .createQueryBuilder()
                .update(WorkBuild)
                .set({ verifySecretNames: [] })
                .where('id = :id', { id: buildId })
                .execute();
        } catch (error) {
            // The secret IS deleted; the stale record only means the sweep's
            // orphan pass tries a second deletion, which is harmless.
            this.logger.warn(
                `App builds: clearing verifySecretNames of build ${buildId} failed (${errorText(
                    error,
                )}).`,
            );
        }
    }

    /* ---------------------------------------------------------------------- *
     * The collaborators, each wrapped so an unconfigured graph is a named skip
     * ---------------------------------------------------------------------- */

    /** The row, through the entity's own repository. */
    private async readRow(buildId: string): Promise<WorkBuild | null> {
        if (!this.rows) return null;
        return this.rows.findOne({ where: { id: buildId } });
    }

    private async readWork(workId: string): Promise<AppBuildWorkContext | null> {
        if (!this.works) return null;
        try {
            return await this.works.read(workId);
        } catch (error) {
            this.logger.warn(
                `App builds: reading the App Work ${workId} failed (${errorText(error)}).`,
            );
            return null;
        }
    }

    private async resolvePlugin(
        workId: string,
        userId: string,
    ): Promise<AppBuildWatchPluginBinding | null> {
        if (!this.plugins) return null;
        try {
            return await this.plugins.resolve(workId, userId);
        } catch (error) {
            this.logger.warn(
                `App builds: resolving the build plugin of ${workId} failed (${errorText(error)}).`,
            );
            return null;
        }
    }

    /**
     * The redactor §4.8 hands to `getBuild`: the binding's own when T16 supplies
     * one, otherwise APW-07's `AppEnvService.buildRedactor`.
     *
     * APW-07's `buildRedactor` THROWS rather than returning a function that
     * redacts nothing ("a function that redacts nothing is worse than no
     * redactor, because its caller believes the line is safe",
     * `app-env.service.ts:1590-1594`). This job takes the same position one level
     * up: no redactor means no observation, named `redactorUnavailable`, because
     * the alternative is `getBuild` writing a raw log excerpt into
     * `failureExcerpt` — the FR-38 leak.
     */
    private async resolveRedactor(
        workId: string,
        binding: AppBuildWatchPluginBinding,
    ): Promise<((text: string) => string) | null> {
        if (typeof binding.redact === 'function') return binding.redact;
        if (!this.env?.buildRedactor) return null;
        try {
            return await this.env.buildRedactor(workId);
        } catch (error) {
            this.logger.warn(
                `App builds: APW-07's redactor for work ${workId} is unavailable (${errorText(
                    error,
                )}); build observations for it are skipped rather than stored unredacted.`,
            );
            return null;
        }
    }

    /**
     * §4.1:305-311's `BuildRef` — the repository the run belongs to, the Build and
     * the run identity once §4.8's correlation has adopted one.
     *
     * 🛑 **Routed as a finding.** `createdByAppWork` is `false` in the fallback
     * below, because `AppBuildWorkContext` deliberately does not carry the Work's
     * relation and guessing "Fork" would be worse than reporting "not ours".
     * `getBuild` takes no write path, so the field steers nothing here; T16's
     * facade supplies `repository` and the fallback stops being used.
     */
    private buildRef(
        before: WorkBuild,
        binding: AppBuildWatchPluginBinding,
        context: AppBuildWorkContext,
    ): BuildRef {
        const { owner, repo } = repositoryCoordinates(context.repositoryFullName);
        return {
            repository: binding.repository ?? {
                owner,
                repo,
                visibility: context.repositoryVisibility,
                trackedBranch: context.trackedBranch,
                createdByAppWork: false,
            },
            buildId: before.id,
            providerRunId: before.providerRunId ?? null,
            ...(before.dispatchedAt ? { dispatchedAt: before.dispatchedAt.toISOString() } : {}),
        };
    }

    /* ---------------------------------------------------------------------- *
     * Accounting
     * ---------------------------------------------------------------------- */

    private result(input: {
        readonly status: AppBuildWatchRunResult['status'];
        readonly buildId: string | null;
        readonly reason?: string | null;
        readonly observedStatus?: BuildRunStatus | null;
        readonly started?: boolean;
        readonly restamped?: boolean;
        readonly finalised?: boolean;
        readonly deployable?: boolean;
        readonly notDeployableReason?: AppBuildNotDeployableReason | null;
        readonly verifySecretsRemoved?: number;
        readonly error?: string | null;
    }): AppBuildWatchRunResult {
        return {
            status: input.status,
            jobId: APP_BUILD_WATCH_JOB_ID,
            buildId: input.buildId,
            reason: input.reason ?? null,
            observedStatus: input.observedStatus ?? null,
            started: input.started ?? false,
            restamped: input.restamped ?? false,
            finalised: input.finalised ?? false,
            deployable: input.deployable ?? false,
            notDeployableReason: input.notDeployableReason ?? null,
            verifySecretsRemoved: input.verifySecretsRemoved ?? 0,
            error: input.error ?? null,
        };
    }
}
