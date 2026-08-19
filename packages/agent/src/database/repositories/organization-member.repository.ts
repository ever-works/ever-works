import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OrganizationMember } from '../../entities/organization-member.entity';

/**
 * Data access for `OrganizationMember` — the Organization roster.
 *
 * 🛑 Nothing here grants access. Authorization remains
 * `user.tenantId === organization.tenantId` in
 * `OrganizationMembershipService`; these rows record who was invited by whom
 * and when. See the entity docblock.
 */
@Injectable()
export class OrganizationMemberRepository {
    constructor(
        @InjectRepository(OrganizationMember)
        private readonly repository: Repository<OrganizationMember>,
    ) {}

    async create(data: Partial<OrganizationMember>): Promise<OrganizationMember> {
        const entity = this.repository.create(data);
        return this.repository.save(entity);
    }

    async findByOrgAndUser(
        organizationId: string,
        userId: string,
    ): Promise<OrganizationMember | null> {
        return this.repository.findOne({ where: { organizationId, userId } });
    }

    async listForOrganization(organizationId: string): Promise<OrganizationMember[]> {
        return this.repository.find({
            where: { organizationId },
            order: { joinedAt: 'ASC' },
        });
    }

    /**
     * Every membership this user holds anywhere in the given Tenant.
     *
     * Needed by the removal path: access is tenant-wide, so `users.tenantId`
     * may only be cleared once the person's LAST membership in that Tenant is
     * gone. Removing them from one Organization while they still belong to
     * another in the same Tenant must not revoke their access.
     */
    async listForUserInTenant(userId: string, tenantId: string): Promise<OrganizationMember[]> {
        return this.repository.find({ where: { userId, tenantId } });
    }

    async deleteByOrgAndUser(organizationId: string, userId: string): Promise<boolean> {
        const result = await this.repository.delete({ organizationId, userId });
        return (result.affected ?? 0) > 0;
    }

    async countForOrganization(organizationId: string): Promise<number> {
        return this.repository.count({ where: { organizationId } });
    }
}
