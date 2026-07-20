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
import { User } from './user.entity';

/**
 * Teams & Prebuilt Companies — `docs/specs/features/teams-and-companies/spec.md` §2.1.
 *
 * A Team is an OPTIONAL, named grouping of Agents and human members inside
 * exactly one Organization (the `TEAM.md` entity of the open agentcompanies/v1
 * spec). Teams nest via `parentTeamId` — hierarchy lives strictly *inside* an
 * Organization, never between Organizations (tenants-and-organizations
 * decision #4, "no nested Organizations", stays intact).
 *
 * Rosters live in `team_members` (polymorphic agent|user edge rows) — never
 * as columns on Agent/User. Deleting a Team cascades its roster rows;
 * child teams are re-parented by the service, not the DB.
 */

/** Provenance stamped by the company-template importer (spec §6.2). */
export interface TeamMetadata {
    source?: {
        repo: string;
        path: string;
        slug: string;
        contentHash?: string;
    };
    [key: string]: unknown;
}

@Entity({ name: 'teams' })
@Index('uq_teams_org_slug', ['organizationId', 'slug'], { unique: true })
@Index('idx_teams_user', ['userId'])
@Index('idx_teams_parent', ['parentTeamId'])
export class Team {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** Creator/owner (house pattern — every business row traces to a user). */
    @Column({ type: 'uuid' })
    userId: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user?: User;

    @Column({ type: 'varchar', length: 200 })
    name: string;

    /** Kebab-case; unique per Organization (see composite index). */
    @Column({ type: 'varchar', length: 100 })
    slug: string;

    @Column({ type: 'text', nullable: true })
    description?: string | null;

    /**
     * Self-reference for team-in-team hierarchy. Raw column (no @ManyToOne —
     * self-refs follow the same raw-column discipline as scope refs); FK with
     * ON DELETE SET NULL added by migration. Acyclicity + max depth are
     * service-enforced (`TeamsService.assertValidParent`).
     */
    @Column({ type: 'uuid', nullable: true })
    parentTeamId?: string | null;

    /**
     * The team's manager Agent (mirrors TEAM.md `manager:`). Raw column,
     * FK ON DELETE SET NULL by migration. Descriptive — carries no authz.
     */
    @Column({ type: 'uuid', nullable: true })
    managerAgentId?: string | null;

    /** Kebab-case lucide icon id (same convention as agent templates). */
    @Column({ type: 'varchar', length: 64, nullable: true })
    avatarIcon?: string | null;

    @Column('simple-json', { nullable: true })
    metadata?: TeamMetadata | null;

    // Tier A scope FKs (EW-651/EW-655 convention) — auto-stamped by
    // ScopeStampingSubscriber on insert. No @ManyToOne to avoid the
    // entities import cycle — see user.entity.ts EW-654 comment.
    // `organizationId` is NULL-able at the column level per tier convention
    // but REQUIRED by TeamsService (Teams are org-scoped in v1, spec §1.1).
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
