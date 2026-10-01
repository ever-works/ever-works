import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import type {
    AppBlueprintApplyRef,
    AppBlueprintApplyStatus,
    AppBlueprintUpgradePr,
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
import { Work } from './work.entity';
import { ClassToObject } from './types';
import { PortableDateColumn } from './_types';

/**
 * App Works — the App spec state of one App Work (APW-03).
 *
 * Spec: `docs/specs/features/app-works/APW-03-app-spec-and-catalog/spec.md`
 * (FR-17 one state per App Work, FR-20 the effective spec, FR-21 the file link
 * input, FR-22 coalescing, FR-61 the source offer, FR-82 the Blueprint-matched
 * guard). Plan: `…/plan.md` §3.1 (`plan.md:397-452`) is the normative column
 * list — this file implements it column for column, with the three index names
 * the plan fixes at `plan.md:451-452`. Migration:
 * `apps/api/src/migrations/1792030000000-CreateWorkAppSpecStates.ts` (§3.3).
 * Repository: `packages/agent/src/database/repositories/work-app-spec-state.repository.ts`
 * (T11), which owns the coalescing arithmetic these columns exist for.
 *
 * ## One row per App Work
 *
 * `workId` is UNIQUE (`uq_work_app_spec_states_work`): everything the platform
 * knows about one App Work's spec — the head reading, the effective spec, the
 * Blueprint it came from, the licence classification — is ONE row, so two
 * writers cannot leave two half-states behind. The migration's FK is
 * `workId → works(id) ON DELETE CASCADE`: deleting the Work deletes its spec
 * state, because there is nothing left for it to describe.
 *
 * ## The five sequence columns are the coalescing arithmetic
 *
 * `requestedSeq` / `startedSeq` / `evaluatedSeq` (and the licence pair
 * `licenseRequestedSeq` / `licenseEvaluatedSeq`) are incremented and compared
 * **only** inside the repository (plan §2.3:189-194):
 *
 *   - a request bumps `requestedSeq`; the row is *pending* while
 *     `evaluatedSeq < requestedSeq` (plan §3.1:409 — that expression is what
 *     the DTO publishes as `evaluationPending`, `work-app-spec.dto.ts:261-262`);
 *   - a job stamps `startedSeq = requestedSeq` when it starts and therefore
 *     reads the newest request, never the one its dispatch was raised for;
 *   - a finishing job writes with `WHERE "evaluatedSeq" < :seq`, so an older
 *     job that loses the race writes **nothing** and the newer result stays
 *     (ACC-03-12).
 *
 * They are `bigint`, exactly as the plan's table declares them, and nothing
 * outside the repository should read them: `work-app-spec.dto.ts:18-25`
 * records the same rule for the DTO.
 *
 * ## Closed sets come from `@ever-works/contracts`
 *
 * `validationStatus`, `lastEvaluationTrigger`, `blueprintMatchSource`,
 * `blueprintApplyStatus`, `licenseClass`, `licenseSource` and
 * `licenseRegistrySource` are typed by the contracts unions
 * (`APP_SPEC_VALIDATION_STATUSES`, `APP_SPEC_EVALUATION_TRIGGERS`,
 * `BLUEPRINT_MATCH_SOURCES`, `APP_BLUEPRINT_APPLY_STATUSES`, `LICENSE_CLASSES`,
 * `LICENSE_SOURCES`, `LICENSE_REGISTRY_SOURCES`), and the four composite
 * columns by the contracts interfaces the DTO already mirrors
 * (`AppBlueprintApplyRef`, `AppBlueprintUpgradePr`, `AppLicenseEvidence`,
 * `LicenseAttestation`) — so a value the API can render is a value the column
 * can hold. `lastEvaluationError` / `blueprintApplyError` stay deliberately
 * plain varchars: their sets are reason codes opened by the owning service.
 *
 * ## Every date is a `PortableDateColumn`
 *
 * Plan §3.1:399-401 says so in as many words. `better-sqlite3` — the default
 * `DATABASE_TYPE`, the CI driver and the e2e stack — rejects a raw
 * `type: 'timestamp'` at BOOT, not at query time, and
 * `entities/__tests__/portable-date-columns.spec.ts` fails the build on one.
 * The reflected `Date` lets TypeORM pick each dialect's own spelling. (Plan
 * §3.1's table spells these `timestamptz`; the same section's preamble and the
 * boot guard are why the *entity* says `Date` and the migration says
 * `timestamp` — see the migration's docstring.)
 *
 * ## Scope columns, and why they carry no relation
 *
 * `tenantId` / `organizationId` are plain nullable uuids with no `@ManyToOne`,
 * for the reason `WorkDeployment` records (`_types.ts`, EW-654/EW-655): a
 * relation here drags the Tenant/Organization entity graph into the decorator
 * evaluation of the whole inventory and re-creates the import cycle that bit
 * Phase 2 — the same note `skill-tag.entity.ts:52-53` and
 * `work-upstream-state.entity.ts:59-67` carry.
 *
 * ## `effectiveSpec` is a cache, never the authority
 *
 * Plan §3.1:419: the file at `effectiveCommitSha` is authoritative and this
 * column is rebuilt from it when absent. It holds no secret values (R8).
 *
 * ## R-25 (workspace backup)
 *
 * Exported as `data/works/app-spec-states.jsonl`, reached through the parent
 * Work ids; the three `*Hash` columns are benign digests (plan §3:395).
 */
@Entity({ name: 'work_app_spec_states' })
@Index('uq_work_app_spec_states_work', ['workId'], { unique: true })
@Index('idx_work_app_spec_states_blueprint', ['blueprintId', 'blueprintVersion'])
@Index('idx_work_app_spec_states_registry', ['licenseRegistryHash'])
export class WorkAppSpecState {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** The App Work this row describes. One row per Work — see the class docstring. */
    @Column({ type: 'uuid' })
    workId: string;

    @ManyToOne(() => Work, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'workId' })
    work?: ClassToObject<Work>;

    // EW-655 (Tenants & Organizations Phase 3) — Tier A scope stamps, plain
    // columns with no relation (see the class docstring).
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    /**
     * The branch whose head is evaluated (FR-16). Moved by the evaluation job
     * when a valid head declares a different `source.branch`; defaulted from
     * the Work Repository's default branch at `initialize`.
     */
    @Column({ type: 'varchar', length: 255 })
    trackedBranch: string;

    /** How many evaluations have been requested. Pending ⇔ `evaluatedSeq < requestedSeq`. */
    @Column({ type: 'bigint', default: 0 })
    requestedSeq: number;

    /** The `requestedSeq` the running job claimed when it started (plan §2.3:190-192). */
    @Column({ type: 'bigint', default: 0 })
    startedSeq: number;

    /** The highest `requestedSeq` whose result has been written. */
    @Column({ type: 'bigint', default: 0 })
    evaluatedSeq: number;

    /** When an evaluation was last dispatched; the 5 s coalescing window reads it (FR-22). */
    @PortableDateColumn({ nullable: true })
    dispatchedAt?: Date | null;

    /** The tracked branch's head commit as the last evaluation read it. */
    @Column({ type: 'varchar', length: 40, nullable: true })
    headCommitSha?: string | null;

    /** sha256 of the canonical JSON of the head `spec` (sorted keys, no whitespace). */
    @Column({ type: 'varchar', length: 64, nullable: true })
    headSpecHash?: string | null;

    /**
     * `valid` · `valid_with_warnings` · `invalid` · `missing` · `unreadable`
     * (`APP_SPEC_VALIDATION_STATUSES`, plan §3.1:413). Defaults to `missing`:
     * the row APW-01 creates exists before anything has been read.
     */
    @Column({ type: 'varchar', length: 24, default: 'missing' })
    validationStatus: AppSpecValidationStatus;

    /** `AppSpecIssue[]`, capped at `APP_SPEC_MAX_ISSUES` (200) by the evaluator. */
    @Column({ type: 'simple-json', nullable: true })
    issues?: AppSpecIssue[] | null;

    @Column({ type: 'int', default: 0 })
    errorCount: number;

    @Column({ type: 'int', default: 0 })
    warningCount: number;

    /** `true` when the issue cap was reached (schema.md §2.5). */
    @Column({ type: 'boolean', default: false })
    issuesTruncated: boolean;

    /** The commit of the last evaluation with zero errors (FR-20). */
    @Column({ type: 'varchar', length: 40, nullable: true })
    effectiveCommitSha?: string | null;

    @Column({ type: 'varchar', length: 64, nullable: true })
    effectiveSpecHash?: string | null;

    /**
     * **Cache** of the spec at `effectiveCommitSha`; the file at that commit is
     * authoritative and the cache is rebuilt from it when absent. Holds no
     * secret values (R8).
     */
    @Column({ type: 'simple-json', nullable: true })
    effectiveSpec?: AppSpec | null;

    @PortableDateColumn({ nullable: true })
    effectiveAt?: Date | null;

    @PortableDateColumn({ nullable: true })
    lastEvaluatedAt?: Date | null;

    /**
     * `created` · `push` · `pr_merged` · `manual` · `lazy` · `blueprint_applied`
     * · `build` (`APP_SPEC_EVALUATION_TRIGGERS`, plan §3.1:422).
     */
    @Column({ type: 'varchar', length: 24, nullable: true })
    lastEvaluationTrigger?: AppSpecEvaluationTrigger | null;

    /** The provider error code for `unreadable` (plan §9.2). */
    @Column({ type: 'varchar', length: 64, nullable: true })
    lastEvaluationError?: string | null;

    // ── Blueprint (plan §2.5, §3.1:424-432) ────────────────────────────────

    @Column({ type: 'varchar', length: 64, nullable: true })
    blueprintId?: string | null;

    @Column({ type: 'varchar', length: 32, nullable: true })
    blueprintVersion?: string | null;

    @Column({ type: 'varchar', length: 128, nullable: true })
    blueprintRepo?: string | null;

    @Column({ type: 'varchar', length: 40, nullable: true })
    blueprintSha?: string | null;

    /**
     * `manifest` · `alias` · `fork` (the root `source` or the `parent` of the
     * fork network) · `probe` · `explicit` (FR-81) · `file`
     * (`BLUEPRINT_MATCH_SOURCES`, plan §3.1:425).
     */
    @Column({ type: 'varchar', length: 16, nullable: true })
    blueprintMatchSource?: BlueprintMatchSource | null;

    /** `applying` · `applied` · `failed` (`APP_BLUEPRINT_APPLY_STATUSES`, plan §3.1:426). */
    @Column({ type: 'varchar', length: 16, nullable: true })
    blueprintApplyStatus?: AppBlueprintApplyStatus | null;

    /**
     * When `app.blueprint.matched` was recorded for this `blueprintId` +
     * `blueprintVersion`. This column **is** the once-only guard of plan §2.5
     * step 0 (FR-82): the request's `UPDATE … WHERE NOT ("blueprintId" = :id
     * AND "blueprintVersion" = :version AND "blueprintMatchedAt" IS NOT NULL)`
     * writes nothing for a retry or a re-dispatch, so the Activity row is
     * recorded exactly once per (Work, Blueprint, version).
     */
    @PortableDateColumn({ nullable: true })
    blueprintMatchedAt?: Date | null;

    /** The apply's reason code when the job failed. */
    @Column({ type: 'varchar', length: 64, nullable: true })
    blueprintApplyError?: string | null;

    /** `{ kind: 'commit' | 'pull_request', sha?, number?, url }`. */
    @Column({ type: 'simple-json', nullable: true })
    blueprintApplyRef?: AppBlueprintApplyRef | null;

    /** Set by the catalog refresh when a newer Blueprint version exists (FR-50). */
    @Column({ type: 'varchar', length: 32, nullable: true })
    blueprintLatestVersion?: string | null;

    /** The version whose upgrade notice the member dismissed — suppresses that version only. */
    @Column({ type: 'varchar', length: 32, nullable: true })
    blueprintUpgradeDismissedVersion?: string | null;

    /** `{ number, url, version, breaking }` of the open upgrade pull request (FR-51). */
    @Column({ type: 'simple-json', nullable: true })
    blueprintUpgradePr?: AppBlueprintUpgradePr | null;

    // ── Licence (plan §2.6, §3.1:433-449) ──────────────────────────────────

    @Column({ type: 'varchar', length: 200, nullable: true })
    licenseSpdx?: string | null;

    /** `green` · `amber` · `red` · `unknown` (`LICENSE_CLASSES`, R-3). */
    @Column({ type: 'varchar', length: 8, nullable: true })
    licenseClass?: LicenseClass | null;

    /** `detected` · `blueprint` · `user` (`LICENSE_SOURCES`). */
    @Column({ type: 'varchar', length: 16, nullable: true })
    licenseSource?: LicenseSource | null;

    @Column({ type: 'boolean', default: false })
    licenseMixed: boolean;

    /** `true` when the tree read was truncated or the provider has no tree read. */
    @Column({ type: 'boolean', default: false })
    licenseScanIncomplete: boolean;

    /** `{ files, mixedPaths, headerFindings? }`, each path list ≤ 20. */
    @Column({ type: 'simple-json', nullable: true })
    licenseEvidence?: AppLicenseEvidence | null;

    /** The obligations the classified expression carries (e.g. `network-source-offer`). */
    @Column({ type: 'simple-json', nullable: true })
    licenseObligations?: string[] | null;

    @Column({ type: 'varchar', length: 40, nullable: true })
    licenseCommitSha?: string | null;

    /** The registry hash the classification was made against — drives the fan-out. */
    @Column({ type: 'varchar', length: 64, nullable: true })
    licenseRegistryHash?: string | null;

    /** `live` · `last_good` · `snapshot` (`LICENSE_REGISTRY_SOURCES`); a snapshot forces `managed: false`. */
    @Column({ type: 'varchar', length: 16, nullable: true })
    licenseRegistrySource?: LicenseRegistrySource | null;

    /** How many licence evaluations have been requested (the pair of `evaluatedSeq`, for licences). */
    @Column({ type: 'bigint', default: 0 })
    licenseRequestedSeq: number;

    /** The highest licence request whose result has been written. */
    @Column({ type: 'bigint', default: 0 })
    licenseEvaluatedSeq: number;

    @PortableDateColumn({ nullable: true })
    licenseEvaluatedAt?: Date | null;

    /** The single attestation record (C3, R-3); APW-06 stores none of its own. */
    @Column({ type: 'simple-json', nullable: true })
    attestation?: LicenseAttestation | null;

    /** A **display cache** for the License card — eligibility recomputes it on every call. */
    @Column({ type: 'boolean', default: false })
    sourceOfferRequired: boolean;

    /** The Blueprint's display name (FR-63); the App Launcher reads it (APW-11). */
    @Column({ type: 'varchar', length: 80, nullable: true })
    displayName?: string | null;

    @Column({ type: 'varchar', length: 500, nullable: true })
    trademarkNotice?: string | null;

    /** `string[]`, ≤ `APP_SPEC_MAX_PROTECTED_PATHS` (50). */
    @Column({ type: 'simple-json', nullable: true })
    protectedPaths?: string[] | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
