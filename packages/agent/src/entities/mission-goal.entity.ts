import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
} from 'typeorm';
import { Goal } from './goal.entity';
import { Mission } from './mission.entity';
import { User } from './user.entity';

/**
 * Mission ↔ Goal join table (Goals & Metrics spec FR-11, PR-8).
 *
 * Goals are created standalone (owned by `userId`) and attached to
 * Missions through this edge — mirroring the `mission_attachments`
 * edge-table shape. A Goal can be attached to multiple Missions and a
 * Mission can carry multiple Goals; the `(missionId, goalId)` pair is
 * unique.
 *
 * `isPrimary` — at most ONE primary Goal per Mission (spec FR-11).
 * Enforced twice:
 *   - Postgres: partial unique index `uq_mission_goals_primary` on
 *     `(missionId) WHERE "isPrimary" = true` (migration
 *     1782100000000-CreateGoalsTables).
 *   - Service layer (`GoalsService.linkToMission`) demotes any other
 *     primary in the same write — the only enforcement on SQLite,
 *     which the test driver uses (synchronize skips partial indexes).
 *
 * `userId` is denormalized onto the edge (owner of both sides — the
 * service validates Mission AND Goal ownership before insert) so
 * user-scoped cleanups and audits don't need a join.
 *
 * Both FKs CASCADE: deleting either side removes the link, never the
 * other side. Invariant I-4 still applies transitively — nothing on
 * this edge lets Goal evaluation touch the Mission's status.
 */
@Entity({ name: 'mission_goals' })
@Index('uq_mission_goals_mission_goal', ['missionId', 'goalId'], { unique: true })
@Index('idx_mission_goals_goal', ['goalId'])
export class MissionGoal {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column('uuid')
    missionId: string;

    @ManyToOne(() => Mission, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'missionId' })
    mission?: Mission;

    @Column('uuid')
    goalId: string;

    @ManyToOne(() => Goal, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'goalId' })
    goal?: Goal;

    @Column('uuid')
    userId: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user?: User;

    @Column({ type: 'boolean', default: false })
    isPrimary: boolean;

    // Tier A scope columns (EW-655 pattern) — nullable, no @ManyToOne
    // (entities import-cycle rule; see mission.entity.ts).
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;
}
