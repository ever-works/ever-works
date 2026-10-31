import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';

/**
 * One Ever Platform integration of this installation, as Ever Platform last
 * reported it (`GET /v1/instances/me/integrations` and the consent events of
 * the feed). Nothing is enabled here without a consent Ever Platform holds.
 *
 * `linkId` is empty for an installation-wide integration (`ever_id_login`,
 * `instance_url`, `stats_link`, `webhooks`) and names the tenant link
 * otherwise. `state` is Ever Platform's label: `available`, `coming_soon`,
 * `pending_operator` (waits for this installation's administrator to accept),
 * `enabled`, `disabled`, `revoked` or `denied_by_policy`.
 *
 * `configEncrypted` holds what an integration hands the installation, wrapped
 * like a plugin secret: for `ever_id_login`, the Ever ID sign-in client.
 */
@Entity({ name: 'ever_connect_integration' })
@Index('uq_ever_connect_integration_link_key', ['linkId', 'integrationKey'], { unique: true })
export class EverConnectIntegration {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** Empty for an installation-wide integration; the tenant link id otherwise. */
    @Column({ type: 'varchar', length: 64, default: '' })
    linkId: string;

    @Column({ type: 'varchar', length: 64 })
    integrationKey: string;

    @Column({ type: 'varchar', length: 32 })
    state: string;

    /** Whether the integration may act now (Ever Platform's `enabled`). */
    @Column({ type: 'boolean', default: false })
    enabled: boolean;

    /** The consent record it runs under (needed to accept it locally). */
    @Column({ type: 'varchar', length: 64, nullable: true })
    consentId: string | null;

    @Column({ type: 'int', nullable: true })
    scopeVersion: number | null;

    /** What the integration handed over, wrapped; never returned by any route. */
    @Column({ type: 'text', nullable: true })
    configEncrypted: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
