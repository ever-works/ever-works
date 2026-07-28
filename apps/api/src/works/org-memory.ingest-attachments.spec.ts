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

import { UnprocessableEntityException } from '@nestjs/common';
import { OrgMemoryController } from './org-memory.controller';
import type { AuthenticatedUser } from '@src/auth/types/auth.types';

/**
 * `POST /api/memory/uploads/from-attachments`.
 *
 * What matters here is the ownership boundary. The endpoint takes bare
 * content hashes, and a hash is a guessable-in-principle handle to
 * someone else's bytes — so the lookup itself must be caller-scoped. It
 * is: `findOwnedByUser(sha, callerId)`. The tests below pin that the
 * caller's id is what gets passed, and that an unresolvable hash is
 * reported as `not_found` rather than reaching storage.
 *
 * They also pin the best-effort contract: one bad attachment must not
 * take down the rest of the batch, because this runs off the back of a
 * chat message the user must not lose.
 */
describe('OrgMemoryController — ingest chat attachments into Memory', () => {
    const auth = { userId: 'user-1' } as AuthenticatedUser;
    const SHA = 'a'.repeat(64);
    const OTHER_SHA = 'b'.repeat(64);

    let kb: { createOrgUpload: jest.Mock };
    let membership: { ensureMember: jest.Mock };
    let scopeContext: { getOrganizationId: jest.Mock };
    let uploads: { readFile: jest.Mock };
    let userUploads: { findOwnedByUser: jest.Mock };
    let controller: OrgMemoryController;

    beforeEach(() => {
        kb = {
            createOrgUpload: jest.fn().mockResolvedValue({
                upload: { id: 'kb-upload-1' },
                document: { id: 'doc-1' },
            }),
        };
        membership = { ensureMember: jest.fn().mockResolvedValue({ id: 'org-1' }) };
        scopeContext = { getOrganizationId: jest.fn().mockReturnValue('org-1') };
        uploads = {
            readFile: jest
                .fn()
                .mockResolvedValue({ buffer: Buffer.from('hello'), mimeType: 'text/markdown' }),
        };
        userUploads = {
            findOwnedByUser: jest.fn().mockResolvedValue({
                sha256: SHA,
                storagePath: `uploads/user-1/${SHA}.md`,
                originalFilename: 'notes.md',
                mimeType: 'text/markdown',
                workId: null,
            }),
        };

        controller = new OrgMemoryController(
            kb as never,
            {} as never,
            membership as never,
            scopeContext as never,
            {} as never,
            uploads as never,
            userUploads as never,
        );
    });

    afterEach(() => jest.restoreAllMocks());

    it('resolves each hash against the CALLER, so another user’s upload is never reachable', async () => {
        await controller.ingestAttachmentsIntoMemory(auth, { attachmentIds: [SHA] });

        expect(userUploads.findOwnedByUser).toHaveBeenCalledWith(SHA, 'user-1');
    });

    it('reports an unresolvable hash as not_found without touching storage', async () => {
        userUploads.findOwnedByUser.mockResolvedValue(null);

        const res = await controller.ingestAttachmentsIntoMemory(auth, {
            attachmentIds: [OTHER_SHA],
        });

        expect(res.results).toEqual([{ attachmentId: OTHER_SHA, status: 'not_found' }]);
        expect(uploads.readFile).not.toHaveBeenCalled();
        expect(kb.createOrgUpload).not.toHaveBeenCalled();
    });

    it('ingests a resolved attachment into the scoped Organization', async () => {
        const res = await controller.ingestAttachmentsIntoMemory(auth, { attachmentIds: [SHA] });

        expect(kb.createOrgUpload).toHaveBeenCalledWith(
            expect.objectContaining({ organizationId: 'org-1', userId: 'user-1' }),
        );
        expect(res.results).toEqual([
            { attachmentId: SHA, status: 'ingested', uploadId: 'kb-upload-1' },
        ]);
    });

    it('keeps going when one attachment fails', async () => {
        kb.createOrgUpload
            .mockRejectedValueOnce(new Error('storage down'))
            .mockResolvedValueOnce({ upload: { id: 'kb-upload-2' }, document: null });

        const res = await controller.ingestAttachmentsIntoMemory(auth, {
            attachmentIds: [SHA, OTHER_SHA],
        });

        expect(res.results[0].status).toBe('failed');
        expect(res.results[1].status).toBe('ingested');
    });

    it('refuses to ingest when the request has no active Organization', async () => {
        scopeContext.getOrganizationId.mockReturnValue(null);

        await expect(
            controller.ingestAttachmentsIntoMemory(auth, { attachmentIds: [SHA] }),
        ).rejects.toBeInstanceOf(UnprocessableEntityException);
        expect(kb.createOrgUpload).not.toHaveBeenCalled();
    });
});
