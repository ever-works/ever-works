import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { PortableDateColumn } from './_types';

/**
 * Teams & Prebuilt Companies — Team ↔ resource association
 * (operator ask "some Works belong to some Teams").
 *
 * A polymorphic edge row: one Work / Task / Agent / Mission / Idea attached
 * to one Team (mirrors the `TeamMember.memberType` and `TaskAssignee.actorType`
 * patterns). A resource may sit in several Teams — the attachment is an edge,
 * never a column on the resource, so nothing on the Work/Agent/… side changes.
 *
 * `resourceType` discriminates which table `resourceId` points at:
 *   - `work`    → `works.id`
 *   - `task`    → `tasks.id`
 *   - `agent`   → `agents.id`
 *   - `mission` → `missions.id`
 *   - `idea`    → `work_proposals.id`
 *
 * There is deliberately NO `@ManyToOne` to any scope/resource entity — the
 * polymorphic `resourceId` cannot be a single FK, and the scope columns
 * follow the same raw-column discipline as the rest of the Tier C family
 * (cycle-avoidance, see user.entity.ts EW-654 comment). Referential
 * integrity for `teamId` is a real FK (ON DELETE CASCADE, migration);
 * resource existence + tenancy is validated in `TeamResourcesService`
 * (the EW-711 IDOR boundary).
 */

export type TeamResourceType = 'work' | 'task' | 'agent' | 'mission' | 'idea';

/** Canonical list — shared by the DTO validators and the service guards. */
export const TEAM_RESOURCE_TYPES: readonly TeamResourceType[] = [
    'work',
    'task',
    'agent',
    'mission',
    'idea',
];

@Entity({ name: 'team_resources' })
@Index('uq_team_resources_team_resource', ['teamId', 'resourceType', 'resourceId'], {
    unique: true,
})
@Index('idx_team_resources_resource', ['resourceType', 'resourceId'])
export class TeamResource {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** FK to `teams.id` (ON DELETE CASCADE by migration). Raw column. */
    @Column({ type: 'uuid' })
    teamId: string;

    @Column({ type: 'varchar', length: 16 })
    resourceType: TeamResourceType;

    /** `works.id` / `tasks.id` / `agents.id` / `missions.id` /
     *  `work_proposals.id` depending on `resourceType`; service-validated. */
    @Column({ type: 'uuid' })
    resourceId: string;

    @Column({ type: 'uuid', nullable: true })
    addedById?: string | null;

    // Tier C denormalized scope FKs (EW-657) — set explicitly from the owning
    // Team on insert (raw `/api/organizations/:orgId/...` routes run with
    // EMPTY_SCOPE, so the ambient ScopeStampingSubscriber may not carry this
    // org). No @ManyToOne — cycle-avoidance, see user.entity.ts EW-654 comment.
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @PortableDateColumn()
    createdAt: Date;
}
