import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import type { ToolGrantScope } from '@ever-works/contracts';

/**
 * Tool-grant matrix (audit item G4) — one stored grant row for ONE scope.
 *
 * The matrix answers "may this Agent call this tool?" by folding the four
 * scopes tenant → organization → Work → Agent over a permissive platform
 * default, with a hard rule that a more specific scope may only NARROW
 * (see `policy/tool-grant.ts`). This table is where each scope's
 * contribution lives.
 *
 * # Why a table and not four more JSON columns
 *
 * The merge-policy matrix put a `mergePolicy` column on each of the four
 * scope entities because a policy is five booleans that every scope always
 * has an opinion about. Tool grants are different: most scopes have no row
 * at all (they inherit), rows are written and revoked far more often than
 * an entity is updated, and an audit trail per grant is worth having. A
 * dedicated table keeps `tenants`/`organizations`/`works`/`agents` from
 * growing an unbounded JSON blob that every unrelated read would carry.
 *
 * # Scope columns
 *
 * `tenantId` / `organizationId` are the Tier A/C scope columns and are
 * auto-stamped on insert by
 * [`ScopeStampingSubscriber`](../../../../apps/api/src/scope/scope-stamping.subscriber.ts)
 * from the active `ScopeContextService` — the subscriber keys on an entity
 * declaring BOTH columns, which this one does. As with every other
 * tenant-scoped entity there is deliberately **no `@ManyToOne`** on them:
 * that is the known entities import cycle (see `user.entity.ts`, EW-654).
 * The FKs and indexes are enforced at the DB layer by the migration.
 *
 * Note that `scopeType`/`scopeId` (what this grant is ABOUT) and
 * `tenantId`/`organizationId` (which tenant/org the ROW belongs to) are
 * different things: a Work-scoped grant row carries `scopeType='work'`,
 * `scopeId=<workId>` and is itself stamped with the tenant/org it was
 * created under.
 */
@Entity({ name: 'tool_grants' })
// One grant row per (owner, scope) — a second write for the same scope is
// an UPDATE, not a duplicate layer. Enforced at the DB layer too so a
// concurrent double-create cannot produce two contradictory rows.
@Index('uq_tool_grants_owner_scope', ['userId', 'scopeType', 'scopeId'], { unique: true })
@Index('idx_tool_grants_user', ['userId'])
@Index('idx_tool_grants_scope', ['scopeType', 'scopeId'])
export class ToolGrant {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** Owner of the grant. Every read/write is scoped to this column. */
    @Column({ type: 'uuid' })
    userId: string;

    /** Which scope this row configures: tenant | organization | work | agent. */
    @Column({ type: 'varchar', length: 16 })
    scopeType: ToolGrantScope;

    /**
     * The id of the scope entity. Non-null for every scope INCLUDING
     * tenant (a tenant grant names its tenant id) so the unique index has
     * no nullable member — SQL treats NULLs as DISTINCT inside a unique
     * index, which would let a same-scope create burst all succeed.
     */
    @Column({ type: 'uuid' })
    scopeId: string;

    /**
     * Allow patterns (`*`, `prefix*`, `exact_name`). `null` means INHERIT —
     * never "deny". Stored as `simple-json` (TEXT at the DB layer) to match
     * the `agents.permissions` / `works.checkDefaults` storage pattern.
     */
    @Column({ type: 'simple-json', nullable: true })
    allow?: string[] | null;

    /** Deny patterns. Additive and permanent down the chain. */
    @Column({ type: 'simple-json', nullable: true })
    deny?: string[] | null;

    /** Optional operator note — why this grant exists. Never a secret. */
    @Column({ type: 'text', nullable: true })
    note?: string | null;

    // Tier A/C scope columns — auto-stamped by ScopeStampingSubscriber.
    // No @ManyToOne: known entities import cycle (user.entity.ts, EW-654).
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
