import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';

/**
 * Networking posture for a runtime Environment. Stored as `varchar(16)`
 * rather than a Postgres enum so a future mode never needs a
 * type-altering migration (same convention as `works.kind` /
 * `tenant_job_runtime_config.mode`). Application-layer validation pins
 * the value to `'unrestricted' | 'limited'`.
 */
export type EnvironmentNetworkingMode = 'unrestricted' | 'limited';

/**
 * Lifecycle for a runtime Environment. `draft` rows are editable but NOT
 * assignable to Agents (server-enforced in `AgentsService`); `published`
 * rows are what the per-Agent Environment picker offers.
 */
export type EnvironmentStatus = 'draft' | 'published';

/**
 * Environments (Settings → Environments) — a named, reusable runtime
 * recipe a user manages once and assigns per-Agent: package lists
 * (pip/npm), networking posture (unrestricted vs. limited + egress
 * allow-list), and lifecycle (draft/published).
 *
 * Consumed v1 by the `claude-managed-agent` pipeline plugin, which builds
 * its Anthropic Managed-Agent Environment + a session bootstrap install
 * step from the resolved row (see
 * `packages/plugin/src/pipeline/runtime-environment.ts` for the
 * serializable carrier shape). Elsewhere the resolved Environment rides
 * along as advisory metadata.
 *
 * Package lists and allowed hosts are validated with strict allow-list
 * regexes at the DTO layer AND re-validated in `EnvironmentsService`
 * (defense in depth — these values later reach install commands).
 *
 * No `@ManyToOne` relations declared here (EW-654 no-cycle rule) — the
 * `userId` FK + ON DELETE CASCADE is enforced at the DB level by
 * migration `1786810000000-CreateEnvironments`. Tier A/C scope columns
 * (`tenantId`, `organizationId`) follow the EW-651 convention: both NULL
 * until the owning user creates their first Organization.
 */
@Entity({ name: 'environments' })
// Durable per-user slug uniqueness — mirrors `uq_agents_user_scope_slug`:
// the DB enforces the create CAS so a concurrent same-name create burst
// yields exactly one winner and the losers get the named 409 via
// `isUniqueConstraintError` in `EnvironmentsService.create`.
@Index('uq_environments_user_slug', ['userId', 'slug'], { unique: true })
@Index('idx_environments_user_status', ['userId', 'status'])
export class Environment {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** FK to `users.id` (constraint added by migration; no @ManyToOne). */
    @Column('uuid')
    userId: string;

    @Column({ type: 'varchar', length: 120 })
    name: string;

    /** Kebab-case derived from `name`; unique per user (see index). */
    @Column({ type: 'varchar', length: 80 })
    slug: string;

    @Column({ type: 'text', nullable: true })
    description?: string | null;

    /** pip requirement specifiers, validated (`requests`, `pandas==2.2.0`). */
    @Column('simple-json')
    pipPackages: string[];

    /** npm install targets, validated (`typescript`, `@scope/pkg@^1`). */
    @Column('simple-json')
    npmPackages: string[];

    @Column({ type: 'varchar', length: 16, default: 'unrestricted' })
    networkingMode: EnvironmentNetworkingMode;

    /**
     * Egress allow-list (hostnames, optional single `*.` wildcard label).
     * NULL unless `networkingMode = 'limited'`; the service normalises an
     * unrestricted row's hosts to NULL so the two fields can't disagree.
     */
    @Column('simple-json', { nullable: true })
    allowedHosts?: string[] | null;

    /**
     * Whether the consuming runtime should keep its package-manager hosts
     * reachable when networking is limited (maps to the CMA
     * `allow_package_managers` flag).
     */
    @Column({ type: 'boolean', default: true })
    allowPackageManagers: boolean;

    @Column({ type: 'varchar', length: 16, default: 'draft' })
    status: EnvironmentStatus;

    /**
     * When true (default) the Environment is offered everywhere the user
     * assigns Environments; a per-project narrowing surface is a
     * follow-up — the flag ships now so rows created before that surface
     * carry an explicit choice.
     */
    @Column({ type: 'boolean', default: true })
    availableInAllProjects: boolean;

    // EW-651 Tier A/C scope columns — both NULL until the owning user
    // creates their first Organization (lazy backfill). No @ManyToOne to
    // avoid the entities import cycle; see user.entity.ts EW-654 comment.
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
