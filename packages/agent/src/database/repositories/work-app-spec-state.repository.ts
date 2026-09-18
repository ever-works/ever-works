import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { APP_SPEC_EVALUATE_COALESCE_MS } from '@ever-works/contracts';
import type {
    AppLicenseEvidence,
    AppSpec,
    AppSpecEvaluationTrigger,
    AppSpecIssue,
    AppSpecValidationStatus,
    BlueprintMatchSource,
    LicenseAttestation,
    LicenseClass,
    LicenseRegistrySource,
    LicenseSource,
} from '@ever-works/contracts';
import { WorkAppSpecState } from '../../entities/work-app-spec-state.entity';
import { serializeOnSingleConnection } from './single-connection-write-queue';

/**
 * APW-03 (App spec, Apps catalog and license gate) — the
 * `work_app_spec_states` repository.
 *
 * Plan §3.1 (`plan.md:454-459`) names the methods and T11 fixes their
 * signatures. Feature-owned: it is provided by the feature's own module and
 * exported from `database/index.ts` for it, NOT by `DatabaseModule` — see the
 * docstring of `_repository-inventory.ts` for why a feature-owned repository
 * must not appear in that inventory.
 *
 * ## The five sequence columns are only ever touched here
 *
 * `requestedSeq` / `startedSeq` / `evaluatedSeq` and their licence pair carry
 * the coalescing arithmetic of plan §2.3:189-194. Every write that moves one of
 * them is a **single conditional statement** whose WHERE clause re-evaluates
 * its own predicate under the row lock, so two API replicas racing on the same
 * App Work cannot both claim a slot:
 *
 *   - {@link requestEvaluation} — one `UPDATE` that increments `requestedSeq`
 *     and either coalesces or stamps `dispatchedAt` (FR-22);
 *   - {@link markStarted} — `startedSeq = requestedSeq`, so the job that starts
 *     reads the **newest** request, never the one its dispatch was raised for;
 *   - {@link writeEvaluation} / {@link writeLicense} — guarded by
 *     `evaluatedSeq < :seq` / `licenseEvaluatedSeq < :seq`, so an older job that
 *     loses the race writes **nothing** and the newer result stays (ACC-03-12).
 *
 * ## Why the coalescing statement is not `QueryBuilder.returning()`
 *
 * Plan §2.3 asks for `UPDATE … RETURNING`. TypeORM refuses it on every
 * non-Postgres driver — `UpdateQueryBuilder.returning()` throws
 * `ReturningStatementNotSupportedError` as soon as
 * `driver.isReturningSqlSupported('update')` is false, and
 * `AbstractSqliteDriver` returns exactly that for **better-sqlite3**, the
 * default `DATABASE_TYPE` (`database.config.ts:132`), the CI driver and the
 * e2e stack. Hand-writing `UPDATE … RETURNING` as raw SQL would work on
 * better-sqlite3 (SQLite ≥ 3.35 returns rows for it) but not on MySQL, another
 * driver this repository supports — and it would put physical table and column
 * names into a repository that otherwise never names them.
 *
 * The statement therefore keeps the plan's **semantics** on every driver: one
 * `UPDATE` performs the increment, the coalescing decision and the stamp in a
 * single atomic statement, and the decision is read back **inside the same
 * transaction**, where the row lock the `UPDATE` took is still held and no
 * other writer can interleave. {@link requestEvaluation}'s outcome is computed
 * **in SQL** (`CASE WHEN "dispatchedAt" >= :stamp`), never by comparing dates
 * in JavaScript: a `Date` hydrated from SQLite and one hydrated from Postgres
 * do not agree on a wall clock, and `dispatchedAt` differs between the two
 * branches only by the value the statement itself wrote.
 *
 * ## Every instant here is a `Date`, never an epoch number
 *
 * Unlike `work_upstream_states` (whose dates are `TimestampColumn` bigints),
 * this table's dates are real `PortableDateColumn` timestamps (plan §3.1:399).
 * A `Date` bound through the query builder is converted by each driver's own
 * `escapeQueryWithParameters` — better-sqlite3 writes
 * `YYYY-MM-DD HH:MM:SS.mmm`, Postgres and MySQL take the value natively — so
 * no caller formats a timestamp by hand.
 *
 * ## Bounded scans
 *
 * {@link findUpgradeCandidates} and {@link findStaleRegistry} are the two
 * fan-out reads of the hourly catalog refresh (plan §6.4:678-686, "≤ 500 Works
 * per run"), and both clamp a larger `limit` rather than honouring it.
 */

