import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    ManyToOne,
    CreateDateColumn,
    UpdateDateColumn,
    Index,
    JoinColumn,
} from 'typeorm';
import { Work } from './work.entity';
import { ClassToObject } from './types';
import { TimestampColumn } from './_types';

export enum DeploymentEnvironment {
    PRODUCTION = 'production',
    PREVIEW = 'preview',
}

export enum DeploymentTriggerSource {
    MANUAL = 'manual',
    SCHEDULED = 'scheduled',
}

/**
 * History row for each deploy of a work. The latest production row mirrors
 * Work.deploymentState/website (kept as denormalized cache for backwards
 * compatibility). Preview rows back the per-PR preview UX and rollback.
 *
 * ## APW-06 T16 — the six App columns (plan §7.1)
 *
 * Every one is **nullable with no default**, and no pre-existing column is
 * touched: a website Deployment writes none of them and reads exactly as it did
 * before. That is the whole shape of this change — an App Work's Deployment is
 * the same row with six more facts on it, not a second table.
 *
 * `appTrigger` is the one the plan's §7.1 TABLE does not list, while §7.1:1036
 * and this branch's own services both name it. It is here because without it the
 * FR-23 source is not persisted at all: `AppDeployRequestService` echoes it to
 * the caller, `AppDeployOrchestrator` reads it off the row
 * (`app-deploy.orchestrator.ts:464`), and the history list has no other way to
 * say WHY a Deployment ran. `triggerSource` cannot carry it — it is a
 * two-value enum (`manual` · `scheduled`) that other kinds depend on.
 *
 * ## Four new states, and why `isTerminal` had to learn two of them
 *
 * `DEPLOYING` and `VERIFYING` are in-flight. `ROLLED_BACK` and `SUPERSEDED` are
 * ENDINGS: a row that was rolled back or replaced in the latest-wins queue will
 * never change again. Leaving them out of `isTerminal()` would have left both
 * polling forever and holding a deploy lock that nothing releases.
 */
@Entity({ name: 'work_deployments' })
@Index(['workId', 'environment', 'createdAt'])
@Index(['workId', 'prNumber'])
// APW-06 §7.1: the Build a Deployment ran, looked up by Build ("was this Build
// ever deployed, and where"). No FK — deliberately, so APW-05's `work_builds`
// and this table can merge in either order; the id is validated in code.
@Index(['buildId'])
export class WorkDeployment {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    workId: string;

    @ManyToOne(() => Work, (work) => work.deployments, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'workId' })
    work: ClassToObject<Work>;

    @Column({ type: 'varchar', length: 20, default: DeploymentEnvironment.PRODUCTION })
    environment: DeploymentEnvironment;

    @Column()
    provider: string;

    @Column({ type: 'varchar', default: 'main' })
    branch: string;

    @Column({ nullable: true })
    commitSha?: string;

    @Column({ type: 'int', nullable: true })
    prNumber?: number;

    @Column({ nullable: true })
    providerProjectId?: string;

    @Column({ nullable: true })
    providerDeploymentId?: string;

    @Column({ default: 'INITIALIZING' })
    state: string;

    @Column({ nullable: true })
    website?: string;

    @Column({ type: 'text', nullable: true })
    lastError?: string | null;

    @Column({ type: 'varchar', length: 20, default: DeploymentTriggerSource.MANUAL })
    triggerSource: DeploymentTriggerSource;

    @Column({ type: 'uuid', nullable: true })
    triggeredByUserId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    codeUpdateId?: string | null;

    @TimestampColumn({ nullable: true })
    startedAt?: Date;

    @TimestampColumn({ nullable: true })
    completedAt?: Date;

    // EW-655 (Tenants & Organizations Phase 3) — Tier A scope FKs.
    // Both NULL until the owning user creates their first Organization
    // (Phase 6 lazy backfill). FK + index enforced at DB level by
    // migration 1779991006000-AddTenantIdAndOrganizationIdToTierA.
    // No @ManyToOne to avoid the entities import cycle that bit Phase 2 —
    // see user.entity.ts EW-654 comment.
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    /* ---------------------------------------------------------------------- *
     * APW-06 T16 — the App columns (plan §7.1). All nullable, all additive.
     * ---------------------------------------------------------------------- */

    /** `WorkBuild.id` this Deployment ran. `null` under `build.strategy: image`/`none` (§5.8). */
    @Column({ type: 'uuid', nullable: true })
    buildId?: string | null;

    /** `your-cluster` · `ever-works-apps` — which cluster this Deployment went to. */
    @Column({ type: 'varchar', length: 24, nullable: true })
    appTarget?: string | null;

    /**
     * The FR-23 source: `manual` · `build` · `domain-change` · `rollback` ·
     * `target-saved`. See the class docstring for why this is not `triggerSource`.
     */
    @Column({ type: 'varchar', length: 24, nullable: true })
    appTrigger?: string | null;

    /**
     * `[{ name, role, desired, ready, restarts, lastTerminationReason?, oomKilledAt? }]`
     * at the terminal state — what each component actually did.
     */
    @Column({ type: 'simple-json', nullable: true })
    componentStatuses?: Record<string, unknown>[] | null;

    /** `{ inCluster, public, hairpin?, classification?, observedAt }` — §5.5's checks. */
    @Column({ type: 'simple-json', nullable: true })
    smokeResult?: Record<string, unknown> | null;

    /**
     * The render facts: `{ phase, namespace, specCommitSha, envChecksum, jobResults[],
     * warnings[], preconditions[], rollback?, cancelledBy?, supersededBy? }`.
     *
     * **Never a value and never log text** (Constitution VII). Everything here is
     * shown to the owner in the Deploy tab, so a rendered secret or a copied log
     * line would be a leak into a history row that outlives the Deployment.
     */
    @Column({ type: 'simple-json', nullable: true })
    appRender?: Record<string, unknown> | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;

    isTerminal(): boolean {
        // `ROLLED_BACK` and `SUPERSEDED` are APW-06 T16's two new ENDINGS — see
        // the class docstring. The four original values are unchanged.
        return ['READY', 'ERROR', 'CANCELED', 'TIMEOUT', 'ROLLED_BACK', 'SUPERSEDED'].includes(
            this.state,
        );
    }

    isPreview(): boolean {
        return this.environment === DeploymentEnvironment.PREVIEW;
    }
}
