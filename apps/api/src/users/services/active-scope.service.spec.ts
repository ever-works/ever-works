import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { OrganizationRepository, UserRepository } from '@ever-works/agent/database';
import { OrganizationMembershipService } from '../../organizations/organization-membership.service';
import { ActiveScopeService } from './active-scope.service';

describe('ActiveScopeService', () => {
    let service: ActiveScopeService;
    let users: jest.Mocked<Pick<UserRepository, 'findById' | 'update'>>;
    let organizations: jest.Mocked<Pick<OrganizationRepository, 'findById' | 'findBySlug'>>;
    let membership: jest.Mocked<Pick<OrganizationMembershipService, 'ensureMember'>>;
    let moduleRef: TestingModule;

    const user = {
        id: 'user-1',
        tenantId: 'tenant-1',
        lastScopeOrganizationId: 'org-ever',
    };
    const ever = {
        id: 'org-ever',
        tenantId: 'tenant-1',
        slug: 'ever',
    };

    beforeEach(async () => {
        users = {
            findById: jest.fn(),
            update: jest.fn(),
        };
        organizations = {
            findById: jest.fn(),
            findBySlug: jest.fn(),
        };
        membership = {
            ensureMember: jest.fn(),
        };
        moduleRef = await Test.createTestingModule({
            providers: [
                ActiveScopeService,
                { provide: UserRepository, useValue: users },
                { provide: OrganizationRepository, useValue: organizations },
                { provide: OrganizationMembershipService, useValue: membership },
            ],
        }).compile();
        service = moduleRef.get(ActiveScopeService);
    });

    afterEach(async () => {
        await moduleRef.close();
    });

    it('returns the persisted active Organization for a same-Tenant pointer', async () => {
        users.findById.mockResolvedValue(user as never);
        membership.ensureMember.mockResolvedValue(ever as never);

        await expect(service.getActiveScope(user.id)).resolves.toEqual({
            tenantId: 'tenant-1',
            organizationId: 'org-ever',
            organizationSlug: 'ever',
        });
        expect(membership.ensureMember).toHaveBeenCalledWith(ever.id, user.id);
        expect(users.update).not.toHaveBeenCalled();
    });

    it('returns bare-Tenant scope for a stale persisted pointer without mutating on GET', async () => {
        users.findById.mockResolvedValue(user as never);
        membership.ensureMember.mockRejectedValue(new NotFoundException('not found'));

        await expect(service.getActiveScope(user.id)).resolves.toEqual({
            tenantId: 'tenant-1',
            organizationId: null,
            organizationSlug: null,
        });
        expect(users.update).not.toHaveBeenCalled();
    });

    it('persists a same-Tenant Organization selected by slug', async () => {
        users.findById.mockResolvedValue(user as never);
        organizations.findBySlug.mockResolvedValue(ever as never);
        membership.ensureMember.mockResolvedValue(ever as never);
        users.update.mockResolvedValue({ ...user, lastScopeOrganizationId: ever.id } as never);

        await expect(service.updateActiveScope(user.id, ever.slug)).resolves.toEqual({
            tenantId: 'tenant-1',
            organizationId: 'org-ever',
            organizationSlug: 'ever',
        });
        expect(users.update).toHaveBeenCalledWith(user.id, {
            lastScopeOrganizationId: ever.id,
        });
        expect(membership.ensureMember).toHaveBeenCalledWith(ever.id, user.id);
    });

    it('supports the product contract for explicit personal/bare-Tenant scope', async () => {
        users.findById.mockResolvedValue(user as never);
        users.update.mockResolvedValue({ ...user, lastScopeOrganizationId: null } as never);

        await expect(service.updateActiveScope(user.id, null)).resolves.toEqual({
            tenantId: 'tenant-1',
            organizationId: null,
            organizationSlug: null,
        });
        expect(organizations.findBySlug).not.toHaveBeenCalled();
        expect(users.update).toHaveBeenCalledWith(user.id, {
            lastScopeOrganizationId: null,
        });
    });

    it('rejects an unknown slug without changing the prior active scope', async () => {
        users.findById.mockResolvedValue(user as never);
        organizations.findBySlug.mockResolvedValue(null);

        await expect(service.updateActiveScope(user.id, 'missing')).rejects.toBeInstanceOf(
            NotFoundException,
        );
        expect(users.update).not.toHaveBeenCalled();
    });

    it('rejects a foreign-Tenant Organization with the same response and no partial update', async () => {
        users.findById.mockResolvedValue(user as never);
        organizations.findBySlug.mockResolvedValue({
            ...ever,
            id: 'org-foreign',
            tenantId: 'tenant-foreign',
            slug: 'foreign',
        } as never);
        membership.ensureMember.mockRejectedValue(new NotFoundException('not found'));

        const rejection = service.updateActiveScope(user.id, 'foreign');
        await expect(rejection).rejects.toBeInstanceOf(NotFoundException);
        await expect(rejection).rejects.toMatchObject({
            response: expect.objectContaining({ message: "Organization 'foreign' not found" }),
        });
        expect(users.update).not.toHaveBeenCalled();
    });

    it('propagates an unexpected membership lookup failure without changing scope', async () => {
        users.findById.mockResolvedValue(user as never);
        organizations.findBySlug.mockResolvedValue(ever as never);
        membership.ensureMember.mockRejectedValue(new Error('membership database unavailable'));

        await expect(service.updateActiveScope(user.id, ever.slug)).rejects.toThrow(
            'membership database unavailable',
        );
        expect(users.update).not.toHaveBeenCalled();
    });

    it('rejects a missing authenticated user without writing', async () => {
        users.findById.mockResolvedValue(null);

        await expect(service.updateActiveScope('missing-user', 'ever')).rejects.toBeInstanceOf(
            NotFoundException,
        );
        expect(organizations.findBySlug).not.toHaveBeenCalled();
        expect(users.update).not.toHaveBeenCalled();
    });
});