/**
 * The hard ceiling on one fan-out batch — plan §6.4:681-682 passes 500, and the
 * cap exists so a caller cannot ask for the whole table.
 */
export const WORK_APP_SPEC_STATE_SCAN_MAX = 500;

/** The `tenantId` / `organizationId` stamps APW-01 writes with the row. */
export interface WorkAppSpecStateScope {
    readonly tenantId?: string | null;
    readonly organizationId?: string | null;
}

/**
 * The answer to one {@link WorkAppSpecStateRepository.requestEvaluation}.
 *
 * `dispatched` is the coalescing arithmetic's verdict (FR-22): the caller
 * dispatches `app-spec-evaluate` only when it is `true`. `requested` is `false`
 * when the App Work has no state row any more — its Work was deleted, and the
 * FK cascade took the row with it — which is how a webhook delivery for a
 * deleted App Work stops instead of raising a job that can never find its row.
 */
export interface EvaluationRequestOutcome {
    /** `false` when there is no row to request an evaluation for. */
    readonly requested: boolean;
    /** `true` only when THIS call stamped `dispatchedAt` and must dispatch the job. */
    readonly dispatched: boolean;
    /** `requestedSeq` after the statement — the sequence a job will claim. */
    readonly requestedSeq: number;
    /** `evaluatedSeq` after the statement; `requestedSeq > evaluatedSeq` means pending. */
    readonly evaluatedSeq: number;
}

/**
 * What one evaluation writes (plan §2.3). Every field except the four the
 * evaluator always knows is optional, and an **absent** field leaves its column
 * untouched — which is load-bearing, not tidiness: an invalid head keeps the
 * effective spec of the last valid commit (ACC-03-10), so a write that carried
 * `effectiveSpec: null` implicitly would erase it.
 */
export interface AppSpecEvaluationResult {
    /** `created` · `push` · `pr_merged` · `manual` · `lazy` · `blueprint_applied` · `build`. */
    readonly trigger: AppSpecEvaluationTrigger;
    readonly headCommitSha: string | null;
    readonly headSpecHash: string | null;
    readonly validationStatus: AppSpecValidationStatus;
    readonly errorCount: number;
    readonly warningCount: number;
    readonly issues?: AppSpecIssue[] | null;
    readonly issuesTruncated?: boolean;
    /** The provider error code when `validationStatus` is `unreadable`. */
    readonly lastEvaluationError?: string | null;
    readonly evaluatedAt?: Date | null;
    /** Written only by an evaluation whose head has zero errors (FR-20). */
    readonly effectiveCommitSha?: string | null;
    readonly effectiveSpecHash?: string | null;
    readonly effectiveSpec?: AppSpec | null;
    readonly effectiveAt?: Date | null;
    /** The tracked-branch move of FR-16, when this evaluation made one. */
    readonly trackedBranch?: string | null;
}

/**
 * What one licence evaluation writes (plan §2.6:303-317). Same absent-means-
 * untouched rule as {@link AppSpecEvaluationResult}: a licence that could not be
 * re-read keeps the classification it had.
 */
export interface AppLicenseEvaluationResult {
    readonly licenseSpdx?: string | null;
    readonly licenseClass?: LicenseClass | null;
    readonly licenseSource?: LicenseSource | null;
    readonly licenseMixed?: boolean;
    readonly licenseScanIncomplete?: boolean;
    readonly licenseEvidence?: AppLicenseEvidence | null;
    readonly licenseObligations?: string[] | null;
    readonly licenseCommitSha?: string | null;
    readonly licenseRegistryHash?: string | null;
    readonly licenseRegistrySource?: LicenseRegistrySource | null;
    /**
     * FR-59/FR-60 — a later evaluation **clears** the attestation when `spdx`,
     * `class` or `textId` differ. Passing `null` is how it does that; omitting
     * the field leaves the record alone.
     */
    readonly attestation?: LicenseAttestation | null;
    /** A display cache for the License card; eligibility recomputes it (plan §2.6:348). */
    readonly sourceOfferRequired?: boolean;
    readonly evaluatedAt?: Date | null;
}

