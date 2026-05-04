import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OnboardingRequest, type OnboardingStatus } from '../../entities';

@Injectable()
export class OnboardingRequestRepository {
    constructor(
        @InjectRepository(OnboardingRequest)
        private readonly repository: Repository<OnboardingRequest>,
    ) {}

    async findByIdentityAndRepo(
        githubIdentityHash: string,
        repoUrlCanonical: string,
    ): Promise<OnboardingRequest | null> {
        return this.repository.findOne({
            where: { githubIdentityHash, repoUrlCanonical },
        });
    }

    async findByRepo(repoUrlCanonical: string): Promise<OnboardingRequest | null> {
        return this.repository.findOne({ where: { repoUrlCanonical } });
    }

    async findById(id: string): Promise<OnboardingRequest | null> {
        return this.repository.findOne({ where: { id } });
    }

    async create(data: Partial<OnboardingRequest>): Promise<OnboardingRequest> {
        const row = this.repository.create(data);
        return this.repository.save(row);
    }

    /**
     * Compare-and-swap status transition. Returns true if the transition
     * landed; false if the row already moved to a different status (someone
     * else won the race). Used by background tasks to claim ownership.
     */
    async tryTransition(
        id: string,
        from: OnboardingStatus,
        to: OnboardingStatus,
        extra?: Partial<OnboardingRequest>,
    ): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(OnboardingRequest)
            .set({ status: to, ...extra })
            .where('id = :id AND status = :from', { id, from })
            .execute();
        return (result.affected ?? 0) > 0;
    }

    async markFailure(id: string, failureCode: string, failureDetail?: unknown): Promise<void> {
        await this.repository.update(id, {
            status: 'failed',
            failureCode,
            failureDetail,
        });
    }

    async setWorkId(id: string, workId: string): Promise<void> {
        await this.repository.update(id, { workId });
    }

    async setAccountId(id: string, accountId: string): Promise<void> {
        await this.repository.update(id, { accountId });
    }
}
