// Mock the agent barrels so this unit spec does not pull in the TypeORM /
// service graph. The service arrives through the constructor.
jest.mock('@ever-works/agent/services', () => ({ KnowledgeBaseService: class {} }));
jest.mock('@ever-works/agent/dto', () => ({
    CreateKbDocumentDto: class {},
    CreateKbTagDto: class {},
    CreateKbUploadDto: class {},
    KbDocumentQueryDto: class {},
    LockKbDocumentDto: class {},
    RestoreKbDocumentDto: class {},
    TransitionKbDecisionStatusDto: class {},
    UpdateKbDocumentDto: class {},
    UpdateKbTagDto: class {},
}));
jest.mock('../auth', () => ({
    AuthSessionGuard: class AuthSessionGuard {},
    CurrentUser: () => () => undefined,
}));

import 'reflect-metadata';
import { ForbiddenException, HttpStatus, RequestMethod } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type { KnowledgeBaseService } from '@ever-works/agent/services';
import type { AuthenticatedUser } from '@src/auth/types/auth.types';
import { KbController } from './kb.controller';

const WORK_ID = '00000000-0000-0000-0000-000000000001';
const DOC_ID = '00000000-0000-0000-0000-000000000010';

/**
 * Per-Work KB routes — the knowledge library's `/unarchive`.
 *
 * Two endpoints now sound alike and must never be confused: `/restore`
 * restores a BODY from a Git commit, `/unarchive` brings an archived
 * document back to the shelf. These assertions pin that they are separate
 * routes delegating to separate service methods.
 */
describe('KbController — unarchive', () => {
    const auth = { userId: 'u-1' } as AuthenticatedUser;
    let kb: Record<string, jest.Mock>;
    let controller: KbController;

    beforeEach(() => {
        kb = {
            archiveDocument: jest.fn().mockResolvedValue({ id: DOC_ID, status: 'archived' }),
            unarchiveDocument: jest
                .fn()
                .mockResolvedValue({
                    document: { id: DOC_ID },
                    restoredToUnfiled: false,
                    changed: true,
                }),
            restoreDocumentFromHistory: jest.fn().mockResolvedValue({ id: DOC_ID }),
        };
        controller = new KbController(kb as unknown as KnowledgeBaseService);
    });

    it('is POST works/:id/kb/documents/:docId/unarchive returning 200', () => {
        const handler = KbController.prototype.unarchiveDocument;
        expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(
            'works/:id/kb/documents/:docId/unarchive',
        );
        expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
        expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(HttpStatus.OK);
    });

    it('delegates to unarchiveDocument, never to the body restore', async () => {
        const result = await controller.unarchiveDocument(auth, WORK_ID, DOC_ID);
        expect(kb.unarchiveDocument).toHaveBeenCalledWith(WORK_ID, DOC_ID, 'u-1');
        expect(kb.restoreDocumentFromHistory).not.toHaveBeenCalled();
        expect(result).toMatchObject({ restoredToUnfiled: false });
    });

    it('is idempotent at the route: a second call is passed straight through', async () => {
        kb.unarchiveDocument.mockResolvedValue({
            document: { id: DOC_ID },
            restoredToUnfiled: false,
            changed: false,
        });
        await controller.unarchiveDocument(auth, WORK_ID, DOC_ID);
        await expect(controller.unarchiveDocument(auth, WORK_ID, DOC_ID)).resolves.toMatchObject({
            changed: false,
        });
    });

    it('surfaces a missing edit permission from the service', async () => {
        kb.unarchiveDocument.mockRejectedValue(new ForbiddenException());
        await expect(controller.unarchiveDocument(auth, WORK_ID, DOC_ID)).rejects.toBeInstanceOf(
            ForbiddenException,
        );
    });

    it('keeps /restore as the body-from-a-commit route', async () => {
        expect(Reflect.getMetadata(PATH_METADATA, KbController.prototype.restoreDocument)).toBe(
            'works/:id/kb/documents/:docId/restore',
        );
        await controller.restoreDocument(auth, WORK_ID, DOC_ID, { commitSha: 'abc123' } as never);
        expect(kb.restoreDocumentFromHistory).toHaveBeenCalledWith(
            WORK_ID,
            DOC_ID,
            'u-1',
            'abc123',
        );
        expect(kb.unarchiveDocument).not.toHaveBeenCalled();
    });
});