@Injectable()
export class WorkAppSpecStateRepository {
    constructor(
        @InjectRepository(WorkAppSpecState)
        private readonly repository: Repository<WorkAppSpecState>,
    ) {}

    /** The state row of one App Work, or `null` when it has none yet. */
    async findByWorkId(workId: string): Promise<WorkAppSpecState | null> {
        return this.repository.findOne({ where: { workId } });
    }

    /**
     * Insert the row APW-01 creates with the App Work (`AppSpecService.initialize(workId, branch)`,
     * plan §2.7:380). Everything the caller does not pass takes its declared
     * default (`missing`, the five sequences `0`, the flags `false`) — TypeORM
     * omits an undefined property from the INSERT, so the database applies
     * them, not a second copy of the defaults in TypeScript.
     *
     * **Idempotent.** `workId` is UNIQUE; a second call — two replicas handling
     * the same create, or a retried create path — returns the row that is
     * already there instead of raising, so `initialize` is safe to call on
     * every path that might be first.
     */
    async initialize(
        workId: string,
        trackedBranch: string,
        scope: WorkAppSpecStateScope = {},
    ): Promise<WorkAppSpecState> {
        const existing = await this.findByWorkId(workId);
        if (existing) {
            return existing;
        }

        const entity = this.repository.create({
            workId,
            trackedBranch,
            tenantId: scope.tenantId ?? null,
            organizationId: scope.organizationId ?? null,
        });

        try {
            return await this.repository.save(entity);
        } catch (error) {
            // Lost the race against another writer inserting the same Work's
            // row: its row is the one that exists, so read it and let the
            // UNIQUE index do the arbitration.
            const raced = await this.findByWorkId(workId);
            if (raced) {
                return raced;
            }
            throw error;
        }
    }

    /**
     * FR-22 — request an evaluation, coalescing inside
     * `APP_SPEC_EVALUATE_COALESCE_MS` (5 s).
     *
     * One atomic `UPDATE` (see the class docstring for why it is not a
     * `RETURNING` through TypeORM):
     *
     * ```sql
     * UPDATE work_app_spec_states
     *    SET "requestedSeq" = "requestedSeq" + 1,
     *        "dispatchedAt" = CASE
     *            WHEN "startedSeq" < "requestedSeq"   -- the incremented one, see below
     *             AND "dispatchedAt" IS NOT NULL
     *             AND "dispatchedAt" >= :coalesceFrom
     *            THEN "dispatchedAt"   -- a dispatched job has not started: coalesce
     *            ELSE :stamp           -- no job is waiting: stamp and dispatch
     *        END
     *  WHERE "workId" = :workId
     * ```
     *
     * **The `startedSeq < requestedSeq - 1` condition of plan §2.3:189-192, read
     * as the plan writes it.** The plan states the increment and the condition
     * in one sentence — "One `UPDATE … RETURNING` increments `requestedSeq`
     * and, when a dispatched job has not started (`startedSeq < requestedSeq -
     * 1`) …" — so the parenthesised condition describes the row **after** the
     * increment. `CONTRACTS`' own docstring for `APP_SPEC_EVALUATE_COALESCE_MS`
     * fixes the reading beyond doubt: "A second trigger inside this window whose
     * job has not started does not dispatch a second job; the waiting job reads
     * the newest `requestedSeq` when it starts."
     * `"startedSeq" < "requestedSeq"` over the pre-update row values is exactly
     * `startedSeq < requestedSeqAfterIncrement - 1`; evaluated the other way
     * (against the pre-increment value) the second trigger would dispatch a
     * second job, and the 5 s window would only ever coalesce the third.
     *
     * `requestedSeq` is incremented on **both** branches: the row stays pending
     * (`evaluatedSeq < requestedSeq`) and the job that eventually starts reads
     * the newest sequence, so a coalesced request is never lost — it is
     * satisfied by the evaluation already on its way.
     *
     * The outcome is read back **inside the same transaction** (class
     * docstring), and `dispatched` is decided by SQL comparing the stored
     * `dispatchedAt` with the stamp this statement wrote.
     */
    async requestEvaluation(
        workId: string,
        nowMs: number = Date.now(),
    ): Promise<EvaluationRequestOutcome> {
        const stamp = new Date(nowMs);
        const coalesceFrom = new Date(nowMs - APP_SPEC_EVALUATE_COALESCE_MS);

        return serializeOnSingleConnection(this.repository.manager, () =>
            this.repository.manager.transaction(async (manager) => {
                await manager
                    .createQueryBuilder()
                    .update(WorkAppSpecState)
                    .set({
                        requestedSeq: () => '"requestedSeq" + 1',
                        dispatchedAt: () =>
                            // `"startedSeq" < "requestedSeq"`: the plan's
                            // `startedSeq < requestedSeq - 1` against the
                            // INCREMENTED requestedSeq — see the docstring.
                            'CASE WHEN "startedSeq" < "requestedSeq"' +
                            ' AND "dispatchedAt" IS NOT NULL' +
                            ' AND "dispatchedAt" >= :coalesceFrom' +
                            ' THEN "dispatchedAt" ELSE :stamp END',
                    })
                    .where('workId = :workId', { workId })
                    .setParameters({ stamp, coalesceFrom })
                    .execute();

                const row = await manager
                    .createQueryBuilder(WorkAppSpecState, 'state')
                    .select('state.requestedSeq', 'requestedSeq')
                    .addSelect('state.evaluatedSeq', 'evaluatedSeq')
                    .addSelect(
                        'CASE WHEN state.dispatchedAt >= :stamp THEN 1 ELSE 0 END',
                        'dispatched',
                    )
                    .where('state.workId = :workId', { workId })
                    .setParameter('stamp', stamp)
                    .getRawOne<{
                        requestedSeq: string | number;
                        evaluatedSeq: string | number;
                        dispatched: string | number;
                    }>();

                if (!row) {
                    // No row: the App Work was deleted and the FK cascade took
                    // its state with it. Nothing was requested and nothing may
                    // be dispatched.
                    return {
                        requested: false,
                        dispatched: false,
                        requestedSeq: 0,
                        evaluatedSeq: 0,
                    };
                }

                return {
                    requested: true,
                    dispatched: toNumber(row.dispatched) === 1,
                    requestedSeq: toNumber(row.requestedSeq),
                    evaluatedSeq: toNumber(row.evaluatedSeq),
                };
            }),
        );
    }

