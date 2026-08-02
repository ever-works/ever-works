import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { WorkflowGraph } from '@ever-works/contracts';
import { Workflow, WorkflowStatus } from '../../entities/workflow.entity';

export interface CreateWorkflowInput {
    userId: string;
    name: string;
    graph: WorkflowGraph;
    description?: string | null;
    status?: WorkflowStatus;
    workId?: string | null;
}

export interface UpdateWorkflowInput {
    name?: string;
    description?: string | null;
    status?: WorkflowStatus;
    graph?: WorkflowGraph;
    workId?: string | null;
}

export interface ListWorkflowsFilter {
    status?: WorkflowStatus;
    workId?: string | null;
    limit?: number;
    offset?: number;
}

/**
 * Persistence for saved workflow graphs (judgment layer G5).
 *
 * Owner-scoped by construction: every read takes a `userId` and every
 * lookup is `(id, userId)`. There is deliberately NO bare `findById` —
 * a caller that cannot name the owner has no business reading the row,
 * and the absence of the method is what stops one being written by
 * accident. A foreign id therefore resolves to `null`, which the service
 * turns into a 404 rather than a 403, so the endpoint cannot be used to
 * probe which workflow ids exist for other users.
 *
 * Scope columns (`tenantId` / `organizationId`) are NOT set here —
 * `ScopeStampingSubscriber` stamps them from the active request scope on
 * insert. Setting them explicitly would defeat that, and setting them to
 * `null` would actively suppress it (the subscriber only fills
 * `undefined`).
 */
@Injectable()
export class WorkflowRepository {
    constructor(
        @InjectRepository(Workflow)
        private readonly repository: Repository<Workflow>,
    ) {}

    async create(input: CreateWorkflowInput): Promise<Workflow> {
        const workflow = this.repository.create({
            userId: input.userId,
            name: input.name,
            description: input.description ?? null,
            status: input.status ?? WorkflowStatus.DRAFT,
            graph: input.graph,
            workId: input.workId ?? null,
            runCount: 0,
            lastRunAt: null,
        });
        return this.repository.save(workflow);
    }

    /** The ONLY read by id. Owner-scoped on purpose — see the class note. */
    async findByIdAndUser(id: string, userId: string): Promise<Workflow | null> {
        return this.repository.findOne({ where: { id, userId } });
    }

    async list(
        userId: string,
        filter: ListWorkflowsFilter = {},
    ): Promise<{ items: Workflow[]; total: number }> {
        const qb = this.repository
            .createQueryBuilder('workflow')
            .where('workflow.userId = :userId', { userId });

        if (filter.status) {
            qb.andWhere('workflow.status = :status', { status: filter.status });
        }
        // `null` is a MEANINGFUL filter here ("organization-level only"),
        // so it is distinguished from an absent one rather than folded
        // into it by a truthiness check.
        if (filter.workId === null) {
            qb.andWhere('workflow.workId IS NULL');
        } else if (filter.workId !== undefined) {
            qb.andWhere('workflow.workId = :workId', { workId: filter.workId });
        }

        qb.orderBy('workflow.updatedAt', 'DESC');

        const total = await qb.getCount();
        if (filter.limit !== undefined) qb.take(filter.limit);
        if (filter.offset !== undefined) qb.skip(filter.offset);

        return { items: await qb.getMany(), total };
    }

    /**
     * Owner-scoped update. Returns null when the row is not the user's,
     * so a caller cannot patch a workflow it could not read.
     */
    async update(id: string, userId: string, patch: UpdateWorkflowInput): Promise<Workflow | null> {
        const existing = await this.findByIdAndUser(id, userId);
        if (!existing) return null;

        // Explicit assignment rather than a spread: a spread would let a
        // future caller smuggle `userId` or a scope column into the patch
        // and silently reassign ownership.
        if (patch.name !== undefined) existing.name = patch.name;
        if (patch.description !== undefined) existing.description = patch.description;
        if (patch.status !== undefined) existing.status = patch.status;
        if (patch.graph !== undefined) existing.graph = patch.graph;
        if (patch.workId !== undefined) existing.workId = patch.workId;

        return this.repository.save(existing);
    }

    async remove(id: string, userId: string): Promise<boolean> {
        const result = await this.repository.delete({ id, userId });
        return (result.affected ?? 0) > 0;
    }

    /**
     * Advisory display counters. Best-effort by design: a failure here
     * must never fail the run it is recording, because the authoritative
     * account of a run is its own record — this only drives a list view.
     */
    async recordRun(id: string, at: Date): Promise<void> {
        await this.repository.increment({ id }, 'runCount', 1);
        await this.repository.update({ id }, { lastRunAt: at });
    }
}
