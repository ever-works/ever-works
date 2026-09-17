import {
    Check,
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import type { MemoryFactOrigin, MemoryFactScope, MemoryFactStatus } from '@ever-works/contracts';
import { PortableDateColumn } from './_types';

/**
 * Memory fact — one atomic, durable statement an owner wants every agent to
 * carry into future runs (AW-07).
 *
 * ## Ownership
 *
 * Tier C, exactly like `memory_folders`: `userId` is the owner and the
 * `tenantId` / `organizationId` pair is the workspace the fact belongs to,
 * stamped from the request scope on insert. Every read goes through the
 * shared ownership predicate, so an id from another workspace resolves to
 * nothing and the API answers 404 — never 403.
 *
 * ## Where the vector lives — and why there is no `embedding` column
 *
 * The platform already routes vectors through the vector-store capability
 * (the bundled pgvector store and the registry-installed Qdrant store both
 * implement it), and owns only the COORDINATES of what was embedded where,
 * with which model. A fact follows the same split: the vector is written
 * through that port into the workspace's own namespace, and this row keeps
 * the coordinates — `vectorStoreId`, `embeddingModel`, `embeddingDims`,
 * `embeddedAt` — so the nightly sweep can find facts that were never
 * embedded, were embedded by a model that has since changed, or live in a
 * store the operator has since swapped out.
 *
 * The coordinates live on the fact row rather than in
 * `work_knowledge_chunk_coordinates` because that table is keyed by Work and
 * read by the Knowledge Base re-embed sweep, which would treat a workspace
 * namespace as a Work that no longer exists and drop its coordinates.
 *
 * ## Why there is no unique index on the body
 *
 * The exact-duplicate defence is `LOWER(body)` per workspace among
 * non-forgotten rows. A partial expression index says that on Postgres and
 * not on better-sqlite3 (which CI and the e2e stack run), so the check lives
 * in `MemoryFactService` where it behaves identically on both.
 */
@Entity({ name: 'memory_facts' })
@Index('idx_memory_facts_owner_status', ['userId', 'organizationId', 'status'])
@Index('idx_memory_facts_agent', ['agentId'])
@Index('idx_memory_facts_forgotten_at', ['forgottenAt'])
@Index('idx_memory_facts_embedded_at', ['embeddedAt'])
@Check(
    'chk_memory_facts_agent_scope',
    `("scope" = 'agent' AND "agentId" IS NOT NULL) OR ("scope" = 'workspace' AND "agentId" IS NULL)`,
)
@Check('chk_memory_facts_body_len', 'length("body") BETWEEN 1 AND 500')
export class MemoryFact {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** Owning user. Raw uuid + FK by migration (no relation, EW-654). */
    @Column({ type: 'uuid' })
    userId: string;

    // Tier C scope columns — stamped by ScopeStampingSubscriber / explicitly
    // by the service. No @ManyToOne (cycle avoidance, EW-654).
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    /** `workspace` (every agent) or `agent` (exactly `agentId`). */
    @Column({ type: 'varchar', length: 16, default: 'workspace' })
    scope: MemoryFactScope;

    /** Required when `scope === 'agent'`, NULL otherwise (CHECK enforced). */
    @Column({ type: 'uuid', nullable: true })
    agentId?: string | null;

    /** 1–500 characters after trimming (CHECK enforced, service validated). */
    @Column({ type: 'varchar', length: 500 })
    body: string;

    @Column({ type: 'varchar', length: 16, default: 'active' })
    status: MemoryFactStatus;

    @Column({ type: 'varchar', length: 16, default: 'user' })
    origin: MemoryFactOrigin;

    /** No FK — runs are reaped; integrity is service-level. */
    @Column({ type: 'uuid', nullable: true })
    sourceRunId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    sourceConversationId?: string | null;

    /** The agent that proposed this fact, when one did. */
    @Column({ type: 'uuid', nullable: true })
    sourceAgentId?: string | null;

    @Column({ type: 'boolean', default: false })
    pinned: boolean;

    /** Vector-store plugin id holding this fact's vector; NULL = not embedded. */
    @Column({ type: 'varchar', length: 128, nullable: true })
    vectorStoreId?: string | null;

    /** Model that produced the stored vector. */
    @Column({ type: 'varchar', length: 128, nullable: true })
    embeddingModel?: string | null;

    /** Dimension of the stored vector. */
    @Column({ type: 'int', nullable: true })
    embeddingDims?: number | null;

    /** When the current body was last embedded; NULL = waiting for the sweep. */
    @PortableDateColumn({ nullable: true })
    embeddedAt?: Date | null;

    @Column({ type: 'int', default: 0 })
    recallCount: number;

    @PortableDateColumn({ nullable: true })
    lastRecalledAt?: Date | null;

    /** Set by a tidy-up merge: the fact this one replaced. */
    @Column({ type: 'uuid', nullable: true })
    supersedesFactId?: string | null;

    /** Retention clock — the sweep purges 30 days after this. */
    @PortableDateColumn({ nullable: true })
    forgottenAt?: Date | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
