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
import type { AppBuildWebhookState, AppBuildWorkflowState } from '@ever-works/contracts';
import { Work } from './work.entity';
import { ClassToObject } from './types';
import { TimestampColumn } from './_types';

/**
 * App Works — the preparation state of one App Work (APW-05, `APW05-G03`).
 *
 * Spec: `docs/specs/features/app-works/APW-05-builds/spec.md` (FR-8 the
 * workflow write and its read-back, FR-30 the environment re-prepare, §7.7 the
 * webhook install). Plan: `…/plan.md` §3.1b (`plan.md:398-425`) is the
 * normative column list — this file implements it column for column, with the
 * one index the plan fixes at `plan.md:405`. Migration:
 * `apps/api/src/migrations/1792050000000-CreateWorkBuilds.ts` (§3.3).
 * Repository: `packages/agent/src/database/repositories/app-build-preparation.repository.ts`
 * (T6).
 *
 * ## One row per App Work, and it is DERIVED state
 *
 * `workId` is UNIQUE (`uq_work_build_preparations_work`): everything the
 * platform knows about how this App Work's build is set up — the workflow it
 * wrote, the webhook it installed, the run-discovery cursor, the secret sync it
 * last completed — is ONE row. The migration's FK is
 * `workId → works(id) ON DELETE CASCADE`: deleting the Work deletes its
 * preparation state, because there is nothing left for it to describe.
 *
 * Constitution III — derived state has no hand-written API surface: **no API
 * route writes this table** (`plan.md:400-401`, `APW05-G03`), and no
 * build-plugin setting stores any of it. It is written only by
 * `app-build-prepare` (§7.2 step 5) and read by the consumer when it inserts a
 * `push` or `pull-request` Build (§7.5), by the sweep's discovery pass (§7.4a),
 * by the watch job when it first records `startedAt` (§7.3) and by the Builds
 * list response (§5).
 *
 * ## `buildInputsHash` is written even for zero values
 *
 * `plan.md:408`: a sync that wrote nothing still stamps `secretsSyncedAt` and
 * the hash of the EMPTY list — `sha256("")` from `computeBuildInputsHash([])`,
 * the known-answer value in `packages/contracts/src/apps/builds.ts`. NULL means
 * "no sync has ever completed", which is a different fact from "a sync
 * completed and there was nothing to write", and §5.1's `staleInputs` clause
 * depends on the difference.
 *
 * ## Closed sets come from `@ever-works/contracts`
 *
 * `workflowState` and `webhookState` are typed by `APP_BUILD_WORKFLOW_STATES`
 * and `APP_BUILD_WEBHOOK_STATES` (`packages/contracts/src/apps/builds.ts`), so
 * a state the API can render is a state the column can hold. `repositoryBlock`
 * is the `{ reason, detail, at }` bag of §4.6 step 6 — a reason code plus
 * names and numbers, never a token.
 *
 * ## Every timestamp is a `TimestampColumn` (bigint epoch ms)
 *
 * The same reason `WorkUpstreamState` records: a raw `Date` column is
 * `timestamptz` on Postgres and `datetime` on SQLite, while the discovery
 * pass's ordering predicate is the numeric `runsCheckedAt` (`plan.md:415`,
 * §7.4a). `entities/__tests__/portable-date-columns.spec.ts` fails the build on
 * a raw `timestamp` for the same reason, one bug class earlier.
 *
 * ## Scope columns, and why they carry no relation
 *
 * `tenantId` / `organizationId` are plain nullable uuids with no `@ManyToOne`
 * (EW-654/EW-655): a relation here drags the Tenant/Organization entity graph
 * into the decorator evaluation of the whole inventory.
 *
 * ## R-25 (workspace backup)
 *
 * Exported as `data/works/build-preparations.jsonl` (T45). No column holds a
 * secret value: `buildSecretNames` is names, `repositoryBlock` is a reason code,
 * and the two hashes are digests (`plan.md:865-866`).
 */
@Entity({ name: 'work_build_preparations' })
@Index('uq_work_build_preparations_work', ['workId'], { unique: true })
export class WorkBuildPreparation {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** The App Work this row describes. One row per Work — see the class docstring. */
    @Column({ type: 'uuid' })
    workId: string;

    @ManyToOne(() => Work, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'workId' })
    work?: ClassToObject<Work>;

    /** The build plugin this App Work resolves to; the row is per Work, not per plugin. */
    @Column({ type: 'varchar', length: 64 })
    buildPluginId: string;

    /** sha256 over (name, fingerprint) of the last completed secret sync (§4.7). */
    @Column({ type: 'varchar', length: 64, nullable: true })
    buildInputsHash?: string | null;

    /** When that sync finished; written even with 0 values (see the class docstring). */
    @TimestampColumn({ nullable: true })
    secretsSyncedAt?: Date | null;

    /** `EW_` names the platform wrote and has not removed (≤ 50). Names only. */
    @Column({ type: 'simple-json', nullable: true })
    buildSecretNames?: string[] | null;

    /** Set only after a matching read-back (FR-8) — before that, absence is the fact. */
    @Column({ type: 'varchar', length: 64, nullable: true })
    workflowSha256?: string | null;

    /** `none` · `committed` · `pullRequestOpen` · `editedByHand`. */
    @Column({ type: 'varchar', length: 24, default: 'none' })
    workflowState: AppBuildWorkflowState;

    @Column({ type: 'int', nullable: true })
    workflowPullRequestNumber?: number | null;

    @Column({ type: 'varchar', length: 512, nullable: true })
    workflowPullRequestUrl?: string | null;

    /** When a prepare first wrote or committed the workflow — the discovery floor (§7.4a). */
    @TimestampColumn({ nullable: true })
    workflowWrittenAt?: Date | null;

    @Column({ type: 'varchar', length: 64, nullable: true })
    webhookId?: string | null;

    /** `none` · `installed` · `skipped` · `permissionMissing` (§7.7). */
    @Column({ type: 'varchar', length: 24, default: 'none' })
    webhookState: AppBuildWebhookState;

    /** The run-discovery cursor's ETag; `notModified` only stamps `runsCheckedAt` (§7.4a). */
    @Column({ type: 'varchar', length: 128, nullable: true })
    runsEtag?: string | null;

    @TimestampColumn({ nullable: true })
    runsCheckedAt?: Date | null;

    /** `{ reason, detail, at }` — a repository-level block such as `actionsDisabled` (§4.6). */
    @Column({ type: 'simple-json', nullable: true })
    repositoryBlock?: Record<string, unknown> | null;

    /** Bumped by every `requestPrepare` — the coalescing marker of §7.2. */
    @Column({ type: 'int', default: 0 })
    prepareSeq: number;

    @TimestampColumn({ nullable: true })
    lastPreparedAt?: Date | null;

    // EW-655 (Tenants & Organizations Phase 3) — Tier A scope stamps, plain
    // columns with no relation (see the class docstring).
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
