import {
    BeforeInsert,
    BeforeUpdate,
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import type { MilestoneRecord, RosterProvisionRecord } from '@ever-works/contracts/api';
import { PortableDateColumn } from './_types';

/**
 * AW-20 — how far one person got through their first hour, in one
 * workspace scope.
 *
 * ## Why this is not the onboarding wizard's own state blob
 *
 * `users.onboarding_state` is a step index plus four provider choices,
 * and its two timestamps mean "the dialog closed" and "the dialog was
 * dismissed". Four of the five first-hour milestones are satisfied by
 * facts in four OTHER subsystems — a completed run, a decided approval, a
 * resolved escalation, an enabled schedule — none of which that blob's
 * contract can express. Folding them in would also put every wizard write
 * and every milestone write in contention on the same row.
 *
 * ## Why a row exists at all, rather than deriving everything
 *
 * Three pieces of state have no source anywhere else: a milestone the
 * person marked "not for me", whether the card is hidden, and whether
 * they acknowledged the roster introduction. All three are decisions the
 * person made and must survive a device switch. Everything else on the
 * row is a cache with a 60-second life.
 *
 * ## `scopeKey` — why the redundant-looking column
 *
 * The uniqueness rule is one row per (person, workspace scope), and
 * personal scope has `organizationId = NULL`. SQL treats NULLs as
 * DISTINCT, so a UNIQUE index on `(userId, organizationId)` would happily
 * admit a second personal row. `scopeKey` is the normalised
 * `organizationId ?? 'personal'`, written in the lifecycle hooks below,
 * and the unique index is on `(userId, scopeKey)` instead. `Agent`
 * already uses exactly this dodge with `scopeTargetId` — please do not
 * "simplify" it away.
 *
 * `userId` is a raw uuid with no `@ManyToOne`, matching the
 * cycle-avoidance posture `onboarding-request.entity.ts` takes.
 */
@Entity({ name: 'onboarding_checklists' })
@Index('uq_onboarding_checklist_user_scope', ['userId', 'scopeKey'], { unique: true })
@Index('idx_onboarding_checklist_user', ['userId'])
export class OnboardingChecklist {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    userId: string;

    /** Active workspace scope; NULL for the personal contract. */
    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    /** `organizationId ?? 'personal'` — see the class doc for why. */
    @Column({ type: 'varchar', length: 64 })
    scopeKey: string;

    /**
     * `Record<OnboardingMilestoneKey, MilestoneRecord>`. Five fixed keys,
     * read as one object and written as one object, never queried by
     * field — so `simple-json` (which maps to `text` on Postgres and on
     * the better-sqlite3 CLI driver alike) rather than a jsonb column
     * nothing would index.
     */
    @Column({ type: 'simple-json', default: '{}' })
    milestones: Record<string, MilestoneRecord>;

    /**
     * The current or last roster provisioning run (AW-20 P1). One bounded
     * object per person, written only by provisioning and read only in the
     * seconds around it — a separate table would add a join and a second
     * lifecycle for a read pattern nobody has.
     */
    @Column({ type: 'simple-json', nullable: true })
    provisioning?: RosterProvisionRecord | null;

    /**
     * When the person acknowledged the roster introduction. Gates the
     * "Meet your agents" milestone: provisioning alone never marks it
     * done, because the platform must not claim someone met agents it
     * merely created.
     */
    @PortableDateColumn({ nullable: true })
    rosterAcknowledgedAt?: Date | null;

    /** Card hidden. Never deletes the row — hiding is reversible. */
    @PortableDateColumn({ nullable: true })
    hiddenAt?: Date | null;

    /** The completed card was dismissed. */
    @PortableDateColumn({ nullable: true })
    dismissedAt?: Date | null;

    /** First moment every applicable milestone was done. */
    @PortableDateColumn({ nullable: true })
    completedAt?: Date | null;

    /** Cache stamp for the 60-second re-evaluation window. */
    @PortableDateColumn({ nullable: true })
    evaluatedAt?: Date | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;

    @BeforeInsert()
    @BeforeUpdate()
    normalizeScopeKey(): void {
        this.scopeKey = this.organizationId ?? 'personal';
    }
}
