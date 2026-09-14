import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import type {
    ModelChainEntry,
    ModelPolicyScheduleSource,
    ModelPolicyScopeType,
    ReasoningEffort,
} from '@ever-works/contracts';

/**
 * Model accounts (AW-16) — the routing decision at one scope: a primary model,
 * an ordered fallback list, a reasoning effort and the timeouts.
 *
 * # One table, three scopes
 *
 * `scopeType` is `workspace`, `agent` or `schedule`. Putting the same fields
 * on the workspace, on Agents and on every kind of schedule would be several
 * copies of the same columns with several places for the ladder to drift;
 * one table keyed by scope gives one resolver and one place to test
 * narrowest-wins.
 *
 * `scopeKey` is `workspace`, `agent:<agentId>` or
 * `schedule:<source>:<ownerId>` — the schedule half is the same synthetic key
 * the unified schedule list gives a row. It is never null, so
 * `uq_model_policies_workspace_scope` holds on every driver.
 *
 * # Every field inherits
 *
 * Each routing column is independently nullable: NULL = this scope does not
 * set the field, so a schedule that sets only the model still inherits the
 * effort and the timeout. `fallbackModels = []` is "explicitly none", which is
 * not the same as NULL.
 *
 * # An Agent's primary model is not stored here
 *
 * An Agent already has its own provider/model pair on the `agents` row, and
 * that pair keeps its meaning. The Agent-scope row therefore never carries
 * `primaryModel`; the policy service reads and writes the Agent's own columns
 * for it, so an Agent's model lives in exactly one place.
 */
@Entity({ name: 'model_policies' })
@Index('uq_model_policies_workspace_scope', ['workspaceKey', 'scopeKey'], { unique: true })
@Index('idx_model_policies_scope', ['scopeType', 'scopeId'])
export class ModelPolicy {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** Who last wrote the policy. */
    @Column({ type: 'uuid' })
    userId: string;

    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    /** `org:<organizationId>` or `user:<userId>`, as on `model_accounts`. */
    @Column({ type: 'varchar', length: 80 })
    workspaceKey: string;

    /** `workspace`, `agent:<agentId>` or `schedule:<source>:<ownerId>`. */
    @Column({ type: 'varchar', length: 128 })
    scopeKey: string;

    @Column({ type: 'varchar', length: 16 })
    scopeType: ModelPolicyScopeType;

    /** NULL for the workspace; the Agent id or the schedule owner id otherwise. */
    @Column({ type: 'varchar', length: 64, nullable: true })
    scopeId?: string | null;

    /** Only for schedule scope — which recurring definition on that owner. */
    @Column({ type: 'varchar', length: 32, nullable: true })
    scopeVariant?: ModelPolicyScheduleSource | null;

    /** NULL = inherit. Never set on an Agent-scope row (see the class comment). */
    @Column({ type: 'simple-json', nullable: true })
    primaryModel?: ModelChainEntry | null;

    /** NULL = inherit, [] = explicitly no fallbacks. At most three entries. */
    @Column({ type: 'simple-json', nullable: true })
    fallbackModels?: ModelChainEntry[] | null;

    @Column({ type: 'varchar', length: 8, nullable: true })
    reasoningEffort?: ReasoningEffort | null;

    @Column({ type: 'int', nullable: true })
    runTimeoutSeconds?: number | null;

    @Column({ type: 'int', nullable: true })
    attemptTimeoutSeconds?: number | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
