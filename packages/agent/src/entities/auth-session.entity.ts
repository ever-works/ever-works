import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { PortableDateColumn } from './_types';

/**
 * H-01 (sessions): the raw bearer travels in the response body / `Authorization`
 * header only. At rest we persist `tokenHash = sha256(token)` and look up by
 * the hash. The legacy `token` column is kept NULLABLE so older rows survive
 * the migration; new rows always write `null` into `token` and the hash into
 * `tokenHash`. A DB read of the `session` table now leaks hashes — useless
 * for replaying a session — rather than live bearers.
 */
@Entity({ name: 'session' })
// Legacy `token` column kept for migration window; `tokenHash` is the live
// index (see 1779300000000-HashAuthSessionTokensH01 and the drop in
// 1779500000000-DropLegacyAuthSessionTokenIndexH01). Do NOT re-add a unique
// index on `token` — new writes set it to NULL and on engines that treat
// NULLs as equal under uniqueness (SQLite) it would block concurrent inserts.
@Index(['tokenHash'], { unique: true })
@Index(['userId'])
export class AuthSession {
    @PrimaryColumn({ type: 'varchar' })
    id: string;

    @Column({ type: 'varchar' })
    userId: string;

    // H-01 (sessions): legacy plaintext column. Kept for migration safety —
    // new writes set it to NULL. Lookup paths use `tokenHash` only. The
    // unique index that used to live on this column was dropped in
    // 1779500000000-DropLegacyAuthSessionTokenIndexH01.
    @Column({ type: 'varchar', nullable: true })
    token: string | null;

    // H-01 (sessions): sha256(token) hex, the only column we look up by going
    // forward. Indexed unique so the lookup is O(1) and accidental hash
    // collisions surface as a write error rather than silent overlap.
    @Column({ type: 'varchar', nullable: true })
    tokenHash: string | null;

    @PortableDateColumn()
    expiresAt: Date;

    @Column({ type: 'varchar', nullable: true })
    ipAddress?: string | null;

    @Column({ type: 'varchar', nullable: true })
    userAgent?: string | null;

    // EW-654 (Tenants & Organizations Phase 2) — Tier B scope. NULL
    // until the owning user creates their first Organization.
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    // APW-12 (Ever ID) — which connected identity opened this session, so a
    // disconnect or a `sub`-only sign-out notice can find "the sessions Ever ID
    // opened" (FR-29, FR-34). Deliberately NO foreign key: a session row must
    // never block deleting an identity, and disconnect deletes the sessions
    // explicitly first. NULL for every other sign-in method (FR-35).
    @Index('idx_session_external_identity')
    @Column({ type: 'uuid', nullable: true })
    externalIdentityId?: string | null;

    // APW-12 (Ever ID) — the provider's session id (`sid`) when it sent one, so a
    // back-channel sign-out notice ends exactly the session it names (FR-32,
    // FR-34). NULL when the provider sent none and for every other method.
    @Index('idx_session_external_sid')
    @Column({ type: 'varchar', length: 255, nullable: true })
    externalSid?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
