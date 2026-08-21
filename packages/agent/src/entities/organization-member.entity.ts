import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    Index,
    Unique,
    ManyToOne,
    JoinColumn,
    CreateDateColumn,
    UpdateDateColumn,
} from 'typeorm';
import { User } from './user.entity';
import { Organization } from './organization.entity';
import { ClassToObject, OrganizationMemberRole } from './types';
import { PortableDateColumn } from './_types';

/**
 * A human's membership of an Organization — the `OrganizationMember` half of
 * the v1.1 item deferred in
 * `docs/specs/features/tenants-and-organizations/spec.md` §7.
 *
 * 🛑 **This table is the ROSTER, not the authorization check.** Access is still
 * decided by `OrganizationMembershipService.ensureMember`, which compares
 * `user.tenantId` to `organization.tenantId` — unchanged by this feature, and
 * deliberately so: five independent read paths depend on that equality
 * (`ensureMember`, `OrganizationService.listForUser`, `ScopeOwnershipGuard`,
 * `TeamsService.listOrgUsers`, `TeamsService.addMember`), and rewriting them
 * is a far larger change than adding invitations.
 *
 * So a row here is created **alongside** the `users.tenantId` write that
 * actually grants access, and it answers the questions tenant-equality cannot:
 * who invited this person, when did they join, and which Organization was it
 * nominally for. It is also the seam a future per-Org permission model
 * tightens, without a second migration.
 *
 * The practical consequence, recorded because it will surprise someone:
 * because access is tenant-wide, a member of one Organization can see every
 * Organization in that Tenant. The owner accepted this explicitly for v1.
 */
@Entity({ name: 'organization_members' })
@Unique(['organizationId', 'userId'])
@Index(['organizationId'])
@Index(['userId'])
export class OrganizationMember {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    organizationId: string;

    @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'organizationId' })
    organization: ClassToObject<Organization>;

    /** Copied from the Organization at join time; the scope this grants. */
    @Column({ type: 'uuid' })
    tenantId: string;

    @Column({ type: 'uuid' })
    userId: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user: ClassToObject<User>;

    /**
     * Reserved, and DISPLAY-ONLY — not an authorization input. See the
     * matching note on `OrganizationInvitation.role`.
     */
    @Column({ type: 'varchar', length: 32, default: 'member' })
    role: OrganizationMemberRole;

    /** Null for the Tenant owner, who is a member by construction. */
    @Column({ type: 'uuid', nullable: true })
    invitedById: string | null;

    /**
     * The invitation this membership came from, kept for audit.
     *
     * `SET NULL` rather than `CASCADE`: deleting an invitation record must
     * never delete the membership it produced.
     */
    @Column({ type: 'uuid', nullable: true })
    invitationId: string | null;

    @PortableDateColumn()
    joinedAt: Date;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