    /**
     * `startedSeq = requestedSeq` — the job claiming the row when it starts
     * (plan §2.3:190-192). Returns the sequence it claimed, or `null` when the
     * App Work's row is gone (the Work was deleted while the job was queued).
     *
     * The value is read back after the statement, so a request that arrived in
     * between is picked up rather than missed: the job always evaluates the
     * **current** head, and the guard that matters is the one
     * {@link writeEvaluation} applies, not the sequence it started with.
     */
    async markStarted(workId: string): Promise<number | null> {
        const result = await this.repository
            .createQueryBuilder()
            .update(WorkAppSpecState)
            .set({ startedSeq: () => '"requestedSeq"' })
            .where('workId = :workId', { workId })
            .execute();

        if ((result.affected ?? 0) === 0) {
            return null;
        }

        const row = await this.findByWorkId(workId);
        return row ? toNumber(row.startedSeq) : null;
    }

    /**
     * Write one evaluation's result, **guarded by `evaluatedSeq < :seq`**.
     *
     * The guard is the ordering rule of plan §2.3:194 ("An older job that loses
     * the race writes nothing"): two evaluations of the same App Work can be in
     * flight at once, and the one that started later may finish first. The
     * statement also advances `evaluatedSeq` to `seq`, which is what makes the
     * next older write fail its guard. ACC-03-12.
     *
     * Returns `true` when this write won, `false` when an equal-or-newer result
     * is already stored (or the row is gone) and nothing was changed.
     */
    async writeEvaluation(
        workId: string,
        seq: number,
        result: AppSpecEvaluationResult,
    ): Promise<boolean> {
        const patch: Partial<WorkAppSpecState> = {
            evaluatedSeq: seq,
            lastEvaluationTrigger: result.trigger,
            headCommitSha: result.headCommitSha,
            headSpecHash: result.headSpecHash,
            validationStatus: result.validationStatus,
            errorCount: result.errorCount,
            warningCount: result.warningCount,
            issues: result.issues ?? null,
            lastEvaluatedAt: result.evaluatedAt ?? new Date(),
        };

        if (result.issuesTruncated !== undefined) {
            patch.issuesTruncated = result.issuesTruncated;
        }
        if (result.lastEvaluationError !== undefined) {
            patch.lastEvaluationError = result.lastEvaluationError;
        }
        // ACC-03-10 — the effective spec moves only when the evaluator says so:
        // an invalid or unreadable head keeps the last valid commit's spec.
        if (result.effectiveCommitSha !== undefined) {
            patch.effectiveCommitSha = result.effectiveCommitSha;
        }
        if (result.effectiveSpecHash !== undefined) {
            patch.effectiveSpecHash = result.effectiveSpecHash;
        }
        if (result.effectiveSpec !== undefined) {
            patch.effectiveSpec = result.effectiveSpec;
        }
        if (result.effectiveAt !== undefined) {
            patch.effectiveAt = result.effectiveAt;
        }
        // FR-16 — the tracked-branch move happens on the same guarded write, so
        // a losing job cannot move the branch its winner read.
        if (result.trackedBranch !== undefined && result.trackedBranch !== null) {
            patch.trackedBranch = result.trackedBranch;
        }

        return this.applyGuardedWrite(workId, 'evaluatedSeq', seq, patch);
    }

