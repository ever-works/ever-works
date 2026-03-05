import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DirectoryCustomDomain } from '../../entities/directory-custom-domain.entity';

@Injectable()
export class DirectoryCustomDomainRepository {
    constructor(
        @InjectRepository(DirectoryCustomDomain)
        private readonly repository: Repository<DirectoryCustomDomain>,
    ) {}

    /**
     * Find all custom domains for a directory.
     */
    async findByDirectory(directoryId: string): Promise<DirectoryCustomDomain[]> {
        return this.repository.find({
            where: { directoryId },
            order: { createdAt: 'ASC' },
        });
    }

    /**
     * Find a single domain record by directory and domain name.
     */
    async findOne(directoryId: string, domain: string): Promise<DirectoryCustomDomain | null> {
        return this.repository.findOne({
            where: { directoryId, domain },
        });
    }

    /**
     * Add a custom domain to a directory.
     */
    async addDomain(
        directoryId: string,
        domain: string,
        provider?: string,
    ): Promise<DirectoryCustomDomain> {
        const record = this.repository.create({
            directoryId,
            domain,
            verified: false,
            provider,
        });
        return this.repository.save(record);
    }

    /**
     * Remove a custom domain from a directory.
     */
    async removeDomain(directoryId: string, domain: string): Promise<boolean> {
        const result = await this.repository.delete({ directoryId, domain });
        return (result.affected ?? 0) > 0;
    }

    /**
     * Update the verified status of a domain.
     */
    async updateVerified(directoryId: string, domain: string, verified: boolean): Promise<void> {
        await this.repository.update({ directoryId, domain }, { verified });
    }

    /**
     * Update the provider that a domain is synced to.
     */
    async updateProvider(directoryId: string, domain: string, provider: string): Promise<void> {
        await this.repository.update({ directoryId, domain }, { provider });
    }
}
