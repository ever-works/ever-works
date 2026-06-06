// Mock the agent barrels the controller imports so this unit spec
// doesn't pull in the full TypeORM / service graph. We inject mock
// collaborators directly via the constructor, so the barrels only need
// to exist as empty modules. Mirrors `members.controller.spec.ts`.
jest.mock('@ever-works/agent/services', () => ({}));
jest.mock('@ever-works/agent/dto', () => ({}));
jest.mock('@ever-works/agent/entities', () => ({}));
jest.mock('../organizations/organization-membership.service', () => ({
    OrganizationMembershipService: class {},
}));
jest.mock('../auth', () => ({
    AuthSessionGuard: class {},
    CurrentUser: () => () => undefined,
}));

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { OrgKbController } from './org-kb.controller';
import type { OrganizationMembershipService } from '../organizations/organization-membership.service';
import type { KnowledgeBaseService, WorkOwnershipService } from '@ever-works/agent/services';
import type { AuthenticatedUser } from '@src/auth/types/auth.types';

describe('OrgKbController', () => {
    let kb: {
        listOrgDocuments: jest.Mock;
        createOrgDocument: jest.Mock;
        resolveInheritableDocuments: jest.Mock;
        getInheritedDocument: jest.Mock;
    };
    let membership: { ensureMember: jest.Mock; ensureAdmin: jest.Mock };
    let ownership: { ensureCanView: jest.Mock };
    let controller: OrgKbController;
    const auth = { userId: 'u-1' } as AuthenticatedUser;

    beforeEach(() => {
        kb = {
            listOrgDocuments: jest.fn().mockResolvedValue([{ id: 'd1' }]),
            createOrgDocument: jest.fn().mockResolvedValue({ id: 'd-new' }),
            resolveInheritableDocuments: jest.fn().mockResolvedValue([]),
            getInheritedDocument: jest.fn().mockResolvedValue({ body: 'x' }),
        };
        membership = {
            ensureMember: jest.fn().mockResolvedValue({ id: 'o-1', tenantId: 't-1' }),
            ensureAdmin: jest.fn().mockResolvedValue({ id: 'o-1', tenantId: 't-1' }),
        };
        ownership = {
            ensureCanView: jest.fn().mockResolvedValue({ work: { organizationId: 'o-1' } }),
        };
        controller = new OrgKbController(
            kb as unknown as KnowledgeBaseService,
            membership as unknown as OrganizationMembershipService,
            ownership as unknown as WorkOwnershipService,
        );
    });

    afterEach(() => jest.restoreAllMocks());

    describe('listOrgDocuments', () => {
        it('gates on ensureMember before listing', async () => {
            const result = await controller.listOrgDocuments(auth, 'o-1', {} as never);

            expect(membership.ensureMember).toHaveBeenCalledWith('o-1', 'u-1');
            expect(kb.listOrgDocuments).toHaveBeenCalledWith('o-1', { class: undefined });
            expect(result).toEqual([{ id: 'd1' }]);
        });

        it('does NOT list when the membership guard rejects (cross-tenant blocked)', async () => {
            membership.ensureMember.mockRejectedValue(
                new NotFoundException('Organization o-1 not found'),
            );
            await expect(
                controller.listOrgDocuments(auth, 'o-1', {} as never),
            ).rejects.toBeInstanceOf(NotFoundException);
            expect(kb.listOrgDocuments).not.toHaveBeenCalled();
        });
    });

    describe('createOrgDocument', () => {
        const body = {
            path: 'legal/privacy.md',
            title: 'Privacy',
            class: 'legal',
            body: 'text',
        } as never;

        it('gates on ensureAdmin before creating', async () => {
            const result = await controller.createOrgDocument(auth, 'o-1', body);

            expect(membership.ensureAdmin).toHaveBeenCalledWith('o-1', 'u-1');
            expect(kb.createOrgDocument).toHaveBeenCalledWith('o-1', 'u-1', expect.any(Object));
            expect(result).toEqual({ id: 'd-new' });
        });

        it('does NOT create when the admin guard rejects (cross-tenant write blocked)', async () => {
            membership.ensureAdmin.mockRejectedValue(
                new NotFoundException('Organization o-1 not found'),
            );
            await expect(controller.createOrgDocument(auth, 'o-1', body)).rejects.toBeInstanceOf(
                NotFoundException,
            );
            expect(kb.createOrgDocument).not.toHaveBeenCalled();
        });
    });

    describe('resolveInheritable', () => {
        it('derives the org scope from the Work, ignoring a matching supplied orgId', async () => {
            await controller.resolveInheritable(auth, 'w-1', 'o-1');
            expect(ownership.ensureCanView).toHaveBeenCalledWith('w-1', 'u-1');
            expect(kb.resolveInheritableDocuments).toHaveBeenCalledWith('w-1', 'o-1');
        });

        it('rejects a supplied orgId that does not match the Work org', async () => {
            await expect(
                controller.resolveInheritable(auth, 'w-1', 'o-FOREIGN'),
            ).rejects.toBeInstanceOf(ForbiddenException);
            expect(kb.resolveInheritableDocuments).not.toHaveBeenCalled();
        });
    });
});
