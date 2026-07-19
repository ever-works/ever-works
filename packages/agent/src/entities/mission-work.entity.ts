import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from './user.entity';
import { Mission } from './mission.entity';
import { Work } from './work.entity';

/**
 * How a Mission relates to a Work (domain-model review §8.1/§23 —
 * "Mission N ─── N Works", typed):
 *
 *   - `created`    — the Mission's Idea pipeline produced this Work
 *                    (backfilled from the Mission → Idea → Work chain;
 *                    stamped by the build path going forward).
 *   - `improves`   — the Mission works on an existing Work (features,
 *                    conversion, hardening, …).
 *   - `operates`   — the Mission runs/maintains the Work.
 *   - `markets`    — the Mission promotes the Work.
 *   - `researches` — the Mission studies the Work or its market.
 *   - `retires`    — the Mission winds the Work down.
 */
export type MissionWorkRelation =
    | 'created'
    | 'improves'
    | 'operates'
    | 'markets'
    | 'researches'
    | 'retires';

export const MISSION_WORK_RELATIONS: readonly MissionWorkRelation[] = [
    'created',
    'improves',
    'operates',
    'markets',
    'researches',
    'retires',
];

/**
 * Mission↔Work relation — the explicit M:N edge that replaces the
 * fragile transitive chain (`Mission ← WorkProposal.missionId` +
 * `WorkProposal.acceptedWorkId`) as the way Missions reference Works.
 *
 * Domain invariants (review §13 I-6/I-7, non-negotiable):
 *   - Missions NEVER own Works. Deleting a Mission deletes these rows
 *     (CASCADE) and never touches the Work; completing a Mission
 *     touches nothing here.
 *   - One Mission ↔ many Works, one Work ↔ many Missions over its
 *     lifetime; the same pair may carry several relation kinds
 *     (unique on (missionId, workId, relation)).
 *   - Both endpoints must belong to the same user (service-enforced,
 *     same-owner contract as the accept path).
 */
@Entity({ name: 'mission_works' })
@Index('uq_mission_work_relation', ['missionId', 'workId', 'relation'], { unique: true })
@Index('idx_mission_works_work', ['workId'])
export class MissionWork {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column('uuid')
    missionId: string;

    @ManyToOne(() => Mission, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'missionId' })
    mission?: Mission;

    @Column('uuid')
    workId: string;

    @ManyToOne(() => Work, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'workId' })
    work?: Work;

    @Column('uuid')
    userId: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user?: User;

    @Column({ type: 'varchar', length: 16 })
    relation: MissionWorkRelation;

    // EW-655 Tier C — denormalized scope columns, stamped by the
    // ScopeStampingSubscriber on insert when a scope is active.
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;
}
