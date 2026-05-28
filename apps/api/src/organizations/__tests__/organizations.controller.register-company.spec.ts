jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/entities', () => ({}));
jest.mock('@ever-works/agent/services', () => ({}));
jest.mock('@ever-works/contracts/api', () => ({}));

import { OrganizationsController } from '../organizations.controller';

/**
 * EW-665 (Tenants & Organizations Phase 13) — register-company wiring.
 *
 * Asserts the controller's Register-Company flow (approach "a"):
 *   1. lands a backing Company Work (kind=company, status=draft),
 *   2. creates the Org via the Phase 10 `registerCompany` path with
 *      `linkedWorkId` pointing at that Work, then
 *   3. transitions the Work to `registered` (firing the lifecycle event).
 *
 * The end state is an Organization linked to the Work.
 */
describe('OrganizationsController.registerCompany (EW-665 Phase 13)', () => {
    function makeController() {
        const createdWork = { id: 'w-100', name: 'Acme Inc.' };
        const createdOrg = {
            id: 'o-1',
            tenantId: 't-1',
            slug: 'acme-inc',
            legalName: 'Acme, Inc.',
            displayName: 'Acme Inc.',
            countryCode: 'US',
            registrationProvider: 'manual',
            registrationStatus: 'registered',
            linkedWorkId: 'w-100',
            createdAt: new Date('2026-01-01'),
            updatedAt: new Date('2026-01-01'),
        };

        const organizationService = {
            registerCompany: jest.fn().mockResolvedValue(createdOrg),
        };
        const workLifecycle = {
            createCompanyWork: jest.fn().mockResolvedValue(createdWork),
            transitionStatus: jest.fn().mockResolvedValue({ ...createdWork, status: 'registered' }),
        };
        const usernameAllocator = {
            normalize: jest.fn((s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-')),
        };

        const controller = new OrganizationsController(
            organizationService as never,
            workLifecycle as never,
            usernameAllocator as never,
        );

        return { controller, organizationService, workLifecycle, usernameAllocator, createdOrg };
    }

    it('creates a Company Work, links it to the Org, and transitions it to registered', async () => {
        const { controller, organizationService, workLifecycle, createdOrg } = makeController();

        const res = await controller.registerCompany({ user: { userId: 'u-1' } }, {
            name: 'Acme Inc.',
            legalName: 'Acme, Inc.',
            countryCode: 'us',
        } as never);

        // Step 1 — backing Company Work created.
        expect(workLifecycle.createCompanyWork).toHaveBeenCalledTimes(1);
        const [, workParams] = workLifecycle.createCompanyWork.mock.calls[0];
        expect(workParams).toMatchObject({
            name: 'Acme Inc.',
            companyName: 'Acme, Inc.',
            status: 'draft',
        });

        // Step 2 — Org created with linkedWorkId + uppercased countryCode.
        expect(organizationService.registerCompany).toHaveBeenCalledWith(
            'u-1',
            expect.objectContaining({
                name: 'Acme Inc.',
                legalName: 'Acme, Inc.',
                countryCode: 'US',
                linkedWorkId: 'w-100',
            }),
        );

        // Step 3 — Work driven through the registered transition.
        expect(workLifecycle.transitionStatus).toHaveBeenCalledWith('w-100', 'registered');

        // Response is the linked Org.
        expect(res.id).toBe(createdOrg.id);
        expect(res.linkedWorkId).toBe('w-100');
    });

    it('orders the steps: Work create → Org register → status transition', async () => {
        const { controller, organizationService, workLifecycle } = makeController();
        const order: string[] = [];
        workLifecycle.createCompanyWork.mockImplementation(async () => {
            order.push('createWork');
            return { id: 'w-100', name: 'Acme Inc.' };
        });
        organizationService.registerCompany.mockImplementation(async () => {
            order.push('registerCompany');
            return {
                id: 'o-1',
                linkedWorkId: 'w-100',
                createdAt: new Date(),
                updatedAt: new Date(),
            };
        });
        workLifecycle.transitionStatus.mockImplementation(async () => {
            order.push('transition');
            return { id: 'w-100', status: 'registered' };
        });

        await controller.registerCompany({ user: { userId: 'u-1' } }, {
            name: 'Acme Inc.',
        } as never);

        expect(order).toEqual(['createWork', 'registerCompany', 'transition']);
    });

    it('rejects a whitespace-only name BEFORE creating any Work (Codex P2)', async () => {
        const { controller, workLifecycle, organizationService } = makeController();

        await expect(
            controller.registerCompany({ user: { userId: 'u-1' } }, { name: '   ' } as never),
        ).rejects.toThrow();

        // No orphan Work / Org created for the invalid name.
        expect(workLifecycle.createCompanyWork).not.toHaveBeenCalled();
        expect(organizationService.registerCompany).not.toHaveBeenCalled();
    });

    it('rejects a name longer than 200 chars before creating any Work', async () => {
        const { controller, workLifecycle } = makeController();

        await expect(
            controller.registerCompany({ user: { userId: 'u-1' } }, {
                name: 'x'.repeat(201),
            } as never),
        ).rejects.toThrow();

        expect(workLifecycle.createCompanyWork).not.toHaveBeenCalled();
    });
});
