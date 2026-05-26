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
import type { WorkAgentGuardrails } from './work-agent-preference.entity';

/**
 * Mission lifecycle states (spec §1.3).
 *
 * `ACTIVE`   — running (one-shot in-progress, or scheduled and ticking).
 * `PAUSED`   — user paused; tick worker skips this Mission.
 * `COMPLETED`— user marked done; archived but visible in history.
 * `FAILED`   — generation loop hit a fatal (non-transient) error.
 */
export enum MissionStatus {
    ACTIVE = 'active',
    PAUSED = 'paused',
    COMPLETED = 'completed',
    FAILED = 'failed',
}

/**
 * Whether a Mission ticks on a schedule or only when the user runs
 * it manually (spec §1.3).
 *
 * `ONE_SHOT`  — user pushes it forward via `POST /me/missions/:id/run-now`;
 *               no cron.
 * `SCHEDULED` — Trigger.dev cron tick fires per `Mission.schedule` cadence.
 */
export enum MissionType {
    ONE_SHOT = 'one-shot',
    SCHEDULED = 'scheduled',
}

/**
 * Per-Mission policy overrides for the Idea→Work build pipeline.
 *
 * Falls through to the user's global `WorkAgentPreference` for any
 * field left undefined. This is the Mission's analogue of
 * `WorkAgentGoal.guardrailsOverride` — same shape, same fall-through
 * semantics — but applied to every Idea this Mission spawns.
 */
export type MissionGuardrailsOverride = Partial<WorkAgentGuardrails>;

/**
 * A long-running Goal/Project that continuously drives Idea generation
 * and (via Ideas) Work creation (spec §1.3, §4).
 *
 * Cardinality: 1 Mission → many Ideas → many Works. Each child Idea
 * carries `Idea.missionId = this.id` (see `WorkProposal.missionId`,
 * added in Phase 0 PR 0.1).
 *
 * Lifetime: ongoing. Unlike Ideas (one-shot) and Works
 * (self-updating-on-schedule), Missions are the most ambitious
 * abstraction — they keep generating Ideas until the user marks them
 * complete, pauses them, or they fail.
 *
 * The Mission detail page reads this entity plus its derived
 * children (Ideas via `missionId` FK; Works transitively via the
 * Ideas' `acceptedWorkId`). The Mission tick worker (Phase 3 PR J)
 * polls every Mission with `status = ACTIVE` and `type = SCHEDULED`
 * and a cron that matches the current minute.
 *
 * Phase-0 note: `sourceMissionId` (self-FK for Mission Clone full
 * fork, Decision A25) is introduced in a later migration (PR 0.10).
 * It is intentionally NOT declared on this entity here so that the
 * Phase 0 migration sequence can land one column per PR for clean
 * reviewability.
 */
@Entity({ name: 'missions' })
@Index('idx_missions_user_status', ['userId', 'status'])
export class Mission {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column('uuid')
    userId: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user?: User;

    /**
     * Short title — AI-generated from the prompt at create time, then
     * editable by the user. See spec §1.3 "Title" + the shared titler
     * service (PR I).
     */
    @Column({ type: 'varchar', length: 200 })
    title: string;

    /**
     * Long-form Goal/Project description — the user's prompt. This is
     * what the tick worker feeds to the proposal generator as the
     * Mission's `missionContext` so spawned Ideas stay on-theme.
     */
    @Column({ type: 'text' })
    description: string;

    @Column({ type: 'varchar', length: 16 })
    type: MissionType;

    @Column({ type: 'varchar', length: 16, default: MissionStatus.ACTIVE })
    status: MissionStatus;

    /**
     * Cron expression; required when `type = SCHEDULED`, must be NULL
     * when `type = ONE_SHOT`. The Mission tick dispatcher (Phase 3
     * PR J) reads this to decide which Missions are due on the
     * current tick.
     */
    @Column({ type: 'varchar', length: 64, nullable: true })
    schedule?: string | null;

    /**
     * Per-Mission override of the global Auto-build Works setting.
     * When `true`, every Idea this Mission spawns is immediately
     * queued for build (creates a `WorkAgentGoal` with
     * `maxWorksPerRun = 1` + `ideaId`). When `false`, spawned Ideas
     * stay PENDING for the user to act on.
     */
    @Column({ type: 'boolean', default: false })
    autoBuildWorks: boolean;

    /**
     * Soft cap on how many `PENDING` / `QUEUED` / `BUILDING` Ideas
     * this Mission can have outstanding (spec §1.3). When the cap is
     * reached and the user has NOT set this to "unlimited", scheduled
     * ticks skip the generation step and emit an `at-cap` event into
     * the Mission's activity log.
     *
     * Semantics:
     *   - positive int → that's the cap.
     *   - NULL         → inherit user-level default from
     *                    `WorkAgentPreference.missionDefaultOutstandingCap`
     *                    (added in PR 0.4).
     *   - negative int → "unlimited" sentinel (we use `-1` in code so
     *                    SQL can `IS NOT NULL` to differentiate from
     *                    inherit).
     */
    @Column({ type: 'int', nullable: true })
    outstandingIdeasCap?: number | null;

    /**
     * Sparse override of the user's global `WorkAgentGuardrails`,
     * applied only to Ideas spawned by THIS Mission. Any field
     * omitted falls through to the global value at build time.
     *
     * Stored as `simple-json` to match how the rest of the
     * `work-agent` module persists the same shape on
     * `WorkAgentGoal.guardrailsOverride`.
     */
    @Column('simple-json', { nullable: true })
    guardrailsOverride?: MissionGuardrailsOverride | null;

    /**
     * Optional reference to the Mission Template this Mission was
     * scaffolded from. Example: `ever-works/p2p-marketplace-mission-template`.
     * Used by the Mission detail page to surface a "from template"
     * affordance and (Phase 8 PR JJ) to read the template's
     * `.works/mission.yml` manifest at scaffold time.
     */
    @Column({ type: 'varchar', length: 200, nullable: true })
    missionTemplateRepo?: string | null;

    /**
     * The per-Mission GitHub repo where the agent keeps this
     * Mission's running brain — KB, plans, logs, references to
     * spawned Works' `-data` repos. Example: `ever-works/cats-business-mission`.
     *
     * Created at Mission-create time by the Mission repo scaffolder
     * (Phase 8 PR X) using `gitFacade.createRepository()` — same
     * destination org/account as the user's existing `-data` Work
     * repos (Decision A8). Missions without a Template still get a
     * repo seeded from a generic baseline so the agent always has a
     * place to persist state.
     */
    @Column({ type: 'varchar', length: 200, nullable: true })
    missionRepo?: string | null;

    /**
     * Self-FK for Mission Clone traceability (spec §4.4a +
     * Decision A25). When a Mission was created via Full-Fork
     * Clone of another Mission (`POST /me/missions/:id/clone`,
     * Phase 3 PR HH), this points back at the source. NULL for
     * Missions created directly (the common case).
     *
     * UI usage:
     *   - Cloned Mission detail page renders "Cloned from: [source
     *     title]" backlink in the header.
     *   - Source Mission detail page renders "Cloned as: N other
     *     Mission(s)" with a popover listing the clones — query
     *     uses this same FK reversed.
     *
     * Also used by Phase 6 PR GG's "Related Works (inherited from
     * source Mission)" panel on the cloned Mission's detail page
     * (read-only references to the source's Works — those are NOT
     * duplicated during Clone per Decision A25).
     *
     * ON DELETE SET NULL: deleting the source Mission breaks the
     * back-link but leaves the clone intact.
     */
    @Column({ type: 'uuid', nullable: true })
    sourceMissionId?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