    /**
     * Write one licence evaluation's result, guarded by
     * `licenseEvaluatedSeq < :seq` — the same ordering rule as
     * {@link writeEvaluation}, on the licence pair (plan §6.3:673-674).
     */
    async writeLicense(
        workId: string,
        seq: number,
        result: AppLicenseEvaluationResult,
    ): Promise<boolean> {
        const patch: Partial<WorkAppSpecState> = {
            licenseEvaluatedSeq: seq,
            licenseEvaluatedAt: result.evaluatedAt ?? new Date(),
        };

        for (const field of [
            'licenseSpdx',
            'licenseClass',
            'licenseSource',
            'licenseMixed',
            'licenseScanIncomplete',
            'licenseEvidence',
            'licenseObligations',
            'licenseCommitSha',
            'licenseRegistryHash',
            'licenseRegistrySource',
            'attestation',
            'sourceOfferRequired',
        ] as const) {
            if (result[field] !== undefined) {
                // Every one of these is an optional key of the same object, so
                // the assignment is one shape; the cast names that, rather than
                // twelve near-identical branches.
                (patch as Record<string, unknown>)[field] = result[field] ?? null;
            }
        }

        return this.applyGuardedWrite(workId, 'licenseEvaluatedSeq', seq, patch);
    }

    /**
     * FR-82 / plan §2.5 step 0 — persist the Blueprint the request matched and
     * stamp `blueprintMatchedAt`, **once per `(workId, blueprintId,
     * blueprintVersion)`**.
     *
     * The guard is the plan's own statement, verbatim:
     *
     * ```sql
     * UPDATE work_app_spec_states
     *    SET "blueprintId" = :blueprintId, "blueprintVersion" = :version,
     *        "blueprintMatchSource" = :matchSource,
     *        "blueprintApplyStatus" = 'applying',
     *        "blueprintMatchedAt" = :now
     *  WHERE "workId" = :workId
     *    AND NOT ("blueprintId" = :blueprintId
     *             AND "blueprintVersion" = :version
     *             AND "blueprintMatchedAt" IS NOT NULL)
     * ```
     *
     * `true` means "record `app.blueprint.matched` now"; `false` means the row
     * already carries this exact match, so the retried request or the
     * re-dispatch records **nothing new** — and, because the guard is the
     * `WHERE` clause rather than a read-then-write, two concurrent requests
     * cannot both see "not matched yet".
     *
     * A first match for a **new** version still writes (the stored id or
     * version differs), and `blueprintApplyStatus` is set to `applying` in the
     * same statement: plan §2.5 step 0 persists id, version, match source and
     * that status together, and it is what refuses a second apply with
     * `409 applyInProgress` (plan §4.2:570).
     */
    async markBlueprintMatched(
        workId: string,
        blueprintId: string,
        version: string,
        matchSource: BlueprintMatchSource,
        now: Date = new Date(),
    ): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(WorkAppSpecState)
            .set({
                blueprintId,
                blueprintVersion: version,
                blueprintMatchSource: matchSource,
                blueprintApplyStatus: 'applying',
                blueprintMatchedAt: now,
            })
            .where('workId = :workId', { workId })
            .andWhere(
                'NOT ("blueprintId" = :blueprintId' +
                    ' AND "blueprintVersion" = :blueprintVersion' +
                    ' AND "blueprintMatchedAt" IS NOT NULL)',
                { blueprintId, blueprintVersion: version },
            )
            .execute();

