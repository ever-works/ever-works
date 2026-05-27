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
 */
@Entity({ name: 'work_deployments' })
@Index(['workId', 'environment', 'createdAt'])
@Index(['workId', 'prNumber'])
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

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;

    isTerminal(): boolean {
        return ['READY', 'ERROR', 'CANCELED', 'TIMEOUT'].includes(this.state);
    }

    isPreview(): boolean {
        return this.environment === DeploymentEnvironment.PREVIEW;
    }
}
