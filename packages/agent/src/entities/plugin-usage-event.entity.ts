import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    ManyToOne,
    JoinColumn,
    CreateDateColumn,
    Index,
} from 'typeorm';
import type { ClassToObject } from './types';
import { User } from './user.entity';
import { Work } from './work.entity';
// Import from the leaf-types file (NOT from work-budget.entity) — see
// `_types.ts` for the cycle-break rationale.
import { BudgetOwnerType } from './_types';

export enum PluginUsageCapability {
    AI = 'ai',
    SEARCH = 'search',
    SCREENSHOT = 'screenshot',
    EXTRACTOR = 'extractor',
    // Notifications v2 (EW-650 + EW-663) — additive enum values, no
    // migration needed (column is varchar). Email-outbound plugins emit
    // EMAIL; notification-channel plugins emit NOTIFICATION_CHANNEL.
    EMAIL = 'email',
    NOTIFICATION_CHANNEL = 'notification_channel',
    // Goals feature PR-7 — metrics-provider capability (custom-http,
    // Stripe; PostHog + GA in PR-9). Additive enum value, no migration
    // needed (column is varchar). Recorded best-effort by
    // MetricsFacadeService after each provider call.
    METRICS = 'metrics',
}

@Index(['workId', 'occurredAt'])
@Index(['workId', 'capability', 'pluginId', 'occurredAt'])
@Index(['userId', 'occurredAt'])
@Index('idx_plugin_usage_events_owner', ['ownerType', 'ownerId'])
// Agents/Skills/Tasks (PR #1017): per-Agent spend aggregator filter.
// Migration `AddAgentIdToPluginUsageEvents1779978011000` adds the column +
// index. No FK to `agents` — archiving an Agent must NOT delete audit rows.
@Index('idx_plugin_usage_events_agent_occurred', ['agentId', 'occurredAt'])
// Tasks feature — Phase 11.4 (`features/task-tracking/plan.md §3.2`).
// Per-Task spend aggregator filter. Migration
// `AddTaskIdToPluginUsageEvents1779978014000` adds the column + index.
// No FK to `tasks` — task delete must NOT cascade-drop audit rows.
@Index('idx_plugin_usage_events_task_occurred', ['taskId', 'occurredAt'])
// Pricing Wave 9 M2 — per-run cost accumulation filter. Migration
// `AddRunIdToPluginUsageEvents1783600000000` adds the column + index.
// No FK to `agent_runs` — run deletion must NOT cascade-drop audit rows.
@Index('idx_plugin_usage_events_run_occurred', ['runId', 'occurredAt'])
// Costs dashboard — the per-agent and per-model account-wide rollups
// group one user's events inside a date window. `(userId, occurredAt)`
// above narrows the window; leading with the grouping column lets the
// planner satisfy the GROUP BY from the index instead of sorting the
// window. Migration: `AddCostsDashboardIndexes1785010000000`.
@Index('idx_plugin_usage_events_user_agent_occurred', ['userId', 'agentId', 'occurredAt'])
@Index('idx_plugin_usage_events_user_model_occurred', ['userId', 'modelId', 'occurredAt'])
@Entity({ name: 'plugin_usage_events' })
export class PluginUsageEvent {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    workId: string;

    @ManyToOne(() => Work, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'workId' })
    work: ClassToObject<Work>;

    @Column()
    userId: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user: ClassToObject<User>;

    @Column({ type: 'varchar', length: 128 })
    pluginId: string;

    @Column({ type: 'varchar', length: 32 })
    capability: PluginUsageCapability;

    @Column({ type: 'int', default: 1 })
    units: number;

    @Column({ type: 'int', default: 0 })
    costCents: number;

    @Column({ type: 'varchar', length: 8, default: 'usd' })
    currency: string;

    @Column({ type: 'varchar', length: 128, nullable: true })
    modelId?: string | null;

    @Column({ type: 'varchar', length: 128, nullable: true })
    requestId?: string | null;

    @Column({ type: 'json', nullable: true })
    metadata?: Record<string, any> | null;

    /**
     * Per-Agent attribution (Agents/Skills/Tasks PR #1017, agents/plan.md
     * §3.2). Populated by `AgentRunService.execute()` when the AI call is
     * made inside an Agent's heartbeat / task / chat run. Null for non-
     * Agent calls (the existing Work-generator flow).
     */
    @Column({ type: 'uuid', nullable: true })
    agentId?: string | null;

    /**
     * Per-Task attribution (Tasks Phase 11.4). Populated when a
     * plugin usage event is recorded inside an Agent run that was
     * triggered by a Task (`taskId` from `AgentRun.taskId`). Null
     * for non-Task usage. No FK — task delete must preserve audit.
     */
    @Column({ type: 'uuid', nullable: true })
    taskId?: string | null;

    /**
     * Per-run attribution (pricing Wave 9 M2). Populated when the call
     * was made inside an `AgentRun` (threaded through
     * `FacadeOptions.runId` by the run's AI-dispatch + tool
     * pass-through adapters). The run-cost accumulator sums
     * `costCents` over rows tagged with this id at run-terminal time
     * to stamp `agent_runs.costCents` and emit the credits debit. Null
     * for calls made outside a run. No FK — audit rows outlive runs.
     */
    @Column({ type: 'uuid', nullable: true })
    runId?: string | null;

    /**
     * Polymorphic-owner discriminator (Missions/Ideas/Works spec §8.2).
     * Backfilled to `'work'` by Phase 0 PR 0.3 for existing rows.
     */
    @Column({ type: 'varchar', length: 16, default: BudgetOwnerType.WORK })
    ownerType: BudgetOwnerType;

    /**
     * UUID of the owning Work / Idea / Mission. Backfilled to
     * `workId` for existing rows. See `WorkBudget.ownerId` for
     * full rationale.
     */
    @Column({ type: 'uuid', nullable: true })
    ownerId?: string | null;

    // Tenant + Organization scope FKs (EW-657 Tier C denormalization).
    // No @ManyToOne — cycle-avoidance, see user.entity.ts EW-654 comment.
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    occurredAt: Date;
}
