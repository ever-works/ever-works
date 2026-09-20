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
import { BudgetOwnerType, UsageMeter, UsageOutcome, UsagePayer } from './_types';

export enum PluginUsageCapability {
    AI = 'ai',
    // Agent Plugins (EW-772) — one event per MCP tool invocation. Additive
    // enum value, no migration needed (the column is varchar), matching every
    // other addition to this enum.
    MCP = 'mcp',
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
    // APW-05 T17 (Builds) — the build capability. One event per App Work
    // Build, written by `AppBuildsService.finalize` as the Build's receipt
    // (`units` = the runner's billable minutes, `operation: 'build.run'`, payer
    // `workspace`, `costCents: 0` — GitHub bills the owner's account, not the
    // platform, so the row audits the run and charges no credits; ACC-05-20).
    // Additive enum value, no migration needed (the column is varchar).
    BUILD = 'build',
    // APW-09 T44 (FR-44, ACC-09-33) — the contribution-run capability. The value
    // an App Work's upstream preparation and review follow-up runs are booked
    // under when they go through `BudgetGuardService` against that Work's own
    // budget, so a crossed threshold's alert and the audit row both name what the
    // spend was for. Additive enum value, no migration needed (the column is
    // varchar); a capability with no entry in `priceKeyFor` prices as
    // `<capability>.<operation>`, which is that function's documented default and
    // how `BUILD` already behaves.
    UPSTREAM_CONTRIBUTION = 'upstream_contribution',
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
// window. Migration: `AddCostsDashboardIndexes1786910000000`.
@Index('idx_plugin_usage_events_user_agent_occurred', ['userId', 'agentId', 'occurredAt'])
@Index('idx_plugin_usage_events_user_model_occurred', ['userId', 'modelId', 'occurredAt'])
// AW-17 — the meter cards and the by-tool / by-Mission breakdowns group one
// user's rows (or one Mission's rows) inside a window; each index leads with
// the grouping column for the same planner reason as the two above.
// Migration: `AddUsageMeterClassification1791170000000`.
@Index('idx_plugin_usage_meter_user_occurred', ['userId', 'meter', 'occurredAt'])
@Index('idx_plugin_usage_pricekey_user_occurred', ['userId', 'priceKey', 'occurredAt'])
@Index('idx_plugin_usage_mission_occurred', ['missionId', 'occurredAt'])
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

    /**
     * AW-17 — which of the three meters this unit of spend belongs to,
     * stamped by `PluginUsageService.record()` when the row is written and
     * never re-derived. NULL only on rows recorded before meters were
     * separated; those are reported under their own label and are never
     * back-classified by inference.
     */
    @Column({ type: 'varchar', length: 16, nullable: true })
    meter?: UsageMeter | null;

    /** AW-17 — who paid the provider, resolved at the call. */
    @Column({ type: 'varchar', length: 16, nullable: true })
    payer?: UsagePayer | null;

    /**
     * AW-17 — `ok` / `cached` / `failed`. Cached and failed are zero-rated.
     * A failed call wrote no row before meters existed, so every
     * `PluginUsageRepository` reader that predates them skips `failed` rows
     * (spend, units, day buckets, groups, exports) and only the meter and
     * breakdown reads count them.
     */
    @Column({ type: 'varchar', length: 12, nullable: true })
    outcome?: UsageOutcome | null;

    /**
     * AW-17 — credits this row accounts for. Always 0 for the `model` and
     * `addon` meters and for zero-rated outcomes. For a `per-unit` price-list
     * entry this is the published price; for a `provider-cost` entry it is
     * the provider's own cost at the published conversion (the run's
     * settlement still converts the summed cost, so rounding never drifts).
     *
     * Stamped the same way in both settlement modes. Only in the opt-in
     * `price_list` mode (`CREDITS_SETTLEMENT_MODE`) is a `per-unit` figure what
     * the run is debited; in the default `provider_cost` mode it is what the
     * price list WOULD charge, and the run is debited from `costCents`. The
     * credits actually debited for a run live on its `run:{runId}` ledger row.
     */
    @Column({ type: 'int', default: 0 })
    creditsCharged: number;

    /** AW-17 — `capability.operation` price-list key. Never a Plugin id. */
    @Column({ type: 'varchar', length: 64, nullable: true })
    priceKey?: string | null;

    /**
     * AW-17 — the price-list version whose fixed `per-unit` price priced this
     * row. NULL when no fixed price applied (workspace-owned, provider-cost,
     * or no entry), in which case settlement falls back to the row's
     * provider cost exactly as it did before meters existed. Only read by
     * settlement in the `price_list` mode.
     */
    @Column({ type: 'int', nullable: true })
    priceVersion?: number | null;

    /**
     * AW-17 — the Mission of this row's Task (`tasks.missionId`), captured
     * once per run and denormalised here so a by-Mission breakdown is one
     * grouped read. Never `agents.missionId`: an Agent scoped to one Mission
     * can work a Task filed against another. NULL when the run had no Task
     * (heartbeat, chat without a Task) or the Task names no Mission. No FK —
     * audit rows outlive a deleted Mission, like `agentId` / `taskId` /
     * `runId` above.
     */
    @Column({ type: 'uuid', nullable: true })
    missionId?: string | null;

    @CreateDateColumn()
    occurredAt: Date;
}
