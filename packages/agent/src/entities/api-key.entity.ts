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

    @CreateDateColumn()
    createdAt: Date;
}
