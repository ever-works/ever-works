import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import { PortableDateColumn } from './_types';
import type { WorkflowGraph } from '@ever-works/contracts';

/**
 * Workflow lifecycle. Deliberately small — a workflow is a saved graph,
 * not a scheduled job (that would be a Goal or a Task).
 *
 * `DRAFT`    — being authored. Runnable on demand, but marked as
 *              unfinished so a future scheduler ignores it.
 * `ACTIVE`   — ready to run.
 * `ARCHIVED` — retired. Kept readable and re-activatable; never deleted
 *              out from under a run that references it.
 */
export enum WorkflowStatus {
    DRAFT = 'draft',
    ACTIVE = 'active',
    ARCHIVED = 'archived',
}

/**
 * A SAVED workflow graph (judgment layer G5).
 *
 * `WorkflowGraphExecutorService` could already execute a graph, and the
 * only caller was an agent chat tool handed an inline, model-authored
 * one — so a graph could be run but never KEPT. Nothing could be
 * authored once and re-run, versioned, or pointed at from a UI. This is
 * the row that makes a workflow a thing a user owns.
 *
 * ## The graph is a snapshot column, not a schema
 *
 * `graph` holds the whole `WorkflowGraph` as `simple-json`. Modelling
 * nodes and edges as their own tables would buy referential integrity
 * over a structure that is only ever read and written WHOLE — the
 * executor takes a complete graph, validates it, and walks it — and
 * would cost a join-heavy read plus migrations for every future node
 * kind. `validateWorkflowGraph` is the integrity check, applied on
 * write.
 *
 * ## Scope
 *
 * Tier C: declaring BOTH `tenantId` and `organizationId` opts this
 * entity into `ScopeStampingSubscriber`, which stamps them from the
 * active request scope on insert. So EVERY row carries an
 * `organizationId` — which is exactly why this table must NOT copy the
 * `workId`/`organizationId` XOR CHECK from `work_knowledge_documents`:
 * that constraint aborts a migration here, because the stamp makes both
 * columns populated on ordinary rows. `workId` is an optional NARROWING
 * (a workflow that belongs to one Work), never an alternative to the org.
 */
@Entity({ name: 'workflows' })
@Index('idx_workflows_user_status', ['userId', 'status'])
@Index('idx_workflows_org', ['organizationId'])
@Index('idx_workflows_work', ['workId'])
export class Workflow {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** Owner. Every read is scoped to this — a foreign id resolves to "not found". */
    @Column('uuid')
    userId: string;

    @Column({ type: 'varchar', length: 200 })
    name: string;

    @Column({ type: 'text', nullable: true })
    description?: string | null;

    @Column({ type: 'varchar', length: 16, default: WorkflowStatus.DRAFT })
    status: WorkflowStatus;

    /**
     * The graph itself. Validated against `validateWorkflowGraph` plus
     * the admission clamps on every write, so a row that exists is a row
     * that can be executed — an unrunnable graph is refused at the API
     * rather than discovered at run time.
     */
    @Column({ type: 'simple-json' })
    graph: WorkflowGraph;

    /**
     * Optional narrowing to a single Work. Null = an organization-level
     * workflow. NOT an XOR with `organizationId` — see the class note.
     */
    @Column({ type: 'uuid', nullable: true })
    workId?: string | null;

    // Tenant + Organization scope FKs (Tier C denormalization).
    // No @ManyToOne — cycle-avoidance, same posture as agent-run.entity.
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    /** Denormalized run counters, so a list view needs no aggregate join. */
    @Column({ type: 'int', default: 0 })
    runCount: number;

    // MUST be @PortableDateColumn, not a raw `type: 'timestamp'`: the e2e
    // stack and CI run better-sqlite3, which has no `timestamp` type, so a
    // raw one makes TypeORM's metadata validation throw
    // `DataTypeNotSupportedError` and the API cannot boot AT ALL there.
    @PortableDateColumn({ nullable: true })
    lastRunAt?: Date | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
