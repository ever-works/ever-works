import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import type {
    AutonomyGrantScopeType,
    LadderedActionCategory,
    TrustRung,
} from '@ever-works/contracts';

/**
 * Safety rails (AW-24) — one stored RUNG for one (scope, category).
 *
 * The trust ladder answers "what happens when this Agent tries to do this
 * kind of work?" by folding exactly three scopes over a shipped default:
 *
 *     platform default  <  Workspace  <  Agent
 *
 * with one rule that makes it a safety boundary rather than a preference: a
 * lower scope may only ever NARROW (`policy/tool-grant.ts` already does the
 * same thing for glob arrays; this is the same rule over an ordered enum).
 * This table is where each scope's contribution lives.
 *
 * # Why a new table rather than a field on something that exists
 *
 * Nothing existing models per-category autonomy. Tool grants match tool-name
 * globs and carry no notion of a KIND of work. The per-Agent dispatch
 * guardrails (`agents.guardrails`) are a two-mode JSON blob over four
 * internal action types. Merge policy is git-shaped. Adding a fourteenth
 * field to any of them would make one of them mean two things — and all three
 * keep working exactly as they do today, because this table never replaces
 * them: where an Agent carries guardrails AND a narrowed rung, the STRICTER
 * wins.
 *
 * # Absence is inherit, never denial
 *
 * A row that does not exist means "inherit the scope above me", exactly as a
 * missing `tool_grants` row does. Deleting a row reverts to inherit. Nothing
 * writes a row to express a default.
 *
 * # Scope columns
 *
 * `tenantId` / `organizationId` are the Tier A/C scope columns, auto-stamped
 * on insert by
 * [`ScopeStampingSubscriber`](../../../../apps/api/src/scope/scope-stamping.subscriber.ts)
 * — it keys on an entity declaring BOTH, which this one does. As everywhere
 * else there is deliberately **no `@ManyToOne`** (the known entities import
 * cycle, EW-654); the foreign keys live in the migration.
 *
 * Note that `scopeType`/`scopeId` (what this rung is ABOUT) and
 * `tenantId`/`organizationId` (which tenant/org the ROW belongs to) are
 * different things, exactly as on `tool_grants`.
 */
@Entity({ name: 'autonomy_grants' })
// One rung per (owner, scope, category) — a second write for the same triple
// is an UPDATE, not a second contradictory layer. Enforced at the DB layer too
// so a concurrent double-create cannot produce two rows that disagree about
// what an Agent may do.
@Index('uq_autonomy_grants_owner_scope_category', ['userId', 'scopeType', 'scopeId', 'category'], {
    unique: true,
})
@Index('idx_autonomy_grants_scope', ['scopeType', 'scopeId'])
@Index('idx_autonomy_grants_user', ['userId'])
export class AutonomyGrant {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** Owner of the row. Every read and write is scoped to this column. */
    @Column({ type: 'uuid' })
    userId: string;

    /** Which scope this rung configures: `workspace` | `agent`. */
    @Column({ type: 'varchar', length: 16 })
    scopeType: AutonomyGrantScopeType;

    /**
     * The id of the scope entity — the Organization id for `workspace`, the
     * Agent id for `agent`.
     *
     * Non-null for every scope, including the bare-tenant workspace (which
     * addresses itself by its tenant id), for the same reason `tool_grants`
     * does it: SQL treats NULLs as DISTINCT inside a unique index, so a
     * nullable member would let a burst of same-scope creates all succeed.
     */
    @Column({ type: 'uuid' })
    scopeId: string;

    /** One of the twelve laddered category ids. `read.internal` is never stored. */
    @Column({ type: 'varchar', length: 24 })
    category: LadderedActionCategory;

    /** `off` | `draft` | `ask` | `auto`. */
    @Column({ type: 'varchar', length: 8 })
    rung: TrustRung;

    /**
     * Who wrote it. Never null — a rung may only ever be changed by a person
     * acting in an interactive session (FR-31), and this column is the record
     * that says which person.
     */
    @Column({ type: 'uuid' })
    setByUserId: string;

    /** Optional note — why this rung. Never a secret. */
    @Column({ type: 'varchar', length: 500, nullable: true })
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
