import {
    BadRequestException,
    ConflictException,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
    UnprocessableEntityException,
} from '@nestjs/common';
import { MemoryFolder, MemoryFolderSyncRepo } from '../entities/memory-folder.entity';
import { MemoryFolderRepository } from '../database/repositories/memory-folder.repository';
import { UserUploadRepository } from '../database/repositories/user-upload.repository';
import { WorkKnowledgeUploadRepository } from '../database/repositories/work-knowledge-upload.repository';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ActivityActionType, ActivityStatus } from '../entities/activity-log.types';

/** One node of the /memory Files tree, with its per-folder file count. */
export interface MemoryFolderTreeNode {
    id: string;
    name: string;
    parentId: string | null;
    path: string;
    ownerAgentId: string | null;
    syncRepo: MemoryFolderSyncRepo | null;
    fileCount: number;
    createdAt: string;
    updatedAt: string;
}

const MAX_NAME_LENGTH = 120;
const MAX_PATH_LENGTH = 512;

/**
 * Characters a folder name must not contain: path separators (would
 * corrupt the materialized path) and ASCII control characters. Built
 * from char codes so no raw control bytes live in this source file.
 */
function hasIllegalNameChars(name: string): boolean {
    for (let i = 0; i < name.length; i++) {
        const code = name.charCodeAt(i);
        if (code < 0x20 || code === 0x7f) return true;
        const ch = name[i];
        if (ch === '/' || ch === '\\') return true;
    }
    return false;
}

/**
 * Memory Files — the folder-tree half of the /memory Files area.
 *
 * Owns every invariant of the `memory_folders` materialized-path tree:
 *
 *  - `path` is ALWAYS `parent.path + '/' + name`, unique per user. Every
 *    rename/move rewrites the whole subtree's paths in one repository
 *    call, so `path` can be trusted for `LIKE` subtree queries.
 *  - a folder can never be moved under itself or a descendant.
 *  - delete refuses (422) while the subtree still holds child folders or
 *    files, unless the caller passes an explicit `recursive` flag — and
 *    even then files are only UNLINKED (folderId -> NULL), never
 *    destroyed: Memory Files is additive, bytes-deletion is out of scope.
 *  - cross-user access to any folder id is a 404, never a 403.
 */
@Injectable()
export class MemoryFoldersService {
    private readonly logger = new Logger(MemoryFoldersService.name);

    constructor(
        private readonly folders: MemoryFolderRepository,
        private readonly userUploads: UserUploadRepository,
        private readonly kbUploads: WorkKnowledgeUploadRepository,
        // Optional so unit specs (and any consumer that wires the service
        // without the activity module) still construct — same posture as
        // KnowledgeBaseService.
        @Optional() private readonly activityLog?: ActivityLogService,
    ) {}

    /** All folders of the user, parents-first, with per-folder file counts. */
    async getTree(
        userId: string,
        opts: { agentId?: string } = {},
    ): Promise<MemoryFolderTreeNode[]> {
        let folders = await this.folders.listByUser(userId);
        if (opts.agentId !== undefined) {
            // Agent context: agent-private folders belong to exactly one
            // agent. Global folders (NULL) stay visible to every agent.
            folders = folders.filter((f) => !f.ownerAgentId || f.ownerAgentId === opts.agentId);
        }
        const ids = folders.map((f) => f.id);
        const [uploadCounts, kbCounts] = await Promise.all([
            this.userUploads.countByFolderIds(userId, ids),
            this.kbUploads.countByFolderIds(ids),
        ]);
        return folders.map((f) => ({
            id: f.id,
            name: f.name,
            parentId: f.parentId ?? null,
            path: f.path,
            ownerAgentId: f.ownerAgentId ?? null,
            syncRepo: f.syncRepo ?? null,
            fileCount: (uploadCounts.get(f.id) ?? 0) + (kbCounts.get(f.id) ?? 0),
            createdAt: f.createdAt.toISOString(),
            updatedAt: f.updatedAt.toISOString(),
        }));
    }

    async createFolder(
        userId: string,
        input: {
            name: string;
            parentId?: string | null;
            ownerAgentId?: string | null;
            syncRepo?: MemoryFolderSyncRepo | null;
        },
    ): Promise<MemoryFolder> {
        const name = this.validateName(input.name);
        const parent = input.parentId ? await this.requireOwned(userId, input.parentId) : null;
        const path = this.childPath(parent?.path ?? '', name);
        await this.assertPathFree(userId, path);
        const folder = await this.folders.create({
            userId,
            name,
            parentId: parent?.id ?? null,
            path,
            ownerAgentId: input.ownerAgentId ?? null,
            syncRepo: input.syncRepo ?? null,
        });
        await this.recordActivity(
            userId,
            ActivityActionType.MEMORY_FOLDER_CREATED,
            `Created memory folder ${folder.path}`,
            {
                folderId: folder.id,
                path: folder.path,
                ownerAgentId: folder.ownerAgentId ?? null,
            },
        );
        return folder;
    }

    async renameFolder(userId: string, folderId: string, newName: string): Promise<MemoryFolder> {
        const folder = await this.requireOwned(userId, folderId);
        const name = this.validateName(newName);
        if (name === folder.name) return folder;
        const parentPath = this.parentPathOf(folder.path);
        const newPath = this.childPath(parentPath, name);
        await this.assertPathFree(userId, newPath);
        await this.folders.updateSubtreePaths(userId, folder.path, newPath);
        await this.folders.update(folder.id, { name });
        return this.requireOwned(userId, folderId);
    }

