// The controller's DI types come from three `@ever-works/agent` barrels
// whose runtime graphs (entities → items-generator DTOs) do not load under
// this app's jest module mapping. Every dependency is injected here as a
// stub anyway, so stub the barrels at module scope — the same posture the
// agent package's module-shape pins use. Nothing about the controller's
// behaviour is mocked.
jest.mock('@ever-works/agent/policy', () => ({ MergePolicyService: class {} }));
jest.mock('@ever-works/agent/services', () => ({ WorkOwnershipService: class {} }));
jest.mock('@ever-works/agent/database', () => ({
    AgentRepository: class {},
    OrganizationRepository: class {},
    UserRepository: class {},
}));

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PLATFORM_DEFAULT_MERGE_POLICY } from '@ever-works/contracts';
import { MergePolicyController } from './merge-policy.controller';

/**
 * Merge-policy matrix (Wave 3, D4) — the preview endpoint's OWNER
 * SCOPING. Both ids are checked before anything is resolved; without
 * that, `GET /api/merge-policy/resolve` would be a cross-tenant policy
 * oracle (it reports the tenant/org/Work/Agent chain by design).
 */
describe('MergePolicyController.resolve', () => {
    const auth = { userId: 'user-1' } as never;
    const resolved = {
        policy: PLATFORM_DEFAULT_MERGE_POLICY,
        source: 'default' as const,
        chain: [],
    };

    function make(overrides?: {
        ensureAccess?: jest.Mock;
        findByIdAndUser?: jest.Mock;
        resolve?: jest.Mock;
        findOrganization?: jest.Mock;
        findUser?: jest.Mock;
    }) {
        const resolve = overrides?.resolve ?? jest.fn().mockResolvedValue(resolved);
        const ensureAccess = overrides?.ensureAccess ?? jest.fn().mockResolvedValue({});
        const findByIdAndUser =
            overrides?.findByIdAndUser ?? jest.fn().mockResolvedValue({ id: 'agent-1' });
        const findOrganization =
            overrides?.findOrganization ??
            jest.fn().mockResolvedValue({ id: 'org-1', tenantId: 'tenant-1' });
        const findUser =
            overrides?.findUser ??
            jest.fn().mockResolvedValue({ id: 'user-1', tenantId: 'tenant-1' });
        const controller = new MergePolicyController(
            { resolve } as never,
            { ensureAccess } as never,
            { findByIdAndUser } as never,
            { findById: findOrganization } as never,
            { findById: findUser } as never,
        );
        return { controller, resolve, ensureAccess, findByIdAndUser, findOrganization, findUser };
    }

    it('rejects a call with no scope id at all', async () => {
        const { controller, resolve } = make();
        await expect(controller.resolve(auth, {})).rejects.toBeInstanceOf(BadRequestException);
        expect(resolve).not.toHaveBeenCalled();
    });

    it('gates the Work through WorkOwnershipService before resolving', async () => {
        const ensureAccess = jest.fn().mockRejectedValue(new NotFoundException('nope'));
        const { controller, resolve } = make({ ensureAccess });
        await expect(controller.resolve(auth, { workId: 'work-9' })).rejects.toBeInstanceOf(
            NotFoundException,
        );
        expect(ensureAccess).toHaveBeenCalledWith('work-9', 'user-1');
        expect(resolve).not.toHaveBeenCalled();
    });

    it("404s an Agent the caller does not own, without resolving anyone's policy", async () => {
        const { controller, resolve } = make({
            findByIdAndUser: jest.fn().mockResolvedValue(null),
        });
        await expect(controller.resolve(auth, { agentId: 'agent-9' })).rejects.toBeInstanceOf(
            NotFoundException,
        );
        expect(resolve).not.toHaveBeenCalled();
    });

    it('resolves the owner-scoped tuple and returns policy + source + chain', async () => {
        const { controller, resolve, ensureAccess, findByIdAndUser } = make();
        await expect(
            controller.resolve(auth, { workId: 'work-1', agentId: 'agent-1' }),
        ).resolves.toEqual(resolved);
        expect(ensureAccess).toHaveBeenCalledWith('work-1', 'user-1');
        expect(findByIdAndUser).toHaveBeenCalledWith('agent-1', 'user-1');
        expect(resolve).toHaveBeenCalledWith({
            workId: 'work-1',
            agentId: 'agent-1',
            organizationId: null,
        });
    });

    // The organization scope was added so the org settings card can render
    // the same chain the runtime uses. It carries the same oracle risk as
    // the other two ids, so it gets the same same-Tenant gate.
    it('resolves an Organization inside the caller’s Tenant', async () => {
        const { controller, resolve } = make();
        await expect(controller.resolve(auth, { organizationId: 'org-1' })).resolves.toEqual(
            resolved,
        );
        expect(resolve).toHaveBeenCalledWith({
            workId: null,
            agentId: null,
            organizationId: 'org-1',
        });
    });

    it('404s an Organization in ANOTHER Tenant without resolving anything', async () => {
        const { controller, resolve } = make({
            findOrganization: jest
                .fn()
                .mockResolvedValue({ id: 'org-9', tenantId: 'tenant-other' }),
        });
        await expect(controller.resolve(auth, { organizationId: 'org-9' })).rejects.toBeInstanceOf(
            NotFoundException,
        );
        expect(resolve).not.toHaveBeenCalled();
    });

    it('404s an Organization for a user with no Tenant', async () => {
        const { controller, resolve } = make({
            findUser: jest.fn().mockResolvedValue({ id: 'user-1', tenantId: null }),
        });
        await expect(controller.resolve(auth, { organizationId: 'org-1' })).rejects.toBeInstanceOf(
            NotFoundException,
        );
        expect(resolve).not.toHaveBeenCalled();
    });
});
