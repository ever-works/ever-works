import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import type { PromotionGateVerdict, PromotionRung, PromotionState } from '@ever-works/contracts';
import { PortableDateColumn } from './_types';

/**
 * Release promotion lane (self-build slice AI, EW-808) — one row per
 * attempt to move a Work's code one rung along `develop → stage → main`.
 *
 * ## Why this exists as its own row
 *
 * The Task carries the pull request (`prNumber`, `prUrl`, `prHeadSha`)
 * and is what a human looks at. It cannot carry the two things a
 * promotion needs that a Task has no shape for:
 *
 *   1. **Lane occupancy.** "There is already an open `develop → stage`
 *      promotion for this Work" has to be a DATABASE fact, not a query
 *      result, or two merges to `develop` seconds apart open two
 *      competing pull requests. See {@link ReleasePromotion.laneKey}.
 *   2. **A gate verdict bound to a commit.** The Task caches a rolled-up
 *      `ciState` over every check; a promotion needs ONE named workflow's
 *      answer, stamped with the commit it was about, so a verdict cannot
 *      outlive the head it was given for.
 *
 * ## What a row does NOT do
 *
 * It does not merge anything, and it does not know about the next rung.
 * A promotion that reaches `merged` frees its lane and stops. Opening
 * `stage → main` after a `develop → stage` lands is a separate,
 * separately-approved human act — there is deliberately no column here
 * that could hold "and then".
 *
 * Merging a promotion pull request goes through the SAME path as every
 * other agent merge: the Task's `merge_pull_request` Inbox approval
 * (slice AE), verified against the live head at merge time. This row only
 * ever NARROWS that: `gateVerdict` must be an explicit `success` for the
 * exact head being merged, or the merge gate stands down.
 *
 * Scope columns are raw uuid references (no @ManyToOne) per the EW-654
 * cycle-avoidance rule; FKs live in the migration
 * (`1790000000000-CreateReleasePromotions`).
 *
 * NOTE: also registered in `database/_entities-inventory.ts` and
 * `_entity-names.ts` — this repo has no `autoLoadEntities`, so a
 * forFeature'd-but-unregistered entity throws EntityMetadataNotFoundError
 * on first query.
 */
@Entity({ name: 'release_promotions' })
@Index('uq_release_promotions_lane', ['workId', 'rung', 'laneKey'], { unique: true })
@Index('idx_release_promotions_task', ['taskId'])
@Index('idx_release_promotions_work_state', ['workId', 'state'])
export class ReleasePromotion {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** Owner of the Work, the Task and the pull request. Scopes every read. */
    @Column({ type: 'uuid' })
    userId: string;

    /** The Work whose repository and release ladder this promotion used. */
    @Column({ type: 'uuid' })
    workId: string;

    /**
     * The Task that reports this promotion's progress and carries the
     * pull request the merge gate acts on. NULL only in the window
     * between claiming the lane and filing the Task.
     */
    @Column({ type: 'uuid', nullable: true })
    taskId?: string | null;

    /** Which rung: `develop-to-stage` or `stage-to-main`. */
    @Column({ type: 'varchar', length: 32 })
    rung: PromotionRung;

    /**
     * The branches this promotion CLAIMS, resolved from the Work's ladder
     * at open time and never from the caller.
     *
     * Recorded rather than re-derived on every refresh so that a ladder
     * edited underneath a live promotion is caught: the refresh compares
     * the provider's live `head`/`base` against THESE, and refuses if
     * either moved.
     */
    @Column({ type: 'varchar', length: 128 })
    headBranch: string;

    @Column({ type: 'varchar', length: 128 })
    baseBranch: string;

    /**
     * The commit the promotion currently reports — the head branch's tip
     * when the pull request was opened, and thereafter whatever the
     * provider says the pull request's head is.
     *
     * When this changes, {@link gateVerdict} is CLEARED: a verdict is
     * about a commit, and the new one has not been judged. Any human
     * approval is invalidated at the same time for free, because the AE
     * subject key (`merge:<taskId>:<prNumber>:<headSha>`) contains it.
     */
    @Column({ type: 'varchar', length: 64, nullable: true })
    headSha?: string | null;

    /** When {@link headSha} was last set to a NEW value — the grace clock. */
    @PortableDateColumn({ nullable: true })
    headRecordedAt?: Date | null;

    @Column({ type: 'int', nullable: true })
    prNumber?: number | null;

    @Column({ type: 'varchar', length: 2048, nullable: true })
    prUrl?: string | null;

    /** `open` | `merged` | `closed` | `refused`. */
    @Column({ type: 'varchar', length: 16, default: 'open' })
    state: PromotionState;