    async moveFolder(
        userId: string,
        folderId: string,
        newParentId: string | null,
    ): Promise<MemoryFolder> {
        const folder = await this.requireOwned(userId, folderId);
        const newParent = newParentId ? await this.requireOwned(userId, newParentId) : null;
        if (newParent) {
            if (newParent.id === folder.id) {
                throw new UnprocessableEntityException({
                    status: 'error',
                    message: 'A folder cannot be moved into itself',
                });
            }
            if (newParent.path === folder.path || newParent.path.startsWith(`${folder.path}/`)) {
                throw new UnprocessableEntityException({
                    status: 'error',
                    message: 'A folder cannot be moved into its own subtree',
                });
            }
        }
        const newPath = this.childPath(newParent?.path ?? '', folder.name);
        if (newPath === folder.path) return folder;
        await this.assertPathFree(userId, newPath);
        await this.folders.updateSubtreePaths(userId, folder.path, newPath);
        await this.folders.update(folder.id, { parentId: newParent?.id ?? null });
        return this.requireOwned(userId, folderId);
    }

    /** Configure (or clear, with `null`) the folder's manual git-sync target. */
    async configureSync(
        userId: string,
        folderId: string,
        syncRepo: MemoryFolderSyncRepo | null,
    ): Promise<MemoryFolder> {
        const folder = await this.requireOwned(userId, folderId);
        if (syncRepo && !syncRepo.owner && !syncRepo.repo && !syncRepo.repoUrl) {
            throw new BadRequestException({
                status: 'error',
                message: 'syncRepo must name a repository (owner/repo or repoUrl)',
            });
        }
        await this.folders.update(folder.id, { syncRepo });
        return this.requireOwned(userId, folderId);
    }

    /**
     * Delete a folder. Without `recursive`, a folder that still holds
     * child folders or files refuses with 422 so nothing is unlinked by
     * accident. With `recursive: true` the whole subtree of folders is
     * deleted and every file in it is unlinked back to the root —
     * deleting the actual bytes is deliberately out of scope (v1
     * additive rule).
     */
    async deleteFolder(
        userId: string,
        folderId: string,
        opts: { recursive?: boolean } = {},
    ): Promise<{ deletedFolders: number; unlinkedFiles: number }> {
        const folder = await this.requireOwned(userId, folderId);
        const subtree = await this.folders.listSubtree(userId, folder.path);
        const subtreeIds = subtree.map((f) => f.id);
        const [uploadCounts, kbCounts] = await Promise.all([
            this.userUploads.countByFolderIds(userId, subtreeIds),
            this.kbUploads.countByFolderIds(subtreeIds),
        ]);
        let fileCount = 0;
        for (const id of subtreeIds) {
            fileCount += (uploadCounts.get(id) ?? 0) + (kbCounts.get(id) ?? 0);
        }
        const hasChildren = subtree.length > 1;
        if (!opts.recursive && (hasChildren || fileCount > 0)) {
            throw new UnprocessableEntityException({
                status: 'error',
                code: 'FolderNotEmpty',
                message:
                    'Folder is not empty — pass recursive=true to delete its subfolders and unfile its files',
            });
        }
        await Promise.all([
            this.userUploads.clearFolders(userId, subtreeIds),
            this.kbUploads.clearFolders(subtreeIds),
        ]);
        await this.folders.deleteByIds(userId, subtreeIds);
        await this.recordActivity(
            userId,
            ActivityActionType.MEMORY_FOLDER_DELETED,
            `Deleted memory folder ${folder.path}`,
            {
                folderId: folder.id,
                path: folder.path,
                deletedFolders: subtree.length,
                unlinkedFiles: fileCount,
            },
        );
        return { deletedFolders: subtree.length, unlinkedFiles: fileCount };
    }

    /**
     * Activity is best-effort telemetry: a logging failure must never
     * fail the folder operation the user just completed.
     */
    async recordActivity(
        userId: string,
        actionType: ActivityActionType,
        summary: string,
        details: Record<string, unknown>,
    ): Promise<void> {
        if (!this.activityLog) return;
        try {
            await this.activityLog.log({
                userId,
                actionType,
                action: actionType,
                status: ActivityStatus.COMPLETED,
                summary,
                details,
            });
        } catch (error) {
            this.logger.warn(
                `Failed to record activity ${actionType}: ${(error as Error).message}`,
            );
        }
    }

    /** The folder, or 404. Cross-user ids are indistinguishable from absent. */
    async requireOwned(userId: string, folderId: string): Promise<MemoryFolder> {
        const folder = await this.folders.findById(userId, folderId);
        if (!folder) {
            throw new NotFoundException({ status: 'error', message: 'Folder not found' });
        }
        return folder;
    }

    // ─── internal ────────────────────────────────────────────────────────

    private validateName(raw: string): string {
        const name = (raw ?? '').trim();
        if (!name || name.length > MAX_NAME_LENGTH) {
            throw new BadRequestException({
                status: 'error',
                message: `Folder name must be 1-${MAX_NAME_LENGTH} characters`,
            });
        }
        if (hasIllegalNameChars(name) || name === '.' || name === '..') {
            throw new BadRequestException({
                status: 'error',
                message: 'Folder name must not contain slashes or control characters',
            });
        }
        return name;
    }

    private childPath(parentPath: string, name: string): string {
        const path = `${parentPath}/${name}`;
        if (path.length > MAX_PATH_LENGTH) {
            throw new UnprocessableEntityException({
                status: 'error',
                message: `Folder path exceeds ${MAX_PATH_LENGTH} characters`,
            });
        }
        return path;
    }

    private parentPathOf(path: string): string {
        const idx = path.lastIndexOf('/');
        return idx <= 0 ? '' : path.slice(0, idx);
    }

    private async assertPathFree(userId: string, path: string): Promise<void> {
        const existing = await this.folders.findByPath(userId, path);
        if (existing) {
            throw new ConflictException({
                status: 'error',
                message: `A folder already exists at ${path}`,
            });
        }
    }
}
