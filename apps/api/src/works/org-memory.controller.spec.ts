// Mock the agent barrels the controller imports so this unit spec
// doesn't pull in the full TypeORM / service graph. Collaborators are
// injected directly via the constructor, so the barrels only need to
// exist. Mirrors `org-kb.controller.spec.ts`.
jest.mock('@ever-works/agent/services', () => ({}));
jest.mock('@ever-works/agent/entities', () => ({}));
jest.mock('../organizations/organization-membership.service', () => ({
    OrganizationMembershipService: class {},
}));
jest.mock('../scope', () => ({ ScopeContextService: class {} }));
jest.mock('../auth', () => ({
    AuthSessionGuard: class {},
    CurrentUser: () => () => undefined,
}));

import { NotFoundException } from '@nestjs/common';
import { OrgMemoryController } from './org-memory.controller';
import type { OrganizationMembershipService } from '../organizations/organization-membership.service';
import type { ScopeContextService } from '../scope';
import type {
    KnowledgeBaseService,
    MemoryConsolidationService,
    MemoryHealthService,
} from '@ever-works/agent/services';
import type { AuthenticatedUser } from '@src/auth/types/auth.types';

/**
 * `GET /api/memory/health` — scoping.
 *
 * The security contract this pins is the one every Memory route shares:
 * the Organization comes from the request SCOPE CONTEXT, never from a
 * caller-supplied param, and membership is asserted before any read. An
 * org-less session must get the empty payload rather than an unscoped
 * cross-tenant scan.
 */
describe('OrgMemoryController — memory health', () => {
    const auth = { userId: 'u-1' } as AuthenticatedUser;

    let kb: Record<string, jest.Mock>;
    let consolidation: Record<string, jest.Mock>;
    let membership: { ensureMember: jest.Mock };
    let scopeContext: { getOrganizationId: jest.Mock };
    let health: { getOrgHealth: jest.Mock; emptyHealth: jest.Mock };
    let controller: OrgMemoryController;

    beforeEach(() => {
        kb = { aggregateOrgMemory: jest.fn().mockResolvedValue({ documents: [] }) };
        consolidation = { runConsolidation: jest.fn() };
        membership = { ensureMember: jest.fn().mockResolvedValue({ id: 'o-1' }) };
        scopeContext = { getOrganizationId: jest.fn().mockReturnValue('o-1') };
        health = {
            getOrgHealth: jest.fn().mockResolvedValue({ recallHitRate: 0.5 }),
            emptyHealth: jest.fn().mockReturnValue({ recallHitRate: null }),
        };

        controller = new OrgMemoryController(
            kb as unknown as KnowledgeBaseService,
            consolidation as unknown as MemoryConsolidationService,
            membership as unknown as OrganizationMembershipService,
            scopeContext as unknown as ScopeContextService,
            health as unknown as MemoryHealthService,
            {} as never,
            {} as never,
        );
    });

    afterEach(() => jest.restoreAllMocks());

    it('resolves the org from the scope context and asserts membership before reading', async () => {
        await controller.getMemoryHealth(auth, {});

        expect(scopeContext.getOrganizationId).toHaveBeenCalled();
        expect(membership.ensureMember).toHaveBeenCalledWith('o-1', 'u-1');
        expect(health.getOrgHealth).toHaveBeenCalledWith('o-1', {
            windowDays: undefined,
            staleAfterDays: undefined,
        });
    });

    it('forwards the window knobs to the service', async () => {
        await controller.getMemoryHealth(auth, { windowDays: 7, staleAfterDays: 30 });

        expect(health.getOrgHealth).toHaveBeenCalledWith('o-1', {
            windowDays: 7,
            staleAfterDays: 30,
        });
    });

    it('returns the empty payload — never an unscoped scan — when no org is active', async () => {
        scopeContext.getOrganizationId.mockReturnValue(null);

        const result = await controller.getMemoryHealth(auth, {});

        expect(health.getOrgHealth).not.toHaveBeenCalled();
        expect(membership.ensureMember).not.toHaveBeenCalled();
        expect(result).toEqual({ recallHitRate: null });
    });

    it('propagates the membership failure (NotFound, not Forbidden) without reading anything', async () => {
        membership.ensureMember.mockRejectedValue(new NotFoundException());

        await expect(controller.getMemoryHealth(auth, {})).rejects.toBeInstanceOf(
            NotFoundException,
        );
        expect(health.getOrgHealth).not.toHaveBeenCalled();
    });
});
