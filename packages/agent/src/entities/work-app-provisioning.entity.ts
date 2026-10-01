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
import type {
    AppProvisioningAttempt,
    AppProvisioningDetectionSource,
    AppProvisioningFailureReason,
    AppProvisioningParkReason,
    AppProvisioningQuestionReason,
    AppProvisioningStatus,
    AppProvisioningStep,
    AppProvisioningStepState,
    AppProvisioningTrigger,
} from '@ever-works/contracts';
import { Work } from './work.entity';
import { ClassToObject } from './types';
import { PortableDateColumn } from './_types';

/**
 * App Works — one provisioning of one App Work (APW-04 T7).
 *
 * Spec: `docs/specs/features/app-works/APW-04-app-provisioner/spec.md` (§5.2 the
 * new entity, §5.3 states and transitions, §4.9 the caps).
 * Plan: `…/plan.md` §3.1 (`plan.md:346-398`) is the normative column list — this
 * file implements it column for column, with the six indexes the plan fixes at
 * `:387-394`. Migration: `apps/api/src/migrations/1792040000000-CreateWorkAppProvisionings.ts`
 * (T8). Repository: `packages/agent/src/database/repositories/work-app-provisioning.repository.ts`
 * (T7).
 *
 * ## Derived state only (Constitution III)
 *
 * Every column here is something the platform DERIVED from a run: the step
 * states, the attempts, the spend, the question, the lease. Nothing a person
 * types is stored except `note`, which is fenced as user input before it reaches
 * the agent (plan §7.5) — and no column holds a secret value. `questionParams`
 * and `lastRunOutput` are the two that could: the first is names and numbers
 * only (≤ 1 KB, `scanForSecrets`-ed, §3.1:370), the second is the last session's
 * `provision-output` block, which §7.6's guard reads and then clears.
 *
 * ## One ACTIVE row per App Work — a PARTIAL unique, deliberately
 *
 * `uq_work_app_provisionings_active` is UNIQUE `(workId)` **WHERE `status IN
 * ('queued','running','needs_input')`**. A plain unique would make the second
 * provisioning of an App Work impossible after the first one ever ran, and the
 * whole epic is about re-provisioning (FR-59, §4.12). The partial predicate is
 * the only thing that lets history accumulate while ACC-04-03 holds: two
 * concurrent starts of one Work yield ONE row.
 *
 * TypeORM renders the `where` clause on **PostgreSQL and the SQLite family**,
 * both of which support partial indexes — the same treatment the platform
 * already uses for `uq_org_invitations_pending_email`
 * (`1786930000000-CreateOrganizationInvitationsAndMembers.ts`) and
 * `uq_conversation_messages_client_id`
 * (`1791120000000-AddConversationKindAndParticipants.ts`). MySQL and MariaDB
 * have no partial index at all; TypeORM emits the index without the predicate
 * there, and the uniqueness of an ACTIVE row is then enforced by the service's
 * compare-and-set plus the lost-insert race path T50 owns — it is asserted in
 * `packages/agent/src/database/repositories/__tests__/work-app-provisioning.repository.spec.ts`
 * on the driver this programme actually runs (better-sqlite3), exactly as
 * APW-05's T6 recorded for its own SQLite-only legs.
 *
 * ## `taskId` and `agentId` carry NO foreign key
 *
 * The entity-cycle rule (`plan.md:356`): a `@ManyToOne(() => Task)` here would
 * drag the Task entity graph into the decorator evaluation of the whole
 * inventory, and a Task row is deleted on its own schedule — a provisioning's
 * record of what it did must not go with it. `workId` IS a relation, because the
 * row describes the Work and has no meaning without it (`ON DELETE CASCADE`).
 *
 * ## Scope columns, and why they carry no relation
 *
 * `tenantId` / `organizationId` are plain nullable uuids with no `@ManyToOne`
 * (EW-654/EW-655): a relation here drags the Tenant/Organization entity graph
 * into the decorator evaluation of the whole inventory. They exist as the
 * per-org cap's index (`idx_work_app_provisionings_org_status`) and for R-25's
 * export, not as joins.
 *
 * ## Every date is a `PortableDateColumn`
 *
 * Plan §3.1:383 names the type for this table. A raw `timestamp` column is
 * `timestamptz` on PostgreSQL and `datetime` on SQLite, and better-sqlite3
 * rejects the type at BOOT; `PortableDateColumn` stores `type: Date` and lets
 * each driver pick its own spelling, which is what the migration creates. The
 * two audit stamps keep the repository-wide `@CreateDateColumn` /
 * `@UpdateDateColumn` helpers — they are the same `Date` type and they are the
 * rows' `CURRENT_TIMESTAMP` defaults in the migration.
 *
 * ## Closed sets come from `@ever-works/contracts`
 *
 * `status`, `trigger`, `queuedReason`, `step`, `detectionSource`,
 * `failureReason`, `questionReason` and `parkedReason` are typed by the unions
 * and aliases of `packages/contracts/src/apps/app-provisioning.ts` (T6), so a
 * state the API can render is a state the column can hold, and a member added to
 * a contract union is a type error here rather than a silent cast.
 *
 * ## R-25 (workspace backup)
 *
 * Exported as `data/works/app-provisionings.jsonl` through the parent Work ids
 * (plan §3:344).
 */
