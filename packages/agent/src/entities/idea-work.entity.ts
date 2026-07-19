import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from './user.entity';
import { WorkProposal } from './work-proposal.entity';
import { Work } from './work.entity';

/**
 * How an Idea↔Work link came to exist:
 *
 *   - `linked`  — the user accepted the Idea against an existing Work
 *                 (`POST /me/work-proposals/:id/accept`), or the row was
 *                 seeded by the backfill migration (conservative default —
 *                 pre-existing links can't be reliably told apart).
 *   - `built`   — the build pipeline created the Work from this Idea
 *                 (goal-completion success path, first build).
 *   - `rebuilt` — a Re-build of an already-accepted Idea produced this
 *                 Work (Decision A27). The previous link row is kept —
 *                 history is append-only.
 */
export type IdeaWorkKind = 'built' | 'linked' | 'rebuilt';

/**
 * Idea↔Work provenance link — the AUTHORITATIVE 0..N relation between a
 * WorkProposal ("Idea") and the Works it produced or was linked to
 * (domain-model review §23.1, ADR-009: "From one Idea, 0..N Works can be
 * spawned").
 *
 * Relationship contract:
 *   - 1 Idea → 0..N Works (parallel links allowed — e.g. a mobile-app
 *     Work AND a website Work from the same Idea).
 *   - 1 Work → at most 1 source Idea (`works.acceptedFromIdeaId`, which
 *     is stamped on first link and never overwritten).
 *   - `WorkProposal.acceptedWorkId` remains as a DENORMALIZED
 *     "primary / most recent" pointer for list-card CTAs and API
 *     back-compat. This table is the source of truth; rebuilds and
 *     additional accepts append rows here instead of erasing history.
 *
 * Rows are append-only in normal operation; they disappear only via the
 * DB CASCADE when the Idea, the Work, or the owning User is deleted.
 */
@Entity({ name: 'idea_works' })
@Index('uq_idea_work', ['ideaId', 'workId'], { unique: true })
@Index('idx_idea_works_work', ['workId'])
export class IdeaWork {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column('uuid')
    ideaId: string;

    @ManyToOne(() => WorkProposal, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'ideaId' })
    idea?: WorkProposal;

    @Column('uuid')
    workId: string;

    @ManyToOne(() => Work, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'workId' })
    work?: Work;

    /** Owner — always the Idea's owner; both sides of the link are
     *  verified same-user before insert (IDOR contract of the accept
     *  path, work-proposal.service.ts `acceptInternal`). */
    @Column('uuid')
    userId: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user?: User;

    @Column({ type: 'varchar', length: 16 })
    kind: IdeaWorkKind;

    // EW-655 Tier C — denormalized scope columns, stamped by the
    // ScopeStampingSubscriber on insert when a scope is active. No
    // @ManyToOne (entities import-cycle rule — see user.entity.ts).
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;
}
