import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** The primary key of the one row this table ever holds. */
export const EVER_INSTANCE_ROW_ID = 'self';

/**
 * The identity of this installation for the anonymous usage statistics module:
 * ONE row (`id = 'self'`) shared by every API replica on the database.
 *
 * - `instanceId` — an opaque v4 UUID generated at first boot. It identifies a
 *   deployment, never a person or an organization, and is sent as the report's
 *   `instance_id`.
 * - The **statistics key pair** (Ed25519) signs reports and nothing else. The
 *   public key travels with each report; the private key is stored only in its
 *   wrapped form (`statsPrivateKeyEncrypted`, the `enc::v1::` envelope of the
 *   plugin secret store) and never leaves the instance.
 * - The **connection key** columns are created empty for the separate
 *   Ever Platform connection module; nothing here writes them, and the two
 *   keys are never the same key, so a statistics series cannot be joined to a
 *   connection record by key.
 * - `statsEnabledUi` — the operator's switch in Settings. Off ⇒ the module stays
 *   loaded but makes no request at all.
 * - `resetCount` — how many times the operator reset the identity (a new UUID
 *   and a new statistics key, so future reports cannot be joined to past ones).
 *
 * Instance-wide by design: no tenant or organization column, and excluded from
 * every account export (see `BACKUP_DROPPED_ENTITIES`).
 */
@Entity({ name: 'ever_instance' })
export class EverInstance {
    @PrimaryColumn({ type: 'varchar', length: 16 })
    id: string;

    @Column({ type: 'uuid' })
    instanceId: string;

    /** base64url (no padding) of the 32 raw Ed25519 public key bytes. */
    @Column({ type: 'varchar', length: 64 })
    statsPublicKey: string;

    /** The PKCS#8 private key, wrapped (`enc::v1::…`); never logged, never returned by the API. */
    @Column({ type: 'text' })
    statsPrivateKeyEncrypted: string;

    /** base64url of the first 8 bytes of SHA-256 over the 32 public key bytes. */
    @Column({ type: 'varchar', length: 16 })
    statsKeyId: string;

    /** Reserved for the connection module (a different key); always empty here. */
    @Column({ type: 'varchar', length: 64, nullable: true })
    connectPublicKey?: string | null;

    @Column({ type: 'text', nullable: true })
    connectPrivateKeyEncrypted?: string | null;

    @Column({ type: 'varchar', length: 16, nullable: true })
    connectKeyId?: string | null;

    /** The operator switch in Settings → Ever Platform. Default on (anonymous statistics). */
    @Column({ type: 'boolean', default: true })
    statsEnabledUi: boolean;

    @Column({ type: 'int', default: 0 })
    resetCount: number;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