        return (result.affected ?? 0) > 0;
    }

    /**
     * Plan §2.5:288 and §6.4:681 — the App Works on one Blueprint whose stored
     * version may be behind the catalog's, for `apps-catalog-refresh` to set
     * `blueprintLatestVersion` and raise the upgrade notice.
     *
     * `blueprintId = :blueprintId` is served by
     * `idx_work_app_spec_states_blueprint`; the semantic comparison is
     * `semver.lt("blueprintVersion", entry.version)` (plan §2.5:288), which no
     * portable SQL expresses, so the index narrows to the rows that carry this
     * Blueprint at some **other** version and the caller applies `semver.lt`.
     * A row is never returned for the version the caller passed.
     */
    async findUpgradeCandidates(
        blueprintId: string,
        version: string,
        limit: number = WORK_APP_SPEC_STATE_SCAN_MAX,
    ): Promise<WorkAppSpecState[]> {
        const take = this.batchSize(limit);
        if (!blueprintId || take === 0) {
            return [];
        }

        return this.repository
            .createQueryBuilder('state')
            .where('state.blueprintId = :blueprintId', { blueprintId })
            .andWhere('state.blueprintVersion IS NOT NULL')
            .andWhere('state.blueprintVersion <> :version', { version })
            .orderBy('state.id', 'ASC')
            .take(take)
            .getMany();
    }

    /**
     * Plan §2.6:315 and §6.4:682 — the App Works classified against a
     * **different licence registry** than the one now in force, for
     * `apps-catalog-refresh` to re-dispatch `app-license-evaluate` with the
     * trigger `registry_changed`.
     *
     * Only rows that already hold a classification are returned
     * (`licenseSpdx IS NOT NULL`): the fan-out re-classifies through the stored
     * SPDX with no Git read unless the evaluation needs a new commit, which is
     * impossible for a Work that was never classified — those are reached by
     * their own first evaluation, not by a registry change. A row whose
     * `licenseRegistryHash` is NULL was classified before the hash was
     * recorded, so it counts as stale.
     */
    async findStaleRegistry(
        hash: string,
        limit: number = WORK_APP_SPEC_STATE_SCAN_MAX,
    ): Promise<WorkAppSpecState[]> {
        const take = this.batchSize(limit);
        if (!hash || take === 0) {
            return [];
        }

        return this.repository
            .createQueryBuilder('state')
            .where('state.licenseSpdx IS NOT NULL')
            .andWhere('(state.licenseRegistryHash IS NULL OR state.licenseRegistryHash <> :hash)', {
                hash,
            })
            .orderBy('state.id', 'ASC')
            .take(take)
            .getMany();
    }

    /**
     * The shared body of the two guarded result writes: one conditional
     * `UPDATE … WHERE "workId" = :workId AND "<seqColumn>" < :seq`.
     */
    private async applyGuardedWrite(
        workId: string,
        seqColumn: 'evaluatedSeq' | 'licenseEvaluatedSeq',
        seq: number,
        patch: Partial<WorkAppSpecState>,
    ): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(WorkAppSpecState)
            .set(patch)
            .where('workId = :workId', { workId })
            .andWhere(`${seqColumn} < :seq`, { seq })
            .execute();

        return (result.affected ?? 0) > 0;
    }

    /** The clamped batch size — never more than {@link WORK_APP_SPEC_STATE_SCAN_MAX}. */
    private batchSize(limit: number): number {
        if (!Number.isFinite(limit)) {
            return WORK_APP_SPEC_STATE_SCAN_MAX;
        }
        return Math.max(0, Math.min(Math.floor(limit), WORK_APP_SPEC_STATE_SCAN_MAX));
    }
}

/**
 * A `bigint` column comes back as a string from some drivers (Postgres' `pg`
 * returns `int8` as text) and as a number from others (better-sqlite3). Every
 * caller of this repository reads a sequence as a `number`.
 */
function toNumber(value: string | number | null | undefined): number {
    if (value === null || value === undefined) {
        return 0;
    }
    return typeof value === 'number' ? value : Number(value);
}
