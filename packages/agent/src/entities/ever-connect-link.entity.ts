import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';

/** How a link was made. Only provisioning makes one so far. */
export type EverConnectLinkOrigin = 'provisioning';

/** A link stays `active` until it is ended; an ended one is `archived`. */
export type EverConnectLinkStatus = 'active' | 'archived';

/**
 * A Works Organization linked to an Ever organization. `platformLinkId` is
 * Ever Platform's id of the link, known once it answered the report. One active
 * link per tenant and per Ever organization, one per Organization.
 */
@Entity({ name: 'ever_connect_links' })
@Index('uq_ever_connect_links_organization', ['organizationId'], { unique: true })
@Index('uq_ever_connect_links_tenant_active', ['tenantId'], {
    unique: true,
    where: `"status" = 'active'`,
})
@Index('uq_ever_connect_links_ever_org_active', ['everOrgId'], {
    unique: true,
    where: `"status" = 'active'`,
})
export class EverConnectLink {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    organizationId: string;

    @Column({ type: 'uuid' })
    tenantId: string;

    @Column({ type: 'varchar', length: 64 })
    everOrgId: string;

    /** The Ever handle, a display copy (the Organization's slug may differ). */
    @Column({ type: 'varchar', length: 64 })
    handle: string;

    @Column({ type: 'varchar', length: 64, nullable: true })
    platformLinkId: string | null;

    @Column({ type: 'varchar', length: 16 })
    createdVia: EverConnectLinkOrigin;

    @Column({ type: 'varchar', length: 16, default: 'active' })
    status: EverConnectLinkStatus;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
