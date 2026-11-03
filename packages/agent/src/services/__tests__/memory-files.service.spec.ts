import { NotFoundException } from '@nestjs/common';
import { MemoryFilesService } from '../memory-files.service';

const USER = 'user-1';
const ORG = 'org-1';

function uploadRow(partial: Record<string, unknown> = {}) {
    return {
        id: 'up-1',
        userId: USER,
        sha256: 'a'.repeat(64),
        workId: null,
        folderId: null,
        originalFilename: 'chat.png',
        mimeType: 'image/png',
        fileSize: 123,
        storagePath: `${USER}/${'a'.repeat(64)}.png`,
        updatedAt: new Date('2026-02-02T00:00:00Z'),
        ...partial,
    };
}

function kbRow(partial: Record<string, unknown> = {}) {
    return {
        id: 'kb-1',
        workId: null,
        organizationId: ORG,
        folderId: null,
        originalFilename: 'research.pdf',
        mimeType: 'application/pdf',
        fileSize: 456,
        sha256: 'b'.repeat(64),
        updatedAt: new Date('2026-02-01T00:00:00Z'),
        ...partial,
    };
}

describe('MemoryFilesService', () => {
    let folders: { findById: jest.Mock; listByUser: jest.Mock };
    let userUploads: {
        listForMemoryFiles: jest.Mock;
        findByIdOwned: jest.Mock;
        setFolder: jest.Mock;
    };
    let kbUploads: {
        listForMemoryFiles: jest.Mock;
        findForMemoryFiles: jest.Mock;
        setFolder: jest.Mock;
    };
    let taskAttachments: { findByUploadIds: jest.Mock };
    let missionAttachments: { findByUploadIds: jest.Mock };
    let proposalAttachments: { findByUploadIds: jest.Mock };
    let agentAttachments: { findByUploadIds: jest.Mock };
    let service: MemoryFilesService;

    beforeEach(() => {
        folders = {
            findById: jest.fn(async () => null),
            listByUser: jest.fn(async () => []),
        };
        userUploads = {
            listForMemoryFiles: jest.fn(async () => []),
            findByIdOwned: jest.fn(async () => null),
            setFolder: jest.fn(async () => true),
        };
        kbUploads = {
            listForMemoryFiles: jest.fn(async () => []),
            findForMemoryFiles: jest.fn(async () => null),
            setFolder: jest.fn(async () => true),
        };
        taskAttachments = { findByUploadIds: jest.fn(async () => []) };
        missionAttachments = { findByUploadIds: jest.fn(async () => []) };
        proposalAttachments = { findByUploadIds: jest.fn(async () => []) };
        agentAttachments = { findByUploadIds: jest.fn(async () => []) };
        service = new MemoryFilesService(
            folders as never,
            userUploads as never,
            kbUploads as never,
            taskAttachments as never,
            missionAttachments as never,
            proposalAttachments as never,
            agentAttachments as never,
        );
    });

    describe('list (sources merged + provenance)', () => {
        it('merges both spines into unified rows, newest first', async () => {
            userUploads.listForMemoryFiles.mockResolvedValue([uploadRow()]);
            kbUploads.listForMemoryFiles.mockResolvedValue([kbRow()]);

            const rows = await service.list(USER, { organizationId: ORG, folderId: null });

            expect(rows).toHaveLength(2);
            // upload row is newer (2026-02-02) than the kb row (2026-02-01)
            expect(rows[0]).toMatchObject({
                id: 'up-1',
                source: 'upload',
                filename: 'chat.png',
                mime: 'image/png',
                size: 123,
                folderId: null,
                sha256: 'a'.repeat(64),
            });
            expect(rows[1]).toMatchObject({
                id: 'kb-1',
                source: 'kb-upload',
                filename: 'research.pdf',
                size: 456,
            });
        });

        it('maps provenance from the attachment edge tables in batch', async () => {
            const sha = 'a'.repeat(64);
            userUploads.listForMemoryFiles.mockResolvedValue([uploadRow({ sha256: sha })]);
            kbUploads.listForMemoryFiles.mockResolvedValue([
                kbRow({ id: 'kb-1', workId: 'work-9' }),
            ]);
            missionAttachments.findByUploadIds.mockResolvedValue([
                { uploadId: sha, missionId: 'mission-7' },
            ]);
            taskAttachments.findByUploadIds.mockResolvedValue([
                { uploadId: 'kb-1', taskId: 'task-3' },
            ]);

            const rows = await service.list(USER, { organizationId: ORG, folderId: null });
            const upload = rows.find((r) => r.source === 'upload');
            const kb = rows.find((r) => r.source === 'kb-upload');

            expect(upload?.provenance).toEqual({ missionId: 'mission-7' });
            expect(kb?.provenance).toEqual({ workId: 'work-9', taskId: 'task-3' });
            // Batch lookups — one call per edge table, keyed by the right ids.
            expect(missionAttachments.findByUploadIds).toHaveBeenCalledWith([sha]);
            expect(taskAttachments.findByUploadIds).toHaveBeenCalledWith(['kb-1']);
        });

        it('marks edge-less plain uploads as chat provenance', async () => {
            userUploads.listForMemoryFiles.mockResolvedValue([uploadRow()]);
            const rows = await service.list(USER, { folderId: null });
            expect(rows[0].provenance).toEqual({ chat: true });
        });

        it('source=upload skips the KB spine entirely', async () => {
            userUploads.listForMemoryFiles.mockResolvedValue([uploadRow()]);
            await service.list(USER, { folderId: null, source: 'upload' });
            expect(kbUploads.listForMemoryFiles).not.toHaveBeenCalled();
        });

        it('404s when the folderId does not belong to the caller', async () => {
            folders.findById.mockResolvedValue(null);
            await expect(service.list(USER, { folderId: 'foreign' })).rejects.toBeInstanceOf(
                NotFoundException,
            );
        });
    });

    describe('ownerAgent access rule', () => {
        beforeEach(() => {
            folders.listByUser.mockResolvedValue([
                { id: 'folder-a', ownerAgentId: 'agent-A', path: '/A' },
                { id: 'folder-g', ownerAgentId: null, path: '/G' },
            ]);
            userUploads.listForMemoryFiles.mockResolvedValue([
                uploadRow({ id: 'private', folderId: 'folder-a' }),
                uploadRow({ id: 'global', folderId: 'folder-g', sha256: 'c'.repeat(64) }),
            ]);
        });

        it('hides files in another agent’s private folder from an agent read', async () => {
            const rows = await service.list(USER, { agentId: 'agent-B' });
            expect(rows.map((r) => r.id)).toEqual(['global']);
        });

        it('shows the private folder’s files to the owning agent', async () => {
            const rows = await service.list(USER, { agentId: 'agent-A' });
            expect(rows.map((r) => r.id).sort()).toEqual(['global', 'private']);
        });

        it('shows everything to the (human) owner when no agentId is given', async () => {
            const rows = await service.list(USER, {});
            expect(rows).toHaveLength(2);
            expect(rows.find((r) => r.id === 'private')?.ownerAgentId).toBe('agent-A');
        });
    });

    describe('moveFiles', () => {
        it('moves a validated batch across both spines', async () => {
            folders.findById.mockResolvedValue({ id: 'dest', userId: USER });
            userUploads.findByIdOwned.mockResolvedValue(uploadRow());
            kbUploads.findForMemoryFiles.mockResolvedValue(kbRow());

            const result = await service.moveFiles(
                USER,
                [
                    { source: 'upload', id: 'up-1' },
                    { source: 'kb-upload', id: 'kb-1' },
                ],
                'dest',
                { organizationId: ORG },
            );

            expect(result).toEqual({ moved: 2 });
            expect(userUploads.setFolder).toHaveBeenCalledWith(USER, 'up-1', 'dest');
            expect(kbUploads.setFolder).toHaveBeenCalledWith(
                'kb-1',
                { userId: USER, organizationId: ORG },
                'dest',
            );
        });

        it('404s the whole batch on a cross-user file id, before any write', async () => {
            folders.findById.mockResolvedValue({ id: 'dest', userId: USER });
            userUploads.findByIdOwned.mockResolvedValue(null);
            await expect(
                service.moveFiles(USER, [{ source: 'upload', id: 'foreign' }], 'dest'),
            ).rejects.toBeInstanceOf(NotFoundException);
            expect(userUploads.setFolder).not.toHaveBeenCalled();
        });

        it('404s when the destination folder is not the caller’s', async () => {
            folders.findById.mockResolvedValue(null);
            await expect(
                service.moveFiles(USER, [{ source: 'upload', id: 'up-1' }], 'foreign'),
            ).rejects.toBeInstanceOf(NotFoundException);
        });
    });
});
