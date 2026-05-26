import {
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
 * - `IMAGE`    — uploaded image (FK to `work_knowledge_upload`). Requires the
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
@Index('uq_agents_user_scope_slug', ['userId', 'scope', 'missionId', 'ideaId', 'workId', 'slug'], {
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

    @Column({ length: 120 })
    name: string;

    /** Kebab-case derived from `name`; unique per scope (see composite index). */
    @Column({ length: 80 })
    slug: string;

    @Column({ length: 200, nullable: true })
    title?: string | null;

    @Column({ type: 'text', nullable: true })
    capabilities?: string | null;

    // ── AI provider routing ──
    // null = use account default per the existing AiFacadeService cascade.

    @Column({ length: 100, nullable: true })
    aiProviderId?: string | null;

    @Column({ length: 100, nullable: true })
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

    @Column({ type: 'timestamp', nullable: true })
    nextHeartbeatAt?: Date | null;

    @Column({ type: 'timestamp', nullable: true })
    lastRunAt?: Date | null;

    @Column({ length: 16, nullable: true })
    lastRunStatus?: string | null;

    @Column({ type: 'int', default: 0 })
    errorCount: number;

    @Column({ type: 'int', default: 3 })
    pauseAfterFailures: number;

    // ── Avatar (H3 — all three modes in v1) ──

    @Column({ type: 'varchar', length: 8, default: AgentAvatarMode.INITIALS })
    avatarMode: AgentAvatarMode;

    /** Lucide icon name; populated only when `avatarMode = 'icon'`. */
    @Column({ length: 64, nullable: true })
    avatarIcon?: string | null;

    /**
     * FK to `work_knowledge_upload.id`. Populated only when
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
    @Column({ length: 64, nullable: true })
    contentHash?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
