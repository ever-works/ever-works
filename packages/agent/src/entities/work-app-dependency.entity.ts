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
    AppDependencyBackupPolicy,
    AppDependencyBackupState,
    AppDependencyKind,
    AppDependencyStatus,
    AppDependencyStatusDetail,
    AppDependencyTarget,
} from '@ever-works/contracts';
import { Work } from './work.entity';
import { ClassToObject } from './types';
import { TimestampColumn } from './_types';

/**
 * APW-07 (App env & dependencies) — one dependency of one App Work, and the
 * record of what happened to it.
 *
 * Spec: `docs/specs/features/app-works/APW-07-app-env-and-dependencies/spec.md`
 * (FR-35…FR-50, FR-56…FR-63). Plan: `…/plan.md` §3.2 (`plan.md:202-232`) is the
 * normative column list — this file implements it column for column, with the
 * two plain index names the plan fixes at `plan.md:226-227`. Migration:
 * `apps/api/src/migrations/1792070000000-CreateAppEnvAndDependencies.ts` (T7).
 * Repository: `…/database/repositories/work-app-dependency.repository.ts` (T8).
 *
 * ## The partial unique index is NOT declared here (APW07-G12)
 *
 * `uq_work_app_dependencies_active (workId, kind) WHERE status NOT IN ('kept',
 * 'deleted')` lives in the migration as raw SQL: the Postgres form, a SQLite
 * expression-index form and a MySQL/MariaDB generated-column form
 * (`plan.md:333-338`, the convention of
 * `1791220000000-CreateWorkspaceBackups.ts:26-34`). It is deliberately absent
 * from the decorators because TypeORM's `synchronize` — used only by the
 * in-memory SQLite test driver — would otherwise synthesise a NON-partial
 * duplicate that refuses the second `kept` row a released dependency
 * legitimately leaves behind. `workspace_backups` and `work_budgets` record
 * the same reasoning for the same reason.
 *
 * ## Two envelopes, one row
 *
 * `configEncrypted` is what an external provider was configured with (SMTP
 * credentials, S3 keys) and `outputsEncrypted` is every output it produced, as
 * ONE JSON envelope. Both are `NULL` on a managed-tier row — the platform
 * never sees a managed dependency's outputs at all (plan §4.11). Neither is
 * ever selected by a read a UI renders: the repository's per-Work read carries
 * neither column (T8).
 *
 * ## Every timestamp is a `TimestampColumn` (bigint epoch ms)
 *
 * As on `WorkAppEnvValue`, `WorkUpstreamState` and `WorkDeployment`, and as
 * APW-06's APW06-G16 records: better-sqlite3 (the default `DATABASE_TYPE`, CI
 * and the whole e2e stack) has no `timestamp` type, and `provisionLeaseUntil`
 * is compared as a NUMBER by the lease claim of plan §4.8:563-566 — a
 * parameterised `UPDATE … WHERE "provisionLeaseUntil" IS NULL OR
 * "provisionLeaseUntil" < :now`, never `now() + interval` (APW07-G12).
 *
 * ## Closed sets come from `@ever-works/contracts`
 *
 * `kind`, `deployTarget`, `status`, `backupPolicy` and `backupState` are typed
 * by APW-07 T2's unions, so a value the API can render is a value the column
 * can hold; `statusReason` stays a plain 48-character varchar because the
 * reason vocabulary is closed in contracts and widened there first, never by a
 * migration here. `statusDetail` and `resourceRefs` are `simple-json` holding
 * names and numbers only (plan §3.2:211,218).
 *
 * ## Scope columns, and why they carry no relation
 *
 * `tenantId` / `organizationId` are plain nullable uuids with no `@ManyToOne`,
 * for the EW-654/EW-655 cycle-avoidance reason `WorkDeployment` records at
 * `:89-94`.
 *
 * ## R-25 (workspace backup)
 *
 * Exported as `data/works/app-dependencies.jsonl` through the parent Work ids,
 * with `configEncrypted` and `outputsEncrypted` redacted to `{ wasSet }`
 * (`plan.md:174`, T45).
 */
@Entity({ name: 'work_app_dependencies' })
@Index('idx_work_app_dependencies_work', ['workId'])
@Index('idx_work_app_dependencies_status', ['status', 'lastCheckedAt'])
export class WorkAppDependency {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** The App Work whose spec declares this dependency. */
    @Column({ type: 'uuid' })
    workId: string;

