import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    ManyToOne,
    CreateDateColumn,
    Index,
} from 'typeorm';
import { PERSONAL_API_KEY_KIND, type ApiKeyKind } from '@ever-works/contracts';
import { User } from './user.entity';
import type { ClassToObject } from './types';
import { TimestampColumn } from './_types';

@Entity({ name: 'api_keys' })
@Index(['hashedKey'], { unique: true })
@Index(['userId'])
@Index(['boundJobId'])
@Index('idx_api_keys_previous_hashed_key', ['previousHashedKey'])
@Index('idx_api_keys_tenant_kind', ['tenantId', 'kind'])
export class ApiKey {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    userId: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    user: ClassToObject<User>;

    @Column({ length: 100 })
    name: string;

    @Column({ unique: true })
    hashedKey: string;

    @Column({ length: 12 })
    prefix: string;

    @TimestampColumn({ nullable: true })
    expiresAt: Date | null;

    @TimestampColumn({ nullable: true })
    lastUsedAt: Date | null;

    @Column({ default: true })
    isActive: boolean;

    // Self-build slice Z (EW-796) — the fleet-run credential.
    //
    // ONE table, two kinds. A run token is an api key in every respect
    // that matters (sha256 at rest, `expiresAt`, `isActive` as the revoke
    // switch, an owner and an Organization) and reusing the row means the
    // guard, the hash lookup and the expiry check are the SAME code that
    // has been carrying `ew_live_` keys all along — a second table would
    // have been a second, subtly different validator.
    //
    // What the discriminator buys: `findByUserId` / `countByUserId` filter
    // to `personal`, so a run token never appears in Settings > API Keys
    // and never consumes one of the owner's ten slots. Existing rows read
    // as `personal` through the column DEFAULT (migration 1789400000000).
    @Column({ type: 'varchar', length: 32, default: PERSONAL_API_KEY_KIND })
    kind: ApiKeyKind;

    /**
     * Fleet job this token was minted for. The validator re-reads the job
     * on EVERY request: a token whose job is finished, cancelled, or has
     * been relocated to another node is refused even before its expiry.
     */
    @Column({ type: 'uuid', nullable: true })
    boundJobId?: string | null;

    /**
     * Node that held the lease at mint time. A job reclaimed by a
     * different node kills every token minted under the old claim — that
     * is what stops a machine that lost its lease from still acting as
     * the run.
     */
    @Column({ type: 'uuid', nullable: true })
    boundNodeId?: string | null;

    /** Platform `AgentRun` the token acts for (audit + reporting only). */
    @Column({ type: 'uuid', nullable: true })
    boundRunId?: string | null;

    // EW-655 (Tenants & Organizations Phase 3) — Tier A scope FKs.
    // Both NULL until the owning user creates their first Organization
    // (Phase 6 lazy backfill). FK + index enforced at DB level by
    // migration 1779991006000-AddTenantIdAndOrganizationIdToTierA.
    // No @ManyToOne to avoid the entities import cycle that bit Phase 2 —
    // see user.entity.ts EW-654 comment.
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    // ── EW-P1-2 — integration keys (`kind = 'integration'`, `ew_int_…`) ──
    //
    // An integration key is the third kind of row in this table. It does not
    // act as its creator on every route: it is pinned to Organizations of the
    // creator's Tenant (`organizationIds`), it carries `scopes`, and the
    // integration guards admit it only on routes that declare
    // `@RequireScopes(...)`. Every column below is NULL on personal and
    // fleet-run rows. Shipped by migration 1795060100000-AddIntegrationApiKeys.

    /** Granted scopes (vocabulary v1, `INTEGRATION_SCOPES`). Integration keys only. */
    @Column({ type: 'simple-json', nullable: true })
    scopes?: string[] | null;

    /** Organizations the key is pinned to (at least one). Integration keys only. */
    @Column({ type: 'simple-json', nullable: true })
    organizationIds?: string[] | null;

    /** Who the key is for: `'ever-gauzy'` | `'generic'`. Integration keys only. */
    @Column({ type: 'varchar', length: 32, nullable: true })
    integrationKind?: string | null;

    /** Free-text note shown in Settings > API keys. */
    @Column({ type: 'varchar', length: 500, nullable: true })
    description?: string | null;

    /**
     * Rotation with a grace period (`POST /api/auth/api-keys/:id/rotate`).
     *
     * Rotation is IN PLACE: the row keeps its id (webhook subscriptions,
     * audit rows and the integration's stored key id stay valid), `hashedKey`
     * becomes the new secret and the old digest moves here, accepted until
     * `previousKeyGraceUntil`. A second rotation replaces it, so at most two
     * secrets are ever live for one key.
     */
    @Column({ type: 'varchar', length: 64, nullable: true })
    previousHashedKey?: string | null;

    @TimestampColumn({ nullable: true })
    previousKeyGraceUntil?: Date | null;

    @TimestampColumn({ nullable: true })
    rotatedAt?: Date | null;

    @CreateDateColumn()
    createdAt: Date;
}
