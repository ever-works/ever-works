import { Injectable, NotFoundException } from '@nestjs/common';
import { OrganizationRepository, UserRepository } from '@ever-works/agent/database';
import type { Organization } from '@ever-works/agent/entities';
import type { ActiveScopeResponse } from '@ever-works/contracts/api';
import { OrganizationMembershipService } from '../../organizations/organization-membership.service';

@Injectable()
export class ActiveScopeService {
    constructor(
        private readonly userRepository: UserRepository,
        private readonly organizationRepository: OrganizationRepository,
        private readonly membership: OrganizationMembershipService,
    ) {}

    async getActiveScope(userId: string): Promise<ActiveScopeResponse> {
        const user = await this.requireUser(userId);
        const tenantId = user.tenantId ?? null;
        const organizationId = user.lastScopeOrganizationId ?? null;

        if (tenantId === null || organizationId === null) {
            return this.bareTenantScope(tenantId);
        }

        let organization: Organization;
        try {
            organization = await this.membership.ensureMember(organizationId, user.id);
        } catch (error) {
            if (error instanceof NotFoundException) return this.bareTenantScope(tenantId);
            throw error;
        }

        return {
            tenantId,
            organizationId: organization.id,
            organizationSlug: organization.slug,
        };
    }

    async updateActiveScope(
        userId: string,
        organizationSlug: string | null,
    ): Promise<ActiveScopeResponse> {
        const user = await this.requireUser(userId);
        const tenantId = user.tenantId ?? null;

        if (organizationSlug === null) {
            await this.userRepository.update(user.id, { lastScopeOrganizationId: null });
            return this.bareTenantScope(tenantId);
        }

        const organization = await this.organizationRepository.findBySlug(organizationSlug);
        if (!organization) {
            throw new NotFoundException(`Organization '${organizationSlug}' not found`);
        }

        let authorizedOrganization: Organization;
        try {
            authorizedOrganization = await this.membership.ensureMember(organization.id, user.id);
        } catch (error) {
            if (error instanceof NotFoundException) {
                throw new NotFoundException(`Organization '${organizationSlug}' not found`);
            }
            throw error;
        }

        await this.userRepository.update(user.id, {
            lastScopeOrganizationId: authorizedOrganization.id,
        });
        return {
            tenantId: authorizedOrganization.tenantId,
            organizationId: authorizedOrganization.id,
            organizationSlug: authorizedOrganization.slug,
        };
    }

    private async requireUser(userId: string) {
        const user = await this.userRepository.findById(userId);
        if (!user) {
            throw new NotFoundException('User not found');
        }
        return user;
    }

    private bareTenantScope(tenantId: string | null): ActiveScopeResponse {
        return {
            tenantId,
            organizationId: null,
            organizationSlug: null,
        };
    }
}
