import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OrganizationMember } from '../../entities/organization-member.entity';
import type { OrganizationRosterRole } from '../../entities/types';

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

    /** EW-P2-6 — set a roster row's role; `false` when there is no such row. */
    async updateRole(
        organizationId: string,
        userId: string,
        role: OrganizationRosterRole,
    ): Promise<boolean> {
        const result = await this.repository.update({ organizationId, userId }, { role });
        return (result.affected ?? 0) > 0;
    }

    /**
     * EW-P2-6 — the Organizations of a Tenant this user administers through a roster
     * row (`role = 'admin'`). The Tenant owner administers every Organization and has
     * no rows; callers check ownership first.
     */
    async listAdministeredOrganizationIds(userId: string, tenantId: string): Promise<string[]> {
        const rows = await this.repository.find({
            where: { userId, tenantId, role: 'admin' },
            select: { organizationId: true },
        });
        return rows.map((row) => row.organizationId);
    }

    async deleteByOrgAndUser(organizationId: string, userId: string): Promise<boolean> {
        const result = await this.repository.delete({ organizationId, userId });
        return (result.affected ?? 0) > 0;
    }

    async countForOrganization(organizationId: string): Promise<number> {
        return this.repository.count({ where: { organizationId } });
    }

    /**
     * DISTINCT people holding a membership anywhere in one Tenant — the
     * "employees" half of the seat count (billing spec §3.6 / FR-27).
     *
     * Distinct on purpose: access is tenant-wide, so somebody who belongs
     * to three Organizations in the same Tenant occupies ONE seat, not
     * three. Counting rows instead would over-bill every team that
     * organizes itself into more than one Organization.
     */
    async countDistinctUsersForTenant(tenantId: string): Promise<number> {
        const row = await this.repository
            .createQueryBuilder('m')
            .select('COUNT(DISTINCT m.userId)', 'seats')
            .where('m.tenantId = :tenantId', { tenantId })
            .getRawOne<{ seats: string | number }>();
        return Number(row?.seats ?? 0);
    }
}
