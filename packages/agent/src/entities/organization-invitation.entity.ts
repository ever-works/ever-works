import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    Index,
    ManyToOne,
    JoinColumn,
    CreateDateColumn,
    UpdateDateColumn,
} from 'typeorm';
import { User } from './user.entity';
import { Organization } from './organization.entity';
import { ClassToObject, OrganizationInvitationRole, OrganizationInvitationStatus } from './types';
import { PortableDateColumn } from './_types';

export type OrganizationInvitationMetadata = {
    /** Display name the inviter typed, if any — used only in the email copy. */
    invitedName?: string;
    /** Free-form additional context. */
    [k: string]: unknown;
};

/**
 * An outstanding invitation for a HUMAN to join an Organization.
 *
 * Implements the `OrganizationInvitation` half of the v1.1 item deferred in
 * `docs/specs/features/tenants-and-organizations/spec.md` §7. The sibling
 * `WorkInvitation` is the template: same 256-bit token, same
 * store-only-the-hash rule, same status lifecycle.
 *
 * Two deliberate divergences from `WorkInvitation`, both tightenings:
 *
 *  1. **`email` is NOT NULL here.** `WorkInvitation.email` is nullable because
 *     a Work invite can be a bare link handed over out-of-band. An Org invite
 *     exists to reach someone who does not have an account yet, and the mail
 *     path silently no-ops on a null recipient — a nullable column would make
 *     "invited someone who can never be reached" representable.
 *  2. **The token is EMAIL-BOUND** (see `emailNormalized`). A Work token is a
 *     bearer credential; an Org token grants tenant-wide access, which is a
 *     much larger blast radius, so possession alone is deliberately not enough.
 */
@Entity({ name: 'organization_invitations' })
@Index(['organizationId'])
@Index(['tokenHash'], { unique: true })
@Index(['status'])
// One live invitation per person per Organization. Without this, "invite"
// clicked twice mints two independently redeemable tokens for the same
// mailbox, and revoking the one you can see leaves the other one live.
// Partial (`status = 'pending'`) so that re-inviting someone whose earlier
// invite was revoked or expired stays legal.
@Index(['organizationId', 'emailNormalized'], {
    unique: true,
    where: "status = 'pending'",
})
export class OrganizationInvitation {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    organizationId: string;

    @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'organizationId' })
    organization: ClassToObject<Organization>;

    /**
     * The Tenant the invitee joins on accept.
     *
     * NOT the nullable Tier-C denormalization that `WorkInvitation` carries —
     * here it is the scope key itself, copied from the Organization at
     * issuance so that a later Org move cannot silently redirect a live
     * invitation into a different Tenant.
     */
    @Column({ type: 'uuid' })
    tenantId: string;

    /** Exactly as typed by the inviter — this is what the email is sent to. */
    @Column({ type: 'varchar', length: 320 })
    email: string;

    /**
     * `email` trimmed and lower-cased. Carried as its own column rather than
     * computed, because the uniqueness index and the accept-time comparison
     * both have to agree on one canonical form; deriving it in two places is
     * how "Bob@x.com already invited" and "bob@x.com is not invited" end up
     * true at the same time.
     */
    @Column({ type: 'varchar', length: 320 })
    emailNormalized: string;

    /**
     * Reserved, and DISPLAY-ONLY: this is not an authorization input.
     *
     * `OrganizationMembershipService.ensureAdmin` is currently identical to
     * `ensureMember` by design, and its docblock forbids introducing a role
     * check without a product decision. Same posture as `TeamMember.role`.
     * The column exists so per-Org roles can land later without a migration
     * on live invitation rows.
     */
    @Column({ type: 'varchar', length: 32, default: 'member' })
    role: OrganizationInvitationRole;

    /** `sha256(token)`. The raw token is returned to the issuer exactly once. */
    @Column({ type: 'varchar', length: 64 })
    tokenHash: string;

    @PortableDateColumn()
    tokenExpiresAt: Date;

    @Column({ type: 'uuid' })
    invitedById: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'invitedById' })
    invitedBy: ClassToObject<User>;

    @Column({
        type: 'varchar',
        length: 16,
        default: OrganizationInvitationStatus.PENDING,
    })
    status: OrganizationInvitationStatus;

    @Column({ type: 'uuid', nullable: true })
    acceptedByUserId: string | null;

    @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
    @JoinColumn({ name: 'acceptedByUserId' })
    acceptedBy: ClassToObject<User> | null;

    @PortableDateColumn({ nullable: true })
    acceptedAt: Date | null;

    @Column({ type: 'simple-json', nullable: true })
    metadata: OrganizationInvitationMetadata | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;

    /**
     * Expiry is evaluated, never trusted from `status`.
     *
     * Nothing sweeps `pending` rows to `expired` on a timer, so a row can sit
     * at `pending` long past `tokenExpiresAt`. Every consumption path must ask
     * this rather than reading `status` alone.
     */
    isExpired(now: Date = new Date()): boolean {
        return this.tokenExpiresAt.getTime() <= now.getTime();
    }

    isConsumable(now: Date = new Date()): boolean {
        return this.status === OrganizationInvitationStatus.PENDING && !this.isExpired(now);
    }
}
