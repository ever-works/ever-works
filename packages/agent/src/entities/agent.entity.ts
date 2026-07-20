import {
    BeforeInsert,
    BeforeUpdate,
    Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import { User } from './user.entity';
import { PortableDateColumn } from './_types';

/**
 * Agent scope (agents/spec.md §3.6 / architecture/agents-skills-tasks.md §3).
 *
 * - `TENANT`  — user-wide; reachable across all the user's Missions/Ideas/Works
 *               via `AgentMembership` (or implicit-all when no memberships set).
 * - `MISSION` — bound to a single Mission; sees its Ideas + derived Works.
 * - `IDEA`    — bound to a single Idea; usually short-lived (validity/market work).
 * - `WORK`    — bound to a single Work; sees its data/website repos + items.
 */
export enum AgentScope {
    TENANT = 'tenant',
    MISSION = 'mission',
    IDEA = 'idea',
    WORK = 'work',
}

/**
 * Lifecycle states (agents/spec.md §3.1, architecture §6).
 *
 * Transitions allowed:
 *   draft   → active
 *   active ⇄ paused
 *   active ⇄ running       (transitional; CAS-claimed by the dispatcher)
 *   active  → error        (after errorCount >= pauseAfterFailures)
 *   error   → paused
 *   paused  → active
 *   *       → archived     (soft-delete)
 */
export enum AgentStatus {
    DRAFT = 'draft',
    ACTIVE = 'active',
    RUNNING = 'running',
    PAUSED = 'paused',
    ERROR = 'error',
    ARCHIVED = 'archived',
}

/**
 * Avatar rendering mode (agents/spec.md §5.10a — operator H3 override:
 * all three modes ship in v1).
 *
 * - `INITIALS` — first 1-2 letters in a circle; color hashed from slug. Default.
 * - `ICON`     — lucide-react icon name; color hashed.
 * - `IMAGE`    — uploaded image (FK to `work_knowledge_uploads`). Requires the
 *                tenant to have a storage plugin enabled.
 */
export enum AgentAvatarMode {
    INITIALS = 'initials',
    ICON = 'icon',
    IMAGE = 'image',
}

/**
 * Per-Agent capability flags (agents/spec.md §3.7, architecture §5).
 *
 * Stored as JSON on `agents.permissions`. Defaults are all `false` —
 * permissions must be explicitly granted. Enforced server-side on every
 * tool call AND on the controller endpoints that mutate Agents.
 *
 * `canOpenPullRequests` implies `canCommitToRepo` (refine validator
 * enforces this in `AgentService.update`).
 */
export interface AgentPermissions {
    canCreateAgents: boolean;
    canAssignTasks: boolean;
    canEditSkills: boolean;
    canEditAgentFiles: boolean;
    canSpend: boolean;
    canCommitToRepo: boolean;
    canOpenPullRequests: boolean;
    canCallExternalTools: boolean;
}

/**
 * Conservative default — no capability unless explicitly granted. Exported
 * so the `simple-json` column default can use a fresh object and tests can
 * assert against the same shape.
 */
export const AGENT_PERMISSIONS_DEFAULT: AgentPermissions = Object.freeze({
    canCreateAgents: false,
    canAssignTasks: false,
    canEditSkills: false,
    canEditAgentFiles: false,
    canSpend: false,
    canCommitToRepo: false,
    canOpenPullRequests: false,
    canCallExternalTools: false,
});

/**
 * One entry in the `agents.targets` JSON array (tenant-scoped Agent's
 * explicit membership set). When `targets` is null/missing, a tenant Agent
 * is implicitly "available to all" the user's Missions/Ideas/Works. When
 * present, it explicitly enumerates what the Agent reaches.
 *
 * `type: 'wildcard'` is the same as no `targets` entry; included so the UI
 * can persist an explicit "all" choice.
 */
export interface AgentTarget {
    type: 'mission' | 'idea' | 'work' | 'wildcard';
    id?: string;
}

/**
 * Reporting period for one scorecard metric — how often the target is
 * meant to be met/reset by the operator.
 */
export type AgentScorecardPeriod = 'weekly' | 'monthly' | 'quarterly';

/**
 * One quantified goal on an Agent's scorecard (Agent Scorecards
 * increment 1 — data model + manual editing + display). Stored as a
 * `simple-json` array on `agents.scorecard`.
 *
 * - `key`     — kebab-case identifier, unique within the scorecard
 *               (stable handle for testids / future automation).
 * - `label`   — human-readable metric name (<= 80 chars).
 * - `target`  — the goal value for the period.
 * - `current` — the latest measured value (manually edited in this
 *               increment; auto-updating from run output is a follow-up).
 * - `floor`   — optional minimum acceptable value; below it the metric
 *               reads as critical.
 * - `stretch` — optional stretch goal; at/above it the metric reads as
 *               exceeded.
 * - `unit`    — optional display unit ("PRs", "%", "$"...).
 * - `period`  — weekly | monthly | quarterly.
 */
export interface AgentScorecardMetric {
    key: string;
    label: string;
    target: number;
    current: number;
    floor?: number | null;
    stretch?: number | null;
    unit?: string | null;
    period: AgentScorecardPeriod;
}

/**
 * Heartbeat idle-tick behavior (agents/spec.md §5.2 — F3 operator decision).
 *
 * - `propose`  — ask the AI for the next action (default; delivers visible work).
 * - `noop`     — exit cheaply without an AI call.
 * - `observe`  — read scope state + emit an activity row; no AI call.
 */
export enum AgentIdleBehavior {
    PROPOSE = 'propose',
    NOOP = 'noop',
    OBSERVE = 'observe',
}

/**
 * A user-defined Agent — a named, persistent AI worker scoped to
 * Tenant / Mission / Idea / Work. Source of truth for Agent identity;
 * the five canonical MD files (`SOUL.md`, `AGENTS.md`, `HEARTBEAT.md`,
 * `TOOLS.md`, `agent.yml`) live either in the scope's Git repo
 * (Mission/Idea/Work) or inline on this row (tenant scope per ADR-008).
 *
 * See:
 * - architecture/agents-skills-tasks.md (overall design)
 * - agents/spec.md §3 (functional requirements)
 * - agents/plan.md §3.1 (entity shape — this file mirrors it)
 * - architecture/agent-yml-manifest-schema.md (the `agentYml` Zod schema)
 * - ADR-006 (Agents are core, runtime delegates to agentic-pipeline plugins)
 * - ADR-008 (DB-inline tenant file storage)
 *
 * Cascade: deleting the user CASCADES through `userId`. Mission/Idea/Work
 * scope refs are nullable + intentionally NOT declared as `@ManyToOne` to
 * avoid forward-import cycles; FK constraints are added by the migration.
 */
@Entity({ name: 'agents' })
// Durable per-scope slug uniqueness. The scope's target is normalized into the
// NON-NULL `scopeTargetId` column (see below) so this index has no nullable
// members — SQL treats NULLs as DISTINCT inside a unique index, so the previous
// `(userId, scope, missionId, ideaId, workId, slug)` form could NOT dedup
// same-name agents in any null-containing scope (tenant has all three FKs null;
// mission has idea/work null; etc.), letting a concurrent same-name create
// burst ALL succeed instead of exactly one. With `scopeTargetId` non-null the
// DB enforces the slug CAS on both Postgres and sqlite, and the lost racers get
// the named 409 via `isUniqueConstraintError` in agents.service.create.
@Index('uq_agents_user_scope_slug', ['userId', 'scope', 'scopeTargetId', 'slug'], {
    unique: true,
})
@Index('idx_agents_user_status', ['userId', 'status'])
@Index('idx_agents_next_heartbeat', ['status', 'nextHeartbeatAt'])
@Index('idx_agents_mission', ['missionId'])
@Index('idx_agents_work', ['workId'])
@Index('idx_agents_idea', ['ideaId'])
export class Agent {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column('uuid')
    userId: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user?: User;

    @Column({ type: 'varchar', length: 16 })
    scope: AgentScope;

    /** FK to `missions.id` when `scope = 'mission'`. */
    @Column('uuid', { nullable: true })
    missionId?: string | null;

    /** FK to `work_proposals.id` when `scope = 'idea'`. */
    @Column('uuid', { nullable: true })
    ideaId?: string | null;

    /** FK to `works.id` when `scope = 'work'`. */
    @Column('uuid', { nullable: true })
    workId?: string | null;

    /**
     * NON-NULL normalization of the scope's target id, used solely by the
     * `uq_agents_user_scope_slug` unique index so it carries no nullable
     * members (NULLs are DISTINCT in a unique index and would defeat the
     * dedup). Holds `missionId ?? ideaId ?? workId` for scoped agents, or the
     * empty string for tenant-scope. Kept in lock-step with the FKs by
     * `syncScopeTargetId()` (@BeforeInsert/@BeforeUpdate) — never set it by
     * hand.
     */
    @Column({ type: 'varchar', length: 36, default: '' })
    scopeTargetId: string;

    @Column({ type: 'varchar', length: 120 })
    name: string;

    /** Kebab-case derived from `name`; unique per scope (see composite index). */
    @Column({ type: 'varchar', length: 80 })
    slug: string;

    @Column({ type: 'varchar', length: 200, nullable: true })
    title?: string | null;

    @Column({ type: 'text', nullable: true })
    capabilities?: string | null;

    /**
     * Direct manager for the Org Chart + `AGENTS.md reportsTo:` on company
     * import (teams-and-companies spec §1.2). Raw self-reference column —
     * FK ON DELETE SET NULL by migration; same-org + acyclicity are
     * service-enforced. Descriptive in v1: carries NO authz and does not
     * alter the createSubAgent scope-narrowing cascade.
     */
    @Column({ type: 'uuid', nullable: true })
    reportsToAgentId?: string | null;

    // ── AI provider routing ──
    // null = use account default per the existing AiFacadeService cascade.

    @Column({ type: 'varchar', length: 100, nullable: true })
    aiProviderId?: string | null;

    @Column({ type: 'varchar', length: 100, nullable: true })
    modelId?: string | null;

    @Column({ type: 'int', default: 4000 })
    maxSkillContextTokens: number;

    // ── Lifecycle ──

    @Column({ type: 'varchar', length: 16, default: AgentStatus.DRAFT })
    status: AgentStatus;

    @Column('simple-json')
    permissions: AgentPermissions;

    /**
     * Tenant-scoped Agents may carry an explicit memberships list here.
     * `null` (or empty) for tenant-scope = "available to all" the user's
     * Missions/Ideas/Works. Concrete memberships also live in the
     * `agent_memberships` join table for indexed lookup; this column is the
     * authoritative source the UI edits.
     */
    @Column('simple-json', { nullable: true })
    targets?: AgentTarget[] | null;

    // ── Heartbeat ──

    /** Cron expression OR the literal string 'manual'. Null = treated as manual. */
    @Column({ type: 'varchar', length: 64, nullable: true })
    heartbeatCadence?: string | null;

    @Column({ type: 'varchar', length: 16, default: AgentIdleBehavior.PROPOSE })
    idleBehavior: AgentIdleBehavior;

    // H-17: `type: 'timestamp'` is Postgres-only and breaks integration
    // specs that boot under better-sqlite3. `PortableDateColumn` lets
    // TypeORM pick the right column type per dialect.
    @PortableDateColumn({ nullable: true })
    nextHeartbeatAt?: Date | null;

    @PortableDateColumn({ nullable: true })
    lastRunAt?: Date | null;

    @Column({ type: 'varchar', length: 16, nullable: true })
    lastRunStatus?: string | null;

    @Column({ type: 'int', default: 0 })
    errorCount: number;

    @Column({ type: 'int', default: 3 })
    pauseAfterFailures: number;

    // ── Avatar (H3 — all three modes in v1) ──

    @Column({ type: 'varchar', length: 8, default: AgentAvatarMode.INITIALS })
    avatarMode: AgentAvatarMode;

    /** Lucide icon name; populated only when `avatarMode = 'icon'`. */
    @Column({ type: 'varchar', length: 64, nullable: true })
    avatarIcon?: string | null;

    /**
     * FK to `work_knowledge_uploads.id`. Populated only when
     * `avatarMode = 'image'`. Reuses the existing KB upload pipeline so we
     * inherit storage / quota / ACL semantics.
     */
    @Column('uuid', { nullable: true })
    avatarImageUploadId?: string | null;

    // ── DB-only file storage (ADR-008 — tenant Agents without a control repo) ──
    // Mission/Idea/Work-scoped Agents store these in their scope's Git repo at
    // `.works/agents/<slug>/{SOUL,AGENTS,HEARTBEAT,TOOLS}.md` + `agent.yml`;
    // the columns below remain null for those.

    @Column({ type: 'text', nullable: true })
    soulMd?: string | null;

    @Column({ type: 'text', nullable: true })
    agentsMd?: string | null;

    @Column({ type: 'text', nullable: true })
    heartbeatMd?: string | null;

    @Column({ type: 'text', nullable: true })
    toolsMd?: string | null;

    @Column({ type: 'text', nullable: true })
    agentYml?: string | null;

    /** sha256 of the canonical 5-file concatenation; used for ETag / optimistic concurrency. */
    @Column({ type: 'varchar', length: 64, nullable: true })
    contentHash?: string | null;

    // ── FU-13 — git committer identity ──
    // When an Agent commits to a Work's git repo via `AGENT_GIT_FACADE`,
    // these columns populate the commit author. Both nullable: when
    // unset, the binding falls back to the Agent's name (committerName)
    // + a synthesized email (`<slug>@agents.ever.works`) or the User's
    // primary email. Operator can override either independently —
    // e.g. set just `committerEmail` to a real inbox (managed via the
    // forthcoming Email Providers surface — see
    // docs/specs/features/email-providers/spec.md) so commit emails
    // route back to a working address.

    @Column({ type: 'varchar', length: 120, nullable: true })
    committerName?: string | null;

    @Column({ type: 'varchar', length: 254, nullable: true })
    committerEmail?: string | null;

    // ── Scorecard (Agent Scorecards increment 1) ──
    // Quantified per-Agent goals so an AI worker's output is measurable.
    // Nullable JSON array of AgentScorecardMetric; null = no scorecard set.
    // This increment covers the data model + manual editing + display only —
    // auto-updating `current` from run output and the org-dashboard at-risk
    // roll-up are follow-ups.

    @Column('simple-json', { nullable: true })
    scorecard?: AgentScorecardMetric[] | null;

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

    @UpdateDateColumn()
    updatedAt: Date;

    /**
     * Keep `scopeTargetId` in lock-step with the scope FKs on every persist so
     * the durable `uq_agents_user_scope_slug` unique index has a non-null key.
     * Runs on `repository.save()` (the only persistence path AgentRepository
     * uses) for every create site — service, export, and tool-driven creates.
     */
    @BeforeInsert()
    @BeforeUpdate()
    syncScopeTargetId(): void {
        this.scopeTargetId = this.missionId ?? this.ideaId ?? this.workId ?? '';
    }
}
