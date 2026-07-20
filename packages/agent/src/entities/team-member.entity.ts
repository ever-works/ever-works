import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Teams & Prebuilt Companies — `docs/specs/features/teams-and-companies/spec.md` §2.2.
 *
 * Polymorphic roster row: one Agent OR one human User inside one Team
 * (mirrors the `TaskAssignee.actorType` pattern). An agent/user may sit in
 * several Teams — membership is an edge, not a column on the member.
 *
 * `role` is DISPLAY-ONLY in v1 — explicitly not an authorization input, so
 * it does not pre-empt the deferred per-Org-roles product decision (see
 * organization-membership.service.ts).
 */

export type TeamMemberType = 'agent' | 'user';

export type TeamMemberRole = 'lead' | 'member';

@Entity({ name: 'team_members' })
@Index('uq_team_members_team_member', ['teamId', 'memberType', 'memberId'], { unique: true })
@Index('idx_team_members_member', ['memberType', 'memberId'])
export class TeamMember {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** FK to `teams.id` (ON DELETE CASCADE by migration). Raw column. */
    @Column({ type: 'uuid' })
    teamId: string;

    @Column({ type: 'varchar', length: 16 })
    memberType: TeamMemberType;

    /** `agents.id` or `users.id` depending on `memberType`; service-validated. */
    @Column({ type: 'uuid' })
    memberId: string;

    @Column({ type: 'varchar', length: 16, default: 'member' })
    role: TeamMemberRole;

    @Column({ type: 'uuid', nullable: true })
    addedById?: string | null;

    // Tier C denormalized scope FKs (EW-657) — auto-stamped on insert.
    // No @ManyToOne — cycle-avoidance, see user.entity.ts EW-654 comment.
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;
}
