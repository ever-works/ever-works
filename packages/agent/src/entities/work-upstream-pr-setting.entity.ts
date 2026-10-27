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
import { Work } from './work.entity';
import { ClassToObject } from './types';
import { PortableDateColumn } from './_types';

/**
 * APW-09 (plan §3.1A, G07 / FR-48) — the in-flight state of one App Work's
 * **Upstream pull requests** toggle.
 *
 * The App spec (`upstreamPullRequests.enabled`) stays the source of truth (D3): this row
 * records what the member ASKED for, who asked, the App spec change that carries it
 * (branch, setup pull request) and the value read back once it merged — so the toggle can
 * say **"Waiting for the App spec change to merge."** across a reload, and a refusal is
 * recorded by name (`settingWriteUnavailable`) rather than lost.
 *
 * One row per App Work (`uq_wups_work`); `workId → works(id)` ON DELETE CASCADE. Migration
 * `1792090200000-CreateWorkUpstreamPrSettings`. Scope columns are plain uuids (EW-655).
 */
@Entity({ name: 'work_upstream_pr_settings' })
@Index('uq_wups_work', ['workId'], { unique: true })
export class WorkUpstreamPrSetting {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    workId: string;

    @ManyToOne(() => Work, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'workId' })
    work?: ClassToObject<Work>;

    /** The value the member asked for. */
    @Column({ type: 'boolean' })
    requestedEnabled: boolean;

    @Column({ type: 'uuid' })
    requestedById: string;

    @PortableDateColumn()
    requestedAt: Date;

    /** The platform-authored App spec change: branch, setup pull request number and link. */
    @Column({ type: 'varchar', length: 255, nullable: true })
    changeBranch?: string | null;

    @Column({ type: 'int', nullable: true })
    changeNumber?: number | null;

    @Column({ type: 'varchar', length: 512, nullable: true })
    changeUrl?: string | null;

    /** The value read back from the effective App spec once the change merged. */
    @Column({ type: 'boolean', nullable: true })
    appliedValue?: boolean | null;

    @PortableDateColumn({ nullable: true })
    appliedAt?: Date | null;

    /** Named refusal when no write path was available (FR-48). */
    @Column({ type: 'varchar', length: 32, nullable: true })
    refusalCode?: string | null;

    @Column({ type: 'varchar', length: 500, nullable: true })
    refusalDetail?: string | null;

    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