@Entity({ name: 'work_app_provisionings' })
@Index('uq_work_app_provisionings_active', ['workId'], {
    unique: true,
    where: "status IN ('queued', 'running', 'needs_input')",
})
@Index('uq_work_app_provisionings_task', ['taskId'], {
    unique: true,
    where: '"taskId" IS NOT NULL',
})
@Index('idx_work_app_provisionings_user_status', ['userId', 'status'])
@Index('idx_work_app_provisionings_org_status', ['organizationId', 'status'])
@Index('idx_work_app_provisionings_expiry', ['verificationExpiresAt'])
@Index('uq_work_app_provisionings_suggestion', ['suggestionUpstream'], {
    unique: true,
    where: '"suggestionState" = \'queued\'',
})
export class WorkAppProvisioning {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** The App Work being provisioned. At most one ACTIVE row — see the class docstring. */
    @Column({ type: 'uuid' })
    workId: string;

    @ManyToOne(() => Work, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'workId' })
    work?: ClassToObject<Work>;

    /** The starter; the question's recipient (the owner, for an automatic start). */
    @Column({ type: 'uuid' })
    userId: string;

    /** The provisioning Task the runner drives. NO foreign key — see the class docstring. */
    @Column({ type: 'uuid', nullable: true })
    taskId?: string | null;

    /** The App Agent template instantiated for this run. NO foreign key. */
    @Column({ type: 'uuid', nullable: true })
    agentId?: string | null;

    /** `auto-create` · `manual` · `chat` · `upstream-smoke` · `auto-upstream-smoke`. */
    @Column({ type: 'varchar', length: 24 })
    trigger: AppProvisioningTrigger;

    /** `queued` · `running` · `needs_input` · `succeeded` · `merged` · `failed` · `cancelled`. */
    @Column({ type: 'varchar', length: 16 })
    status: AppProvisioningStatus;

    /** `user-limit` · `org-limit` — set only while the row waits for a slot (FR-44). */
    @Column({ type: 'varchar', length: 24, nullable: true })
    queuedReason?: 'user-limit' | 'org-limit' | null;

    /** The §2.5 step the row is on. */
    @Column({ type: 'varchar', length: 16, default: 'repository' })
    step: AppProvisioningStep;

    /**
     * `Record<Step, { state, startedAt?, finishedAt?, noteKey?, noteParams? }>` —
     * the whole §2.5 table, stored as it is drawn. `AppProvisioningView.stepStates`
     * is this object mapped through the controller's date conversion.
     */
    @Column({ type: 'simple-json', nullable: true })
    stepStates?: Record<
        AppProvisioningStep,
        {
            state: AppProvisioningStepState;
            startedAt?: string;
            finishedAt?: string;
            noteKey?: string;
            noteParams?: Record<string, string | number>;
        }
    > | null;

    /** `app-spec` · `compose` · `dockerfile` · `helm` · `descriptor-hint` · `auto` (R-13). */
    @Column({ type: 'varchar', length: 24, nullable: true })
    detectionSource?: AppProvisioningDetectionSource | null;

    /** Set on `merged` — the card's verified/unverified distinction (spec §5.3). */
    @Column({ type: 'boolean', nullable: true })
    verified?: boolean | null;

    /** Spec §5.3's closed set, including `private-repository`. */
    @Column({ type: 'varchar', length: 40, nullable: true })
    failureReason?: AppProvisioningFailureReason | null;

    /** The commit the run started from. */
    @Column({ type: 'varchar', length: 64, nullable: true })
    baseSha?: string | null;

    /** The commit the run wrote. */
    @Column({ type: 'varchar', length: 64, nullable: true })
    headSha?: string | null;

    /** The App-spec pull request's number, and its URL. */
    @Column({ type: 'int', nullable: true })
    prNumber?: number | null;

    @Column({ type: 'varchar', length: 512, nullable: true })
    prUrl?: string | null;

    /** At most 9 attempts (`APP_PROVISION_LIMITS.attemptsCeiling`), oldest first. */
    @Column({ type: 'simple-json', nullable: true })
    attempts?: AppProvisioningAttempt[] | null;

    /** The budget the row started with; `attemptsPerAnswer` may extend it (≤ 9). */
    @Column({ type: 'int', default: 3 })
    attemptBudget: number;

    /** Advanced by compare-and-set ONLY — see the repository's `casAttemptsUsed`. */
    @Column({ type: 'int', default: 0 })
    attemptsUsed: number;

    /** How many questions the row has asked; `questionsMax` is 3. */
    @Column({ type: 'int', default: 0 })
    questionsAsked: number;

    /** The open Inbox item. Never on the wire except as `question.inboxItemId`. */
    @Column({ type: 'uuid', nullable: true })
    openInboxItemId?: string | null;

    @PortableDateColumn({ nullable: true })
    questionAskedAt?: Date | null;

    @PortableDateColumn({ nullable: true })
    questionRemindedAt?: Date | null;

    /**
     * One of `APP_PROVISIONING_QUESTION_REASONS`. Set with `openInboxItemId` in
     * the same patch and cleared on `answered` or any terminal state (§3.1:370).
     */
    @Column({ type: 'varchar', length: 24, nullable: true })
    questionReason?: AppProvisioningQuestionReason | null;

    /**
     * The question's params — **names only** (`variable`, `step`, `attempts`,
     * `candidates`, `reasonCode`, `fingerprint`), ≤ 1 KB, `scanForSecrets`-ed,
     * never a value (§3.1:370).
     */
    @Column({ type: 'simple-json', nullable: true })
    questionParams?: Record<string, string | number> | null;

    /** Tokens spent. `bigint` on every driver, so a 10,000,000 cap fits exactly. */
    @Column({ type: 'bigint', default: 0 })
    tokensUsed: number;

    /** `tokenCapDefault` is 3,000,000; the range is 500,000 … 10,000,000. */
    @Column({ type: 'bigint', default: 3_000_000 })
    tokenCap: number;

    /** Runner minutes spent; `runnerMinuteCapDefault` is 240. */
    @Column({ type: 'int', default: 0 })
    runnerMinutesUsed: number;

    @Column({ type: 'int', default: 240 })
    runnerMinuteCap: number;

    /**
     * Active milliseconds: accrues outside `needs_input` and while the row is
     * not parked, and the 8-hour deadline is measured against it (R-17).
     */
    @Column({ type: 'bigint', default: 0 })
    activeMs: number;

    /** `kill-switch` · `agent-paused` · `workspace-paused` · `scope-paused` (R-17 waits). */
    @Column({ type: 'varchar', length: 24, nullable: true })
    parkedReason?: AppProvisioningParkReason | null;

    @PortableDateColumn({ nullable: true })
    parkedAt?: Date | null;

    /** Up to 16 session run ids, oldest first. */
    @Column({ type: 'simple-json', nullable: true })
    runIds?: string[] | null;

    /** Up to 9 Build ids, oldest first — one per attempt. */
    @Column({ type: 'simple-json', nullable: true })
    buildIds?: string[] | null;

    /**
     * The last session's `provision-output` block, ≤ 512 KB
     * (`APP_PROVISION_LIMITS.outputMaxBytes`), cleared once §7.6's guard has read
     * it (§2.6). 🛑 `mediumtext` is required on MySQL/MariaDB for a 512 KB value;
     * see the report's routed items — the declaration is portable `text` on
     * purpose, because a per-driver column type is a driver branch.
     */
    @Column({ type: 'text', nullable: true })
    lastRunOutput?: string | null;

    /** `cluster` · `runner` — which target verified this run (§2.4). */
    @Column({ type: 'varchar', length: 16, nullable: true })
    verificationTargetKind?: 'cluster' | 'runner' | null;

    /** The ephemeral namespace the cluster target holds. **Never on the wire.** */
    @Column({ type: 'varchar', length: 63, nullable: true })
    verificationNamespace?: string | null;

    /** The namespace's TTL — the sweeper's input (`idx_work_app_provisionings_expiry`). */
    @PortableDateColumn({ nullable: true })
    verificationExpiresAt?: Date | null;

    /** The Task conversation the milestones are posted to. **Never on the wire.** */
    @Column({ type: 'uuid', nullable: true })
    conversationId?: string | null;

    /** Capped at `APP_PROVISION_LIMITS.chatMessagesMax` (12). */
    @Column({ type: 'int', default: 0 })
    chatMessagesPosted: number;

    /** "Anything to tell the agent" (≤ 500) — fenced as user input before it reaches the model. */
    @Column({ type: 'varchar', length: 500, nullable: true })
    note?: string | null;

    /** The upstream range an `upstream-smoke` trigger covers; surfaced only as `upstreamSmokeBroken`. */
    @Column({ type: 'varchar', length: 64, nullable: true })
    upstreamFromSha?: string | null;

    @Column({ type: 'varchar', length: 64, nullable: true })
    upstreamToSha?: string | null;

    /** The §4.13 Blueprint suggestion's state. `queued` is what the partial unique guards. */
    @Column({ type: 'varchar', length: 16, nullable: true })
    suggestionState?: string | null;

    /** The upstream a suggestion was made for. **Never on the wire.** */
    @Column({ type: 'varchar', length: 200, nullable: true })
    suggestionUpstream?: string | null;

    @PortableDateColumn({ nullable: true })
    suggestedAt?: Date | null;

    /** The scrubbed bundle, ≤ 256 KB. **Never on the wire.** */
    @Column({ type: 'simple-json', nullable: true })
    suggestionBundle?: Record<string, unknown> | null;

    /** The step executor's lease token (a uuid string) and its expiry — 5 minutes. */
    @Column({ type: 'varchar', length: 36, nullable: true })
    lease?: string | null;

    @PortableDateColumn({ nullable: true })
    leaseExpiresAt?: Date | null;

    @PortableDateColumn({ nullable: true })
    startedAt?: Date | null;

    @PortableDateColumn({ nullable: true })
    finishedAt?: Date | null;

    // EW-655 (Tenants & Organizations Phase 3) — Tier A scope stamps, plain
    // columns with no relation (see the class docstring).
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
