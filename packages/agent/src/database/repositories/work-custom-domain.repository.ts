import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WorkCustomDomain } from '../../entities/work-custom-domain.entity';

@Injectable()
export class WorkCustomDomainRepository {
    constructor(
        @InjectRepository(WorkCustomDomain)
        private readonly repository: Repository<WorkCustomDomain>,
    ) {}

    /**
     * Find all custom domains for a work.
     */
    async findByWork(workId: string): Promise<WorkCustomDomain[]> {
        return this.repository.find({
            where: { workId },
            order: { createdAt: 'ASC' },
        });
    }

    /**
     * Find a single domain record by work and domain name.
     */
    async findOne(workId: string, domain: string): Promise<WorkCustomDomain | null> {
        return this.repository.findOne({
            where: { workId, domain },
        });
    }

    /**
     * Add a custom domain to a work.
     */
    async addDomain(workId: string, domain: string, provider?: string): Promise<WorkCustomDomain> {
        const record = this.repository.create({
            workId,
            domain,
            verified: false,
            provider,
        });
        return this.repository.save(record);
    }

    /**
     * Remove a custom domain from a work.
     */
    async removeDomain(workId: string, domain: string): Promise<boolean> {
        const result = await this.repository.delete({ workId, domain });
        return (result.affected ?? 0) > 0;
    }

    /**
     * Update the verified status of a domain.
     */
    async updateVerified(workId: string, domain: string, verified: boolean): Promise<void> {
        await this.repository.update({ workId, domain }, { verified });
    }

    /**
     * Update the provider that a domain is synced to.
     */
    async updateProvider(workId: string, domain: string, provider: string): Promise<void> {
        await this.repository.update({ workId, domain }, { provider });
    }
}
