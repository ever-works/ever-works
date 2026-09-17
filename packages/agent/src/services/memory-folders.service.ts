import {
    BadRequestException,
    ConflictException,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
    UnprocessableEntityException,
} from '@nestjs/common';
import { KB_LIBRARY_FOLDERS_MAX_PER_ORG, KB_LIBRARY_FOLDER_MAX_DEPTH } from '@ever-works/contracts';
import type { EntityManager } from 'typeorm';
import {
    MemoryFolder,
    MemoryFolderScope,
    MemoryFolderSyncRepo,
} from '../entities/memory-folder.entity';
import { MemoryFolderRepository } from '../database/repositories/memory-folder.repository';
import { isUniqueConstraintError } from '../utils/db-error.utils';
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

/** Levels below the root: `/a` is 1, `/a/b` is 2. */
function folderDepth(path: string): number {
    return path.split('/').filter((segment) => segment.length > 0).length;
}

function siblingNameConflict(existingName: string): ConflictException {
    return new ConflictException({
        status: 'error',
        code: 'FolderNameDuplicate',
        message: `A folder called "${existingName}" already exists here.`,
    });
}

function folderDepthError(): UnprocessableEntityException {
    return new UnprocessableEntityException({
        status: 'error',
        code: 'FolderDepthLimit',
        message: `Folders can be nested up to ${KB_LIBRARY_FOLDER_MAX_DEPTH} levels deep.`,
    });
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

    // ─── Shared (organization-scope) folders — the Knowledge library ─────
    //
    // Same table, same materialized-path invariants, same subtree SQL as the
    // per-person tree above, keyed by `organizationId` + `scope =
    // 'organization'` instead of `userId`. Every method below is additive:
    // none of the per-person methods above is touched, so the Files area
    // behaves exactly as it did.
    //
    // The shared tree adds the limits a team shelf needs and a personal tree
    // never had: depth ≤ 5, ≤ 500 folders per Organization, and sibling names
    // unique case-insensitively. Authorization (who may write a shared
    // folder) is the caller's — this service trusts the `organizationId` it
    // is handed, exactly as `aggregateOrgMemory` does.

    /** Every shared folder of the Organization, parents first. */
    async listOrganizationFolders(organizationId: string): Promise<MemoryFolder[]> {
        return this.folders.listByOrganization(organizationId);
    }

    /** The shared folder, or 404 when it is not this Organization's. */
    async requireOrganizationFolder(
        organizationId: string,
        folderId: string,
    ): Promise<MemoryFolder> {
        const folder = await this.folders.findOrganizationFolder(organizationId, folderId);
        if (!folder) {
            throw new NotFoundException({ status: 'error', message: 'Folder not found' });
        }
        return folder;
    }

    /** The shared folder, or `null` when it is not this Organization's. */
    async findOrganizationFolder(
        organizationId: string,
        folderId: string,
    ): Promise<MemoryFolder | null> {
        return this.folders.findOrganizationFolder(organizationId, folderId);
    }

    /**
     * Create a shared folder. The parent lookup, the depth limit, the
     * per-Organization cap, the case-insensitive sibling check and the insert
     * run as ONE unit through {@link MemoryFolderRepository.withOrganizationTree}
     * — a transaction that, on Postgres, first queues behind every other
     * mutation of the same Organization's tree — so two concurrent creates can
     * neither both pass the cap at 499 nor both add "Support" and "support".
     * The case-insensitive path index turns any write that still slips past
     * the check into the same 409.
     */
    async createOrganizationFolder(
        organizationId: string,
        userId: string,
        input: { name: string; parentId?: string | null },
    ): Promise<MemoryFolder> {
        const name = this.validateName(input.name);
        let folder: MemoryFolder;
        try {
            folder = await this.folders.withOrganizationTree(organizationId, async (tree) => {
                const parent = input.parentId
                    ? await this.requireOrganizationFolderIn(tree, organizationId, input.parentId)
                    : null;
                if (parent && folderDepth(parent.path) + 1 > KB_LIBRARY_FOLDER_MAX_DEPTH) {
                    throw folderDepthError();
                }
                const count = await tree.countByOrganization(organizationId);
                if (count >= KB_LIBRARY_FOLDERS_MAX_PER_ORG) {
                    throw new UnprocessableEntityException({
                        status: 'error',
                        code: 'FolderLimitReached',
                        message: `You have ${KB_LIBRARY_FOLDERS_MAX_PER_ORG} folders, the maximum. Delete one to add another.`,
                    });
                }
                await this.assertSiblingNameFree(tree, organizationId, parent?.id ?? null, name);
                const path = this.childPath(parent?.path ?? '', name);
                return tree.create({
                    userId,
                    name,
                    parentId: parent?.id ?? null,
                    path,
                    ownerAgentId: null,
                    syncRepo: null,
                    scope: MemoryFolderScope.ORGANIZATION,
                    organizationId,
                });
            });
        } catch (error) {
            throw await this.siblingNameConflictOr(error, organizationId, input.parentId, name);
        }
        await this.recordActivity(
            userId,
            ActivityActionType.MEMORY_FOLDER_CREATED,
            `Created shared folder ${folder.path}`,
            {
                folderId: folder.id,
                path: folder.path,
                scope: MemoryFolderScope.ORGANIZATION,
                organizationId,
            },
        );
        return folder;
    }

    /**
     * Rename a shared folder. The subtree path rewrite and the folder's own
     * name change commit together (one transaction, serialised per
     * Organization on Postgres), so paths can never disagree with names.
     */
    async renameOrganizationFolder(
        organizationId: string,
        userId: string,
        folderId: string,
        newName: string,
    ): Promise<MemoryFolder> {
        const name = this.validateName(newName);
        let outcome: { folder: MemoryFolder; newPath: string } | null;
        let parentId: string | null = null;
        try {
            outcome = await this.folders.withOrganizationTree(organizationId, async (tree) => {
                const folder = await this.requireOrganizationFolderIn(
                    tree,
                    organizationId,
                    folderId,
                );
                parentId = folder.parentId ?? null;
                if (name === folder.name) return null;
                // A case-only rename ("playbooks" → "Playbooks") is the same sibling.
                await this.assertSiblingNameFree(tree, organizationId, parentId, name, folder.id);
                const newPath = this.childPath(this.parentPathOf(folder.path), name);
                await tree.updateOrganizationSubtreePaths(organizationId, folder.path, newPath);
                await tree.update(folder.id, { name });
                return { folder, newPath };
            });
        } catch (error) {
            throw await this.siblingNameConflictOr(error, organizationId, parentId, name, folderId);
        }
        if (outcome) {
            await this.recordActivity(
                userId,
                ActivityActionType.MEMORY_FOLDER_RENAMED,
                `Renamed shared folder ${outcome.folder.path} to ${outcome.newPath}`,
                {
                    folderId: outcome.folder.id,
                    oldPath: outcome.folder.path,
                    newPath: outcome.newPath,
                    scope: MemoryFolderScope.ORGANIZATION,
                    organizationId,
                },
            );
        }
        return this.requireOrganizationFolder(organizationId, folderId);
    }

    /**
     * Move a shared folder under another one (or to the top level). The
     * cycle and depth checks read the tree inside the same transaction that
     * rewrites the subtree paths and re-parents the folder, so a concurrent
     * move can never turn a checked move into a cycle, and a failure part-way
     * leaves nothing half-moved.
     */
    async moveOrganizationFolder(
        organizationId: string,
        userId: string,
        folderId: string,
        newParentId: string | null,
    ): Promise<MemoryFolder> {
        let folderName = '';
        try {
            await this.folders.withOrganizationTree(organizationId, async (tree) => {
                const folder = await this.requireOrganizationFolderIn(
                    tree,
                    organizationId,
                    folderId,
                );
                folderName = folder.name;
                const newParent = newParentId
                    ? await this.requireOrganizationFolderIn(tree, organizationId, newParentId)
                    : null;
                if (
                    newParent &&
                    (newParent.id === folder.id ||
                        newParent.path === folder.path ||
                        newParent.path.startsWith(`${folder.path}/`))
                ) {
                    throw new UnprocessableEntityException({
                        status: 'error',
                        code: 'FolderCycle',
                        message: 'A folder cannot be moved inside itself.',
                    });
                }
                const newPath = this.childPath(newParent?.path ?? '', folder.name);
                if (newPath === folder.path) return;

                // Depth of the deepest descendant after the move must stay ≤ 5.
                const subtree = await tree.listOrganizationSubtree(organizationId, folder.path);
                const deepest = subtree.reduce((max, f) => Math.max(max, folderDepth(f.path)), 0);
                const deepestAfter = deepest - folderDepth(folder.path) + folderDepth(newPath);
                if (deepestAfter > KB_LIBRARY_FOLDER_MAX_DEPTH) {
                    throw folderDepthError();
                }

                await this.assertSiblingNameFree(
                    tree,
                    organizationId,
                    newParent?.id ?? null,
                    folder.name,
                    folder.id,
                );
                await tree.updateOrganizationSubtreePaths(organizationId, folder.path, newPath);
                await tree.update(folder.id, { parentId: newParent?.id ?? null });
            });
        } catch (error) {
            throw await this.siblingNameConflictOr(
                error,
                organizationId,
                newParentId,
                folderName,
                folderId,
            );
        }
        return this.requireOrganizationFolder(organizationId, folderId);
    }

    /**
     * Delete a shared folder and its whole subtree. Never deletes a document:
     * `unfile` is handed every folder id of the subtree BEFORE the folders
     * go, and must move whatever they hold back to Unfiled (it returns how
     * many it moved, for the activity row). The documents' FK is also
     * `ON DELETE SET NULL`; unfiling first keeps drivers without that FK
     * consistent too.
     *
     * The unfiling and the folder delete are one transaction: `unfile` is
     * handed that transaction's `manager` and must write through it, so a
     * failed delete also puts every document back in its folder.
     */
    async deleteOrganizationFolder(
        organizationId: string,
        userId: string,
        folderId: string,
        unfile: (folderIds: string[], manager?: EntityManager) => Promise<number>,
    ): Promise<{ deletedFolders: number; unfiledDocuments: number }> {
        const { folder, subtree, unfiledDocuments } = await this.folders.withOrganizationTree(
            organizationId,
            async (tree, manager) => {
                const found = await this.requireOrganizationFolderIn(
                    tree,
                    organizationId,
                    folderId,
                );
                const rows = await tree.listOrganizationSubtree(organizationId, found.path);
                const subtreeIds = rows.map((f) => f.id);
                const unfiled = await unfile(subtreeIds, manager);
                await tree.deleteOrganizationFoldersByIds(organizationId, subtreeIds);
                return { folder: found, subtree: rows, unfiledDocuments: unfiled };
            },
        );
        await this.recordActivity(
            userId,
            ActivityActionType.MEMORY_FOLDER_DELETED,
            `Deleted shared folder ${folder.path}`,
            {
                folderId: folder.id,
                path: folder.path,
                deletedFolders: subtree.length,
                unfiledDocuments,
                scope: MemoryFolderScope.ORGANIZATION,
                organizationId,
            },
        );
        return { deletedFolders: subtree.length, unfiledDocuments };
    }

    /**
     * Sibling names are unique case-insensitively — "Support" and "support"
     * side by side on a shared shelf is a mistake, not two folders.
     */
    private async assertSiblingNameFree(
        tree: MemoryFolderRepository,
        organizationId: string,
        parentId: string | null,
        name: string,
        excludeId?: string,
    ): Promise<void> {
        const siblings = await tree.listOrganizationChildren(organizationId, parentId);
        const wanted = name.toLocaleLowerCase();
        const clash = siblings.find(
            (sibling) => sibling.id !== excludeId && sibling.name.toLocaleLowerCase() === wanted,
        );
        if (clash) {
            throw siblingNameConflict(clash.name);
        }
    }

    /** {@link requireOrganizationFolder}, read through the tree's transaction. */
    private async requireOrganizationFolderIn(
        tree: MemoryFolderRepository,
        organizationId: string,
        folderId: string,
    ): Promise<MemoryFolder> {
        const folder = await tree.findOrganizationFolder(organizationId, folderId);
        if (!folder) {
            throw new NotFoundException({ status: 'error', message: 'Folder not found' });
        }
        return folder;
    }

    /**
     * The error a failed shared-tree write should surface. A unique-index
     * violation means a concurrent write took the name after the in-transaction
     * check (only possible where the tree lock does not exist): it becomes the
     * same 409 the check raises, quoting the folder that now holds the name
     * when it can be found. Every other error passes through unchanged.
     */
    private async siblingNameConflictOr(
        error: unknown,
        organizationId: string,
        parentId: string | null | undefined,
        name: string,
        excludeId?: string,
    ): Promise<unknown> {
        if (!isUniqueConstraintError(error)) return error;
        try {
            const siblings = await this.folders.listOrganizationChildren(
                organizationId,
                parentId ?? null,
            );
            const wanted = name.toLocaleLowerCase();
            const clash = siblings.find(
                (sibling) =>
                    sibling.id !== excludeId && sibling.name.toLocaleLowerCase() === wanted,
            );
            return siblingNameConflict(clash?.name ?? name);
        } catch {
            return siblingNameConflict(name);
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