    /**
     * The third column of the UNIQUE `(workId, rung, laneKey)` index, and
     * the whole anti-duplicate guarantee.
     *
     * Postgres could express "at most one open promotion per (Work, rung)"
     * as a partial unique index; better-sqlite3 — which CI and the e2e
     * stack run — cannot, and a constraint that behaves differently on the
     * two databases is a race that only reproduces in production. So the
     * constraint is carried in a VALUE: every live promotion writes the
     * literal `'open'` and therefore collides, and every terminal one
     * writes `'<state>:<id>'` and therefore does not.
     *
     * Written only through `promotionLaneKey()`. Never edited by hand.
     */
    @Column({ type: 'varchar', length: 64, default: 'open' })
    laneKey: string;

    /** Workflow file whose verdict this promotion waits on. */
    @Column({ type: 'varchar', length: 128 })
    gateWorkflow: string;

    /**
     * The last reading of {@link gateWorkflow}: `success` | `failure` |
     * `pending` | `cancelled` | `skipped` | `absent` | `unreadable`.
     *
     * NULL means "not read yet". Only an explicit `success` is a pass,
     * and only while {@link gateVerdictSha} equals the head being merged.
     */
    @Column({ type: 'varchar', length: 16, nullable: true })
    gateVerdict?: PromotionGateVerdict | null;

    /**
     * The commit {@link gateVerdict} was read for.
     *
     * Kept beside the verdict rather than assumed equal to
     * {@link headSha}, so a verdict can never be silently re-used for a
     * commit it was not about: the merge guard compares this against the
     * LIVE head and refuses when they differ.
     */
    @Column({ type: 'varchar', length: 64, nullable: true })
    gateVerdictSha?: string | null;

    /**
     * Was the gate's E2E leg WAIVED rather than green for
     * {@link gateVerdictSha}?
     *
     * `promotion-gate.yml` exits 0 on the `override-e2e-gate` label in
     * every one of its failure branches — a broken lookup, no run, a run
     * still going and a red run — and GitHub then folds the whole thing
     * back into a plain `success` conclusion. Read from the run alone,
     * "the E2E was green" and "somebody with repository write applied a
     * label" are byte-for-byte identical, and the person deciding a
     * production release would be told the first when the second happened.
     *
     * So the label is read off the pull request beside the run and
     * recorded here. It does not change the verdict — the override is a
     * deliberate, documented escape hatch and refusing it would only get
     * the lane routed around — it changes what the human is TOLD.
     *
     * `false` also means "no label on the read we did", which is why it
     * only ever adds a warning and never grants anything.
     */
    @Column({ type: 'boolean', default: false })
    gateOverridden: boolean;

    @PortableDateColumn({ nullable: true })
    gateCheckedAt?: Date | null;

    /** Deep link to the gate run, for the operator who has to read the log. */
    @Column({ type: 'varchar', length: 2048, nullable: true })
    gateRunUrl?: string | null;

    /**
     * Why this promotion was refused, when `state` is `refused`.
     * Free-form short code (`ladder-not-configured`, `branches-moved`,
     * `head-branch-missing`, …) reported into the Task verbatim.
     */
    @Column({ type: 'varchar', length: 64, nullable: true })
    refusalCode?: string | null;

    /**
     * The head commit an Inbox notice has already been filed for.
     *
     * Claimed with a compare-and-set so the two-minute PR-status sweep and
     * an on-demand `?refresh=true` cannot both file one, and so a new head
     * legitimately gets a new notice.
     */
    @Column({ type: 'varchar', length: 64, nullable: true })
    inboxFiledForSha?: string | null;

    /**
     * WHAT the last Inbox notice for {@link inboxFiledForSha} said —
     * `'stuck'` for an undecided reading past the grace window, otherwise
     * the verdict itself.
     *
     * Half of the compare-and-set, and not an optimisation. Keying the
     * one-notice-per-commit slot on the SHA alone meant the first reading
     * to clear the grace window (routinely `pending`: the gate's
     * `node-contract` job has a 20-minute budget plus self-hosted ARC
     * queue time) consumed the slot, and the verdict that actually decides
     * the promotion — including a FAILURE — was then suppressed for that
     * commit. The human was told the gate was stuck and never told what it
     * concluded.
     */
    @Column({ type: 'varchar', length: 16, nullable: true })
    inboxFiledVerdict?: string | null;

    // Tenant + Organization scope FKs (EW-657 Tier C denormalization).
    // No @ManyToOne — cycle-avoidance, see user.entity.ts EW-654 comment.
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
