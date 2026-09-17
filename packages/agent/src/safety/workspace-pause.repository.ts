import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { WorkspacePause } from '../entities/workspace-pause.entity';

/** Which workspace: a tenant, plus an Organization or the bare-tenant case. */
export interface WorkspaceRef {
    tenantId: string;
    organizationId?: string | null;
}

export interface CreateWorkspacePauseInput extends WorkspaceRef {
    userId: string;
    pausedByUserId: string;
    reason?: string | null;
}

/**
 * Safety rails (AW-24) — the pause row, present only while paused.
 *
 * Reads are deliberately plain: the fail-closed folding lives one layer up in
 * `WorkspacePauseService`, so there is exactly ONE place that decides what an
 * unreadable pause means. A repository that also had an opinion would be a
 * second place, and the two would drift.
 *
 * `organizationId` is matched with `IsNull()` rather than `undefined` for the
 * bare-tenant workspace: TypeORM drops an `undefined` from the WHERE clause
 * entirely, which would silently match ANY organization's pause row and
 * report a workspace paused because a sibling was.
 */
@Injectable()
export class WorkspacePauseRepository {
    constructor(
        @InjectRepository(WorkspacePause)
        private readonly pauses: Repository<WorkspacePause>,
    ) {}

    async find(ref: WorkspaceRef): Promise<WorkspacePause | null> {
        return this.pauses.findOne({
            where: {
                tenantId: ref.tenantId,
                organizationId: ref.organizationId ?? IsNull(),
            },
        });
    }

    /**
     * Insert the pause, or refresh an existing one's reason and actor.
     *
     * Idempotent for the same reason the platform stop flag's `stop()` is: a
     * second owner adding context at 2am must not fail, and must not create a
     * second row.
     */
    async pause(input: CreateWorkspacePauseInput): Promise<WorkspacePause> {
        const existing = await this.find(input);
        if (existing) {
            existing.reason = input.reason ?? existing.reason ?? null;
            existing.pausedByUserId = input.pausedByUserId;
            return this.pauses.save(existing);
        }
        return this.pauses.save(
            this.pauses.create({
                userId: input.userId,
                tenantId: input.tenantId,
                organizationId: input.organizationId ?? null,
                pausedByUserId: input.pausedByUserId,
                reason: input.reason ?? null,
                pausedAt: new Date(),
                refusedStarts: 0,
                cleanlyStopped: 0,
            }),
        );
    }

    /** Remove the row. Answers whether one was there to remove. */
    async resume(ref: WorkspaceRef): Promise<boolean> {
        const existing = await this.find(ref);
        if (!existing) return false;
        await this.pauses.delete({ id: existing.id });
        return true;
    }

    /**
     * Bump a counter on the live pause row.
     *
     * An atomic `increment` rather than read-modify-write: the banner's count
     * is incremented from every replica refusing a start, and a lost update
     * there would under-report exactly when the number matters most.
     */
    async countRefusedStart(ref: WorkspaceRef, by = 1): Promise<void> {
        const existing = await this.find(ref);
        if (!existing) return;
        await this.pauses.increment({ id: existing.id }, 'refusedStarts', by);
    }

    /** Bump the "parked cleanly at a tool boundary" counter. */
    async countCleanlyStopped(ref: WorkspaceRef, by = 1): Promise<void> {
        const existing = await this.find(ref);
        if (!existing) return;
        await this.pauses.increment({ id: existing.id }, 'cleanlyStopped', by);
    }
}
