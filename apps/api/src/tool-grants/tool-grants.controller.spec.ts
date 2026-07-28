// The controller's DI types come from three `@ever-works/agent` barrels
// whose runtime graphs (entities → items-generator DTOs) do not load under
// this app's jest module mapping. Every dependency is injected here as a
// stub anyway, so stub the barrels at module scope — the same posture the
// merge-policy controller spec uses. Nothing about the controller's
// behaviour is mocked.
jest.mock('@ever-works/agent/policy', () => ({ ToolGrantService: class {} }));
jest.mock('@ever-works/agent/services', () => ({ WorkOwnershipService: class {} }));
jest.mock('@ever-works/agent/database', () => ({
    AgentRepository: class {},
    OrganizationRepository: class {},
    UserRepository: class {},
}));

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ToolGrantsController } from './tool-grants.controller';

/**
 * Tool-grant matrix (audit item G4) — the endpoint's OWNER SCOPING.
 *
 * Every scope id is checked BEFORE anything is resolved or written.
 * Without that, `GET /api/tool-grants/resolve` is a cross-tenant
 * access-policy oracle and `PUT /api/tool-grants` writes access policy
 * into somebody else's tenant.
 */
describe('ToolGrantsController', () => {
    const auth = { userId: 'user-1' } as never;
    const resolved = { matrix: { allow: ['*'], deny: [] }, source: 'default' as const, chain: [] };

    function make(overrides?: {
        ensureAccess?: jest.Mock;
        findAgent?: jest.Mock;
        resolve?: jest.Mock;
        decide?: jest.Mock;
        upsert?: jest.Mock;
        remove?: jest.Mock;
        findOrganization?: jest.Mock;
        findUser?: jest.Mock;
    }) {
        const resolve = overrides?.resolve ?? jest.fn().mockResolvedValue(resolved);
        const decide = overrides?.decide ?? jest.fn().mockResolvedValue({ allowed: true });
        const upsert = overrides?.upsert ?? jest.fn().mockResolvedValue({ id: 'g1' });
        const remove = overrides?.remove ?? jest.fn().mockResolvedValue(true);
        const list = jest.fn().mockResolvedValue([]);
        const ensureAccess = overrides?.ensureAccess ?? jest.fn().mockResolvedValue({});
        const findAgent = overrides?.findAgent ?? jest.fn().mockResolvedValue({ id: 'agent-1' });
        const findOrganization =
            overrides?.findOrganization ??
            jest.fn().mockResolvedValue({ id: 'org-1', tenantId: 'tenant-1' });
        const findUser =
            overrides?.findUser ??
            jest.fn().mockResolvedValue({ id: 'user-1', tenantId: 'tenant-1' });
        const controller = new ToolGrantsController(
            { resolve, decide, upsert, remove, list } as never,
            { ensureAccess } as never,
            { findByIdAndUser: findAgent } as never,
            { findById: findOrganization } as never,
            { findById: findUser } as never,
        );
        return { controller, resolve, decide, upsert, remove, ensureAccess, findAgent };
    }

    describe('resolve', () => {
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
            expect(resolve).not.toHaveBeenCalled();
        });

        it('404s a foreign Agent without leaking that it exists', async () => {
            const findAgent = jest.fn().mockResolvedValue(null);
            const { controller, resolve } = make({ findAgent });
            await expect(controller.resolve(auth, { agentId: 'agent-9' })).rejects.toBeInstanceOf(
                NotFoundException,
            );
            expect(resolve).not.toHaveBeenCalled();
        });

        it('404s an Organization outside the caller’s Tenant', async () => {
            const findOrganization = jest
                .fn()
                .mockResolvedValue({ id: 'org-9', tenantId: 'other-tenant' });
            const { controller, resolve } = make({ findOrganization });
            await expect(
                controller.resolve(auth, { organizationId: 'org-9' }),
            ).rejects.toBeInstanceOf(NotFoundException);
            expect(resolve).not.toHaveBeenCalled();
        });

        it('resolves for the AUTHENTICATED user, never a body-supplied one', async () => {
            const { controller, resolve } = make();
            await controller.resolve(auth, { agentId: 'agent-1' });
            expect(resolve).toHaveBeenCalledWith(
                expect.objectContaining({ userId: 'user-1', agentId: 'agent-1' }),
            );
        });
    });

    describe('check', () => {
        it('applies the same scope gate before deciding', async () => {
            const findAgent = jest.fn().mockResolvedValue(null);
            const { controller, decide } = make({ findAgent });
            await expect(
                controller.check(auth, { agentId: 'agent-9', toolName: 'commitToRepo' }),
            ).rejects.toBeInstanceOf(NotFoundException);
            expect(decide).not.toHaveBeenCalled();
        });

        it('passes the tool name through to the decision point', async () => {
            const { controller, decide } = make();
            await controller.check(auth, { agentId: 'agent-1', toolName: 'commitToRepo' });
            expect(decide).toHaveBeenCalledWith(expect.any(Object), 'commitToRepo');
        });
    });

    describe('upsert', () => {
        it('requires at least one of allow / deny', async () => {
            const { controller, upsert } = make();
            await expect(
                controller.upsert(auth, { scopeType: 'work', scopeId: 'work-1' }),
            ).rejects.toBeInstanceOf(BadRequestException);
            expect(upsert).not.toHaveBeenCalled();
        });

        it('keeps an explicitly EMPTY allow (grants nothing) rather than treating it as absent', async () => {
            const { controller, upsert } = make();
            await controller.upsert(auth, { scopeType: 'work', scopeId: 'work-1', allow: [] });
            expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ grant: { allow: [] } }));
        });

        it('gates a Work-scoped write through WorkOwnershipService', async () => {
            const ensureAccess = jest.fn().mockRejectedValue(new NotFoundException('nope'));
            const { controller, upsert } = make({ ensureAccess });
            await expect(
                controller.upsert(auth, {
                    scopeType: 'work',
                    scopeId: 'work-9',
                    deny: ['deploy_*'],
                }),
            ).rejects.toBeInstanceOf(NotFoundException);
            expect(upsert).not.toHaveBeenCalled();
        });

        it('SECURITY: refuses to write a tenant grant for a tenant the caller is not in', async () => {
            // A ceiling anyone can write into is not a ceiling.
            const { controller, upsert } = make();
            await expect(
                controller.upsert(auth, {
                    scopeType: 'tenant',
                    scopeId: 'someone-elses-tenant',
                    deny: ['*'],
                }),
            ).rejects.toBeInstanceOf(NotFoundException);
            expect(upsert).not.toHaveBeenCalled();
        });

        it('writes a tenant grant for the caller’s OWN tenant', async () => {
            const { controller, upsert } = make();
            await controller.upsert(auth, {
                scopeType: 'tenant',
                scopeId: 'tenant-1',
                deny: ['deploy_*'],
            });
            expect(upsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 'user-1',
                    scopeType: 'tenant',
                    scopeId: 'tenant-1',
                    grant: { deny: ['deploy_*'] },
                }),
            );
        });
    });

    describe('remove', () => {
        it('404s when the row is not the caller’s', async () => {
            const { controller } = make({ remove: jest.fn().mockResolvedValue(false) });
            await expect(controller.remove(auth, 'g-9')).rejects.toBeInstanceOf(NotFoundException);
        });

        it('deletes scoped to the caller', async () => {
            const { controller, remove } = make();
            await expect(controller.remove(auth, 'g1')).resolves.toEqual({ deleted: true });
            expect(remove).toHaveBeenCalledWith('user-1', 'g1');
        });
    });
});
