/**
 * Global-Memory (organization-scoped) uploads.
 *
 * The behaviours pinned here are the ones whose absence would be either
 * silent or destructive:
 *
 *   - an org upload writes `workId: null` — that NULL is the scope
 *     discriminator, and `organizationId` alone cannot stand in for it
 *     because scope stamping puts an org id on Work rows too;
 *   - dedup goes through the org-scoped lookup, never the per-Work one;
 *   - a NON-inheritable class does NOT trigger the org-overlay fanout.
 *     That last one is the important one: the fanout writes the document
 *     into EVERY Work's data repo, and it does no class filtering of its
 *     own — it was safe only because `createOrgDocument` used to reject
 *     every class outside the inheritable set outright. Now that Memory
 *     can create org docs of any class, an ungated fanout would commit
 *     every file dropped on the Memory page into every repository in the
 *     organization.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { KnowledgeBaseService, KB_STORAGE_PLUGIN } from './knowledge-base.service';
import { KB_ORG_OVERLAY_FANOUT_DISPATCHER } from '../tasks/kb-org-overlay-fanout-dispatcher';
import { WorkKnowledgeDocumentRepository } from '../database/repositories/work-knowledge-document.repository';
import { WorkKnowledgeUploadRepository } from '../database/repositories/work-knowledge-upload.repository';
import { WorkKnowledgeTagRepository } from '../database/repositories/work-knowledge-tag.repository';
import { WorkKnowledgeCitationRepository } from '../database/repositories/work-knowledge-citation.repository';
import { WorkOwnershipService } from './work-ownership.service';
import { WorkRepository } from '../database/repositories/work.repository';

const ORG_ID = '00000000-0000-0000-0000-0000000000a1';
const USER_ID = '00000000-0000-0000-0000-0000000000a2';

describe('KnowledgeBaseService — global Memory uploads', () => {
    let service: KnowledgeBaseService;
    let uploadRepo: {
        create: jest.Mock;
        update: jest.Mock;
        findBySha256ForOrg: jest.Mock;
        findByIdForOrg: jest.Mock;
        listPagedForOrg: jest.Mock;
    };
    let documentRepo: { create: jest.Mock; findById: jest.Mock };
    let overlayDispatcher: { dispatchKbOrgOverlayFanout: jest.Mock };
    let storage: { providerName: string; putObject: jest.Mock };

    const file = (name = 'notes.md', mime = 'text/markdown') => ({
        buffer: Buffer.from('# Heading\n\nSome body text.'),
        originalFilename: name,
        mimeType: mime,
        size: 27,
    });

    beforeEach(async () => {
        uploadRepo = {
            create: jest.fn().mockImplementation((data) => ({ id: 'upload-1', ...data })),
            update: jest.fn().mockResolvedValue(null),
            findBySha256ForOrg: jest.fn().mockResolvedValue(null),
            findByIdForOrg: jest.fn().mockResolvedValue(null),
            listPagedForOrg: jest.fn().mockResolvedValue({ items: [], total: 0 }),
        };
        documentRepo = {
            create: jest.fn().mockImplementation((data) => ({
                id: 'doc-1',
                ...data,
                createdAt: new Date(),
                updatedAt: new Date(),
            })),
            findById: jest.fn(),
        };
        overlayDispatcher = { dispatchKbOrgOverlayFanout: jest.fn().mockResolvedValue(undefined) };
        storage = {
            providerName: 'local-fs',
            putObject: jest.fn().mockResolvedValue({ key: 'kb-originals/freeform/abc.md' }),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                KnowledgeBaseService,
                { provide: WorkKnowledgeDocumentRepository, useValue: documentRepo },
                { provide: WorkKnowledgeUploadRepository, useValue: uploadRepo },
                { provide: WorkKnowledgeTagRepository, useValue: { upsertBySlug: jest.fn() } },
                { provide: WorkKnowledgeCitationRepository, useValue: {} },
                { provide: WorkOwnershipService, useValue: { ensureCanEdit: jest.fn() } },
                { provide: KB_STORAGE_PLUGIN, useValue: storage },
                { provide: KB_ORG_OVERLAY_FANOUT_DISPATCHER, useValue: overlayDispatcher },
                {
                    provide: WorkRepository,
                    useValue: { findIdsByOrganization: jest.fn().mockResolvedValue(['work-1']) },
                },
            ],
        }).compile();

        service = module.get(KnowledgeBaseService);
    });

    it('writes an org-scoped upload row with a NULL workId', async () => {
        await service.createOrgUpload({ organizationId: ORG_ID, userId: USER_ID, file: file() });

        expect(uploadRepo.create).toHaveBeenCalledTimes(1);
        const row = uploadRepo.create.mock.calls[0][0];
        expect(row.workId).toBeNull();
        expect(row.organizationId).toBe(ORG_ID);
    });

    it('dedups through the org-scoped lookup and does not re-store the bytes', async () => {
        const existing = { id: 'upload-existing', workId: null, organizationId: ORG_ID };
        uploadRepo.findBySha256ForOrg.mockResolvedValue(existing);

        const result = await service.createOrgUpload({
            organizationId: ORG_ID,
            userId: USER_ID,
            file: file(),
        });

        expect(result.upload).toBe(existing);
        expect(result.document).toBeNull();
        expect(storage.putObject).not.toHaveBeenCalled();
        expect(uploadRepo.create).not.toHaveBeenCalled();
    });

    it('does NOT fan a non-inheritable Memory document out into every Work repo', async () => {
        await service.createOrgUpload({
            organizationId: ORG_ID,
            userId: USER_ID,
            file: file(),
            // `freeform` is deliberately outside KB_ORG_INHERITABLE_CLASSES.
            targetClass: 'freeform' as never,
        });

        expect(documentRepo.create).toHaveBeenCalledTimes(1);
        expect(documentRepo.create.mock.calls[0][0].workId).toBeNull();
        expect(overlayDispatcher.dispatchKbOrgOverlayFanout).not.toHaveBeenCalled();
    });

    it('still fans an inheritable class out, so overlay behaviour is unchanged', async () => {
        await service.createOrgUpload({
            organizationId: ORG_ID,
            userId: USER_ID,
            file: file(),
            targetClass: 'legal' as never,
        });

        expect(overlayDispatcher.dispatchKbOrgOverlayFanout).toHaveBeenCalledTimes(1);
    });

    it('rejects a non-inheritable class on the plain org-document path', async () => {
        // The Memory upload path opts in explicitly; every other caller
        // must keep getting the original 400.
        await expect(
            service.createOrgDocument(ORG_ID, USER_ID, {
                path: 'x.md',
                title: 'x',
                body: 'x',
                class: 'freeform' as never,
            }),
        ).rejects.toThrow(/must have class in/);
    });

    it('marks the row SKIPPED and returns no document when nothing can be extracted', async () => {
        await service.createOrgUpload({
            organizationId: ORG_ID,
            userId: USER_ID,
            file: file('scan.bin', 'application/octet-stream'),
        });

        const patch = uploadRepo.update.mock.calls.at(-1)?.[1];
        expect(patch.extractionStatus).toBe('skipped');
        expect(documentRepo.create).not.toHaveBeenCalled();
    });
});
