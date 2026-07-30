jest.mock('@ever-works/agent/services', () => ({}));
jest.mock('@ever-works/agent/entities', () => ({}));
jest.mock('@ever-works/agent/database', () => ({ UserUploadRepository: class {} }));
jest.mock('../uploads/uploads.service', () => ({ UploadsService: class {} }));
jest.mock('../organizations/organization-membership.service', () => ({
    OrganizationMembershipService: class {},
}));
jest.mock('../scope', () => ({ ScopeContextService: class {} }));
jest.mock('../auth', () => ({
    AuthSessionGuard: class {},
    CurrentUser: () => () => undefined,
}));

import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { OrgMemoryController } from './org-memory.controller';
import type { AuthenticatedUser } from '@src/auth/types/auth.types';

/**
 * Memory review queue — `GET /api/memory/review`, `POST .../:docId/accept`.
 *
 * Accepting is the moment machine-written text becomes eligible for
 * injection into every Work's context, so the tests that matter here are
 * the boundary ones:
 *
 *  - the Organization comes from the request scope, never a param;
 *  - a document belonging to another Organization is reported as 404, not
 *    403 — a caller must not be able to probe which ids exist elsewhere;
 *  - a write with no active Organization is refused rather than silently
 *    treated as "nothing to do", which is what the READ paths do.
 */
describe('OrgMemoryController — review queue', () => {
    const auth = { userId: 'user-1' } as AuthenticatedUser;
    const DOC = '11111111-1111-4111-8111-111111111111';

    let kb: { listOrgReviewQueue: jest.Mock; acceptOrgDocument: jest.Mock };
    let membership: { ensureMember: jest.Mock; ensureAdmin: jest.Mock };
    let scopeContext: { getOrganizationId: jest.Mock };
    let controller: OrgMemoryController;

    beforeEach(() => {
        kb = {
            listOrgReviewQueue: jest.fn().mockResolvedValue({ items: [], total: 0 }),
            acceptOrgDocument: jest.fn().mockResolvedValue({ id: DOC, reviewState: 'accepted' }),
        };
        membership = {
            ensureMember: jest.fn().mockResolvedValue({ id: 'org-1' }),
            ensureAdmin: jest.fn().mockResolvedValue({ id: 'org-1' }),
        };
        scopeContext = { getOrganizationId: jest.fn().mockReturnValue('org-1') };

        controller = new OrgMemoryController(
            kb as never,
            {} as never,
            membership as never,
            scopeContext as never,
            {} as never,
            {} as never,
            {} as never,
        );
    });

    afterEach(() => jest.restoreAllMocks());

    it('lists the queue for the scoped Organization after asserting membership', async () => {
        await controller.listMemoryReviewQueue(auth, {});

        expect(membership.ensureMember).toHaveBeenCalledWith('org-1', 'user-1');
        expect(kb.listOrgReviewQueue).toHaveBeenCalledWith('org-1', { limit: 50, offset: 0 });
    });

    it('returns an empty queue — never an unscoped scan — with no active Organization', async () => {
        scopeContext.getOrganizationId.mockReturnValue(null);

        const res = await controller.listMemoryReviewQueue(auth, {});

        expect(res).toEqual({ items: [], total: 0 });
        expect(kb.listOrgReviewQueue).not.toHaveBeenCalled();
        expect(membership.ensureMember).not.toHaveBeenCalled();
    });

    it('authorizes accept as a WRITE (ensureAdmin), not a plain read', async () => {
        await controller.acceptMemoryDocument(auth, DOC);

        expect(membership.ensureAdmin).toHaveBeenCalledWith('org-1', 'user-1');
        expect(membership.ensureMember).not.toHaveBeenCalled();
    });

    it('accepts a document in the scoped Organization', async () => {
        const res = await controller.acceptMemoryDocument(auth, DOC);

        expect(kb.acceptOrgDocument).toHaveBeenCalledWith('org-1', DOC, 'user-1');
        expect(res).toMatchObject({ reviewState: 'accepted' });
    });

    it("reports another Organization's document as 404, not 403", async () => {
        // The service returns null for "missing", "belongs to another org"
        // and "is Work-scoped" alike, so the response cannot be used to
        // probe which document ids exist elsewhere.
        kb.acceptOrgDocument.mockResolvedValue(null);

        await expect(controller.acceptMemoryDocument(auth, DOC)).rejects.toBeInstanceOf(
            NotFoundException,
        );
    });

    it('refuses to accept when the request has no active Organization', async () => {
        // Deliberately NOT the empty-payload treatment the reads get: a
        // write with no Organization has no correct target.
        scopeContext.getOrganizationId.mockReturnValue(null);

        await expect(controller.acceptMemoryDocument(auth, DOC)).rejects.toBeInstanceOf(
            UnprocessableEntityException,
        );
        expect(kb.acceptOrgDocument).not.toHaveBeenCalled();
    });
});