    /** One row per (Work, kind) while the row is active — the migration's partial unique index. */
    @ManyToOne(() => Work, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'workId' })
    work?: ClassToObject<Work>;

    /** `postgres` · `redis` · `objectStorage` · `smtp` (`APP_DEPENDENCY_KINDS`, FR-35). */
    @Column({ type: 'varchar', length: 16 })
    kind: AppDependencyKind;

    /** `your-cluster` · `ever-works-apps` (`APP_DEPENDENCY_TARGETS`) — where it was provisioned. */
    @Column({ type: 'varchar', length: 24 })
    deployTarget: AppDependencyTarget;

    /** The plugin that served it (`k8s`, `app-dependencies-external`, …). */
    @Column({ type: 'varchar', length: 64 })
    providerPluginId: string;

    /** The provider id inside that plugin (`k8s-inline-postgres`, `smtp-external`, …). */
    @Column({ type: 'varchar', length: 64 })
    providerId: string;

    /**
     * `pending` · `awaiting_config` · `provisioning` · `ready` · `degraded` ·
     * `failed` · `kept` · `deleting` · `deleted` (`APP_DEPENDENCY_STATUSES`).
     * `kept` and `deleted` are the two the partial unique index excludes.
     */
    @Column({ type: 'varchar', length: 16 })
    status: AppDependencyStatus;

    /**
     * Why the card reads *Failed* / *Degraded* / *Awaiting configuration* — a
     * reason code from the closed vocabulary, never a message (FR-43).
     */
    @Column({ type: 'varchar', length: 48, nullable: true })
    statusReason?: string | null;

    /**
     * Operator-facing detail: names and numbers only, ≤ 2 KB (plan §3.2:211).
     * A definite failure may name the extensions that are missing; a value is
     * never in here.
     */
    @Column({ type: 'simple-json', nullable: true })
    statusDetail?: AppDependencyStatusDetail | null;

    /** Failed and transient attempts so far — FR-43's three before a card reads **Failed**. */
    @Column({ type: 'int', default: 0 })
    attempts: number;

    /** The App spec block this kind was reconciled from (non-secret), so the next spec can be diffed. */
    @Column({ type: 'simple-json' })
    declared: Record<string, unknown>;

    /** The provider's reported version, e.g. `16` for Postgres. */
    @Column({ type: 'varchar', length: 32, nullable: true })
    actualVersion?: string | null;

    /** The volume size in GiB (FR-37, FR-63); `smtp` has none. Never decreased. */
    @Column({ type: 'int', nullable: true })
    sizeGiB?: number | null;

    /** An external provider's configuration, as one envelope. NULL for a managed or in-cluster row. */
    @Column({ type: 'text', nullable: true })
    configEncrypted?: string | null;

    /** Every output as one JSON envelope. Always NULL for an `ever-works-apps` row (plan §3.2:230). */
    @Column({ type: 'text', nullable: true })
    outputsEncrypted?: string | null;

    /**
     * `+1` whenever `outputsEncrypted` changes (plan §7:876), which is what
     * makes a derived env value's `d<outputsVersion>` fingerprint move.
     */
    @Column({ type: 'int', default: 0 })
    outputsVersion: number;

    /**
     * What the provider created, by name (`{ namespace?, objects: [{ kind, name }]
     * ≤ 20, databases?, buckets? }`) — non-secret, and what the delete-data
     * dialog lists after a release (FR-45, FR-46).
     */
    @Column({ type: 'simple-json', nullable: true })
    resourceRefs?: {
        namespace?: string;
        objects: Array<{ kind: string; name: string }>;
        databases?: string[];
        buckets?: string[];
    } | null;

    /** False once the kind left the App spec — the "No longer used" chip (FR-45). */
    @Column({ type: 'boolean', default: true })
    inSpec: boolean;

    /** `none` · `operator` · `provider` · `managed` (`APP_DEPENDENCY_BACKUP_POLICIES`, FR-48). */
    @Column({ type: 'varchar', length: 16 })
    backupPolicy: AppDependencyBackupPolicy;

    /**
     * `none` · `not_configured` · `healthy` · `overdue` · `failing` ·
     * `external` · `unknown` (`APP_DEPENDENCY_BACKUP_STATES`) — what the card's
     * backup line renders. NULL until a provider has reported.
     */
    @Column({ type: 'varchar', length: 16, nullable: true })
    backupState?: AppDependencyBackupState | null;

    /** The last COMPLETED backup the provider reported; the 26-hour overdue line measures from it. */
    @TimestampColumn({ nullable: true })
    lastBackupAt?: Date | null;

    /** When `backupStatus` was last asked — throttles the refresh to once per 15 minutes (FR-42). */
    @TimestampColumn({ nullable: true })
    backupCheckedAt?: Date | null;

    /** When this row last reached `ready`. */
    @TimestampColumn({ nullable: true })
    lastProvisionedAt?: Date | null;

    /** When the provider was last asked for its outputs; an older-than-15-minutes read opens a refresh. */
    @TimestampColumn({ nullable: true })
    lastCheckedAt?: Date | null;

    /**
     * The provisioning lease (plan §4.8:563-566). A job claims it with a
     * parameterised compare-and-set before it calls the provider, so two
     * workers — or two replicas of the same dispatcher — cannot provision one
     * dependency at once.
     */
    @TimestampColumn({ nullable: true })
    provisionLeaseUntil?: Date | null;

    // EW-655 (Tenants & Organizations Phase 3) — Tier A scope FKs, plain
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
