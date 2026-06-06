// Mock the agent database + entities barrels to avoid pulling in the
// full TypeORM DataSource graph (which transitively imports
// `@src/config`). Same pattern as `organization.service.spec.ts`.
jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/entities', () => ({}));

import { NotFoundException } from '@nestjs/common';
import { OrganizationMembershipService } from '../organization-membership.service';

/**
 * Unit tests for the reusable tenant-ownership guard extracted from
 * OrgKbController. The security contract under test:
 *
 *   - a caller may only reach an Organization in their OWN Tenant;
 *   - every failure path (no user / no Tenant / missing org /
 *     cross-tenant org) throws `NotFoundException` — never
 *     `ForbiddenException` — so org existence in other tenants is not
 *     leaked.
 */
describe('OrganizationMembershipService', () => {
    type Org = { id: string; tenantId: string };
    type Usr = { id: string; tenantId?: string | null };

    function makeService(opts: { user?: Usr | null; org?: Org | null }) {
        const userRepository = {
            findById: jest.fn().mockResolvedValue(opts.user ?? null),
        };
        const organizationRepository = {
            findById: jest.fn().mockResolvedValue(opts.org ?? null),
        };
        const service = new OrganizationMembershipService(
            organizationRepository as never,
            userRepository as never,
        );
        return { service, userRepository, organizationRepository };
    }

    describe('ensureMember', () => {
        it('returns the Organization when caller belongs to the owning Tenant', async () => {
            const org = { id: 'o-1', tenantId: 't-1' };
            const { service, userRepository, organizationRepository } = makeService({
                user: { id: 'u-1', tenantId: 't-1' },
                org,
            });

            await expect(service.ensureMember('o-1', 'u-1')).resolves.toBe(org);
            expect(userRepository.findById).toHaveBeenCalledWith('u-1');
            expect(organizationRepository.findById).toHaveBeenCalledWith('o-1');
        });

        it('throws NotFoundException when the user does not exist', async () => {
            const { service, organizationRepository } = makeService({ user: null });
            await expect(service.ensureMember('o-1', 'ghost')).rejects.toBeInstanceOf(
                NotFoundException,
            );
            // Short-circuits before the org lookup — no point loading the org
            // for a caller with no identity/Tenant.
            expect(organizationRepository.findById).not.toHaveBeenCalled();
        });

        it('throws NotFoundException when the user has no Tenant', async () => {
            const { service, organizationRepository } = makeService({
                user: { id: 'u-1', tenantId: null },
            });
            await expect(service.ensureMember('o-1', 'u-1')).rejects.toBeInstanceOf(
                NotFoundException,
            );
            expect(organizationRepository.findById).not.toHaveBeenCalled();
        });

        it('throws NotFoundException when the Organization does not exist', async () => {
            const { service } = makeService({
                user: { id: 'u-1', tenantId: 't-1' },
                org: null,
            });
            await expect(service.ensureMember('o-missing', 'u-1')).rejects.toBeInstanceOf(
                NotFoundException,
            );
        });

        // The core cross-tenant IDOR the extraction closes: a caller in
        // tenant t-1 must NOT reach an org owned by tenant t-OTHER, and the
        // rejection must be 404 (not 403) so the foreign org id stays opaque.
        it('blocks cross-tenant access with NotFoundException (no existence leak)', async () => {
            const { service } = makeService({
                user: { id: 'attacker', tenantId: 't-1' },
                org: { id: 'victim-org', tenantId: 't-OTHER' },
            });
            await expect(service.ensureMember('victim-org', 'attacker')).rejects.toBeInstanceOf(
                NotFoundException,
            );
            await expect(service.ensureMember('victim-org', 'attacker')).rejects.toMatchObject({
                message: 'Organization victim-org not found',
            });
        });
    });

    describe('ensureAdmin', () => {
        it('returns the Organization for a same-Tenant caller (delegates to ensureMember today)', async () => {
            const org = { id: 'o-1', tenantId: 't-1' };
            const { service } = makeService({ user: { id: 'u-1', tenantId: 't-1' }, org });
            await expect(service.ensureAdmin('o-1', 'u-1')).resolves.toBe(org);
        });

        it('blocks cross-tenant writes with NotFoundException', async () => {
            const { service } = makeService({
                user: { id: 'attacker', tenantId: 't-1' },
                org: { id: 'victim-org', tenantId: 't-OTHER' },
            });
            await expect(service.ensureAdmin('victim-org', 'attacker')).rejects.toBeInstanceOf(
                NotFoundException,
            );
        });
    });
});
