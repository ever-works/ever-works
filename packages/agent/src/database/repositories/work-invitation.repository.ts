import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { WorkInvitation } from '../../entities/work-invitation.entity';
import { WorkInvitationStatus, WorkInvitationTransferState } from '../../entities/types';

@Injectable()
export class WorkInvitationRepository {
    constructor(
        @InjectRepository(WorkInvitation)
        private readonly repository: Repository<WorkInvitation>,
    ) {}

    async create(data: Partial<WorkInvitation>): Promise<WorkInvitation> {
        const row = this.repository.create(data);
        return this.repository.save(row);
    }

    async findById(id: string): Promise<WorkInvitation | null> {
        return this.repository.findOne({
            where: { id },
            relations: ['work', 'invitedBy', 'acceptedBy'],
        });
    }

    async findByTokenHash(tokenHash: string): Promise<WorkInvitation | null> {
        return this.repository.findOne({
            where: { tokenHash },
            relations: ['work', 'invitedBy'],
        });
    }

    async listPendingForWork(workId: string): Promise<WorkInvitation[]> {
        return this.repository.find({
            where: { workId, status: WorkInvitationStatus.PENDING },
            relations: ['invitedBy'],
            order: { createdAt: 'DESC' },
        });
    }

    /**
     * Compare-and-swap from pending → accepted. Returns true on success;
     * false if someone else already consumed/revoked/expired this row.
     */
    async tryMarkAccepted(
        id: string,
        acceptedByUserId: string,
        acceptedAt: Date,
    ): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(WorkInvitation)
            .set({
                status: WorkInvitationStatus.ACCEPTED,
                acceptedByUserId,
                acceptedAt,
            })
            .where('id = :id AND status = :pending', {
                id,
                pending: WorkInvitationStatus.PENDING,
            })
            .execute();
        return (result.affected ?? 0) > 0;
    }

    async markRevoked(id: string): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(WorkInvitation)
            .set({ status: WorkInvitationStatus.REVOKED })
            .where('id = :id AND status = :pending', {
                id,
                pending: WorkInvitationStatus.PENDING,
            })
            .execute();
        return (result.affected ?? 0) > 0;
    }

    async updateTransferState(
        id: string,
        transferState: WorkInvitationTransferState,
    ): Promise<void> {
        await this.repository.update(id, { transferState });
    }

    async expireBefore(now: Date): Promise<number> {
        const result = await this.repository
            .createQueryBuilder()
            .update(WorkInvitation)
            .set({ status: WorkInvitationStatus.EXPIRED })
            .where('status = :pending AND tokenExpiresAt < :now', {
                pending: WorkInvitationStatus.PENDING,
                now,
            })
            .execute();
        return result.affected ?? 0;
    }

    async findExpiredPending(now: Date, limit = 100): Promise<WorkInvitation[]> {
        return this.repository.find({
            where: {
                status: WorkInvitationStatus.PENDING,
                tokenExpiresAt: LessThan(now),
            },
            take: limit,
        });
    }
}
