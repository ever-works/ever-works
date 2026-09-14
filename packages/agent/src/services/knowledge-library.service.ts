import {
    BadRequestException,
    ForbiddenException,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
    UnprocessableEntityException,
} from '@nestjs/common';
import {
    KB_LIBRARY_FILE_BATCH_MAX,
    KB_LIBRARY_PAGE_SIZE_DEFAULT,
    KB_LIBRARY_PAGE_SIZE_MAX,
    KB_LIBRARY_UNFILED,
    type KbDocumentClass as KbDocumentClassContract,
    type KbLibraryDocumentDto,
    type KbLibraryFileResultDto,
    type KbLibraryFolderNodeDto,
    type KbLibraryListDto,
    type KbLibraryListQuery,
    type KbLibraryTreeDto,
    type KbLibraryUnarchiveResultDto,
    type KbDocumentDto,
} from '@ever-works/contracts';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ActivityActionType, ActivityStatus } from '../entities/activity-log.types';
import { WorkKnowledgeDocument } from '../entities/work-knowledge-document.entity';
import { MemoryFolder } from '../entities/memory-folder.entity';
import { KbDocumentClass, KbDocumentStatus } from '../entities/kb-types';
import { WorkMemberRole } from '../entities/types';
import {
    WorkKnowledgeDocumentRepository,
    type KbLibraryScope,
} from '../database/repositories/work-knowledge-document.repository';
import { WorkRepository } from '../database/repositories/work.repository';
import { KnowledgeBaseService } from './knowledge-base.service';
import { MemoryFoldersService } from './memory-folders.service';
import { WorkOwnershipService } from './work-ownership.service';
import { renderKbMarkdownExport } from './kb-markdown-export';

/**
 * Who is acting on the library, and within which Organization.
 *
 * The Organization comes from the request scope context and membership has
 * already been checked by the caller (same contract as `aggregateOrgMemory`).
 * `canManageOrganization` is the caller's answer to "may this person curate
 * organization-level content and shared folders?" — resolved by the API's
 * membership service, which this package cannot depend on.
 */
export interface KnowledgeLibraryActor {
    userId: string;
    organizationId: string;
    canManageOrganization: boolean;
}

/** Work names and ids of the Organization — the shelf's scope. */
interface LibraryScope extends KbLibraryScope {
    workNameById: Map<string, string>;
}

const EDIT_ROLES: ReadonlySet<string> = new Set([
    WorkMemberRole.OWNER,
    WorkMemberRole.MANAGER,
    WorkMemberRole.EDITOR,
]);

/**
 * Knowledge library — the organization-wide shelf over the Knowledge Base.
 *
 * A reading and curation layer, NOT a second store: every document is a
 * `work_knowledge_documents` row, every folder a `memory_folders` row with
 * `scope = 'organization'`, and every mutation of a document (archive,
 * restore) goes through `KnowledgeBaseService`, so the Git mirror, the
 * overlay fanout and the activity trail behave exactly as they do from the
 * per-Work workbench.
 *
 * Scope is the one `aggregateOrgMemory` uses — the documents of every Work
 * in the Organization plus the Organization's own documents — so the shelf
 * and the existing organization knowledge list always agree on what exists.
 * A document id outside that scope is a 404, never a 403 with detail.
 *
 * Per-person read state and pins are not wired in this phase: every row
 * reports `readState: 'read'` and no pin, and every rollup is `false`, so no
 * badge renders until they are.
 */
@Injectable()
export class KnowledgeLibraryService {
    private readonly logger = new Logger(KnowledgeLibraryService.name);

    constructor(
        private readonly documents: WorkKnowledgeDocumentRepository,
        private readonly folders: MemoryFoldersService,
        private readonly knowledgeBase: KnowledgeBaseService,
        private readonly ownership: WorkOwnershipService,
        private readonly works: WorkRepository,
        @Optional() private readonly activityLog?: ActivityLogService,
    ) {}

    // ─── Reads ───────────────────────────────────────────────────────────

    async list(
        actor: KnowledgeLibraryActor,
        query: KbLibraryListQuery = {},
    ): Promise<KbLibraryListDto> {
        const scope = await this.resolveScope(actor.organizationId);
        const limit = clampLimit(query.limit);
        const offset = decodeCursor(query.cursor);
        const folders = await this.folders.listOrganizationFolders(actor.organizationId);
        const folderById = new Map(folders.map((f) => [f.id, f]));

        let folderId: string | null | undefined;
        if (query.folderId === KB_LIBRARY_UNFILED) {
            folderId = null;
        } else if (query.folderId) {
            if (!folderById.has(query.folderId)) {
                throw new NotFoundException({ status: 'error', message: 'Folder not found' });
            }
            folderId = query.folderId;
        }

        // A Work filter narrows to that Work's documents and never widens the
        // scope: an id outside the Organization simply matches nothing.
        let listScope: KbLibraryScope = scope;
        if (query.workId) {
            if (!scope.workNameById.has(query.workId)) {
                return { documents: [], nextCursor: null, total: 0, unreadCount: 0 };
            }
            listScope = { workIds: [query.workId] };
        }
        if (listScope.workIds.length === 0 && !listScope.organizationId) {
            return { documents: [], nextCursor: null, total: 0, unreadCount: 0 };
        }

        const { items, total } = await this.documents.listForLibrary({
            ...listScope,
            folderId,
            archived: query.archived ?? 'exclude',
            classes: query.classes as KbDocumentClass[] | undefined,
            q: query.q,
            sort: query.sort ?? 'recent',
            limit,
            offset,
        });

        const editableWorks = await this.editableWorkIds(actor.userId, items);
        const documents = items.map((doc) =>
            this.toLibraryDto(doc, {
                folderById,
                workNameById: scope.workNameById,
                canEdit: doc.workId ? editableWorks.has(doc.workId) : actor.canManageOrganization,
            }),
        );
        const nextOffset = offset + items.length;
        return {
            documents,
            nextCursor:
                items.length === limit && nextOffset < total ? encodeCursor(nextOffset) : null,
            total,
            unreadCount: 0,
        };
    }

    async tree(actor: KnowledgeLibraryActor): Promise<KbLibraryTreeDto> {
        const scope = await this.resolveScope(actor.organizationId);
        const [folders, counts] = await Promise.all([
            this.folders.listOrganizationFolders(actor.organizationId),
            this.documents.countsForLibrary(scope),
        ]);

        const nodes = new Map<string, KbLibraryFolderNodeDto>();
        for (const folder of folders) {
            nodes.set(folder.id, {
                id: folder.id,
                name: folder.name,
                path: folder.path,
                parentId: folder.parentId ?? null,
                depth: folder.path.split('/').filter(Boolean).length,
                documentCount: counts.byFolder.get(folder.id) ?? 0,
                subtreeDocumentCount: 0,
                hasUnread: false,
                children: [],
            });
        }
        const roots: KbLibraryFolderNodeDto[] = [];
        // `folders` is ordered by path, so every parent is placed before its
        // children; a dangling parent id is shown at the top level.
        for (const folder of folders) {
            const node = nodes.get(folder.id) as KbLibraryFolderNodeDto;
            const parent = folder.parentId ? nodes.get(folder.parentId) : undefined;
            if (parent) parent.children.push(node);
            else roots.push(node);
        }
        const sumSubtree = (node: KbLibraryFolderNodeDto): number => {
            node.subtreeDocumentCount =
                node.documentCount +
                node.children.reduce((sum, child) => sum + sumSubtree(child), 0);
            return node.subtreeDocumentCount;
        };
        roots.forEach(sumSubtree);

        let documentCount = 0;
        let filedInKnownFolders = 0;
        for (const [folderId, count] of counts.byFolder) {
            documentCount += count;
            if (folderId && nodes.has(folderId)) filedInKnownFolders += count;
        }

        return {
            folders: roots,
            // A document pointing at a folder that no longer exists is, to the
            // reader, unfiled.
            unfiled: { documentCount: documentCount - filedInKnownFolders, hasUnread: false },
            documentCount,
            archivedCount: counts.archived,
            hasUnread: false,
            folderCount: folders.length,
            canManageFolders: actor.canManageOrganization,
        };
    }

    /**
     * One document as a shelf row — its folder, Work name, revision and
     * whether the caller may curate it. What the per-Work workbench header
     * reads to show the folder breadcrumb and the File / Archive / Export
     * controls without leaving the Work. Requires view access to the
     * document's Work; a document the person cannot view is reported exactly
     * like one that does not exist.
     */
    async getDocument(
        actor: KnowledgeLibraryActor,
        documentId: string,
    ): Promise<KbLibraryDocumentDto> {
        const doc = await this.requireViewable(actor, documentId);
        return this.reload(actor, doc.id);
    }

    // ─── Curation ────────────────────────────────────────────────────────

    /**
     * File up to 100 documents into one shared folder of the same
     * Organization, or unfile them with `folderId: null`. Requires edit
     * access to every affected document's Work (Organization management for
     * organization documents). Moving a document never changes its revision.
     */
    async fileDocuments(
        actor: KnowledgeLibraryActor,
        input: { documentIds: string[]; folderId: string | null },
    ): Promise<KbLibraryFileResultDto> {
        const ids = [...new Set(input.documentIds)];
        if (ids.length === 0) {
            throw new BadRequestException({
                status: 'error',
                message: 'Pick at least one document.',
            });
        }
        if (ids.length > KB_LIBRARY_FILE_BATCH_MAX) {
            throw new UnprocessableEntityException({
                status: 'error',
                code: 'FileBatchLimit',
                message: `You can file up to ${KB_LIBRARY_FILE_BATCH_MAX} documents at once. ${ids.length} selected.`,
            });
        }
        if (input.folderId) {
            const folder = await this.folders.findOrganizationFolder(
                actor.organizationId,
                input.folderId,
            );
            if (!folder) {
                throw new UnprocessableEntityException({
                    status: 'error',
                    code: 'FolderNotInOrganization',
                    message: 'A document can only be filed into a folder of its own organization.',
                });
            }
        }

        const scope = await this.resolveScope(actor.organizationId);
        const docs = await this.documents.findInLibraryScope(scope, ids);
        if (docs.length !== ids.length) {
            throw new NotFoundException({ status: 'error', message: 'Document not found' });
        }
        await this.assertCanCurate(actor, docs);

        const toMove = docs.filter((doc) => (doc.folderId ?? null) !== input.folderId);
        await this.documents.setFolder(
            toMove.map((doc) => doc.id),
            input.folderId,
        );
        for (const doc of toMove) {
            await this.recordActivity(
                actor.userId,
                ActivityActionType.KB_DOCUMENT_FILED,
                `Filed knowledge document ${doc.title}`,
                doc,
                { fromFolderId: doc.folderId ?? null, toFolderId: input.folderId },
            );
        }
        return { filed: toMove.length, folderId: input.folderId };
    }

    async archive(actor: KnowledgeLibraryActor, documentId: string): Promise<KbLibraryDocumentDto> {
        const doc = await this.requireInScope(actor, documentId);
        if (doc.workId) {
            await this.knowledgeBase.archiveDocument(doc.workId, doc.id, actor.userId);
        } else {
            this.assertCanManageOrganization(actor);
            await this.knowledgeBase.archiveOrgDocument(actor.organizationId, doc.id, actor.userId);
        }
        return this.reload(actor, doc.id);
    }

    async unarchive(
        actor: KnowledgeLibraryActor,
        documentId: string,
    ): Promise<KbLibraryUnarchiveResultDto> {
        const doc = await this.requireInScope(actor, documentId);
        let restoredToUnfiled = false;
        if (doc.workId) {
            const result = await this.knowledgeBase.unarchiveDocument(
                doc.workId,
                doc.id,
                actor.userId,
            );
            restoredToUnfiled = result.restoredToUnfiled;
        } else {
            this.assertCanManageOrganization(actor);
            const result = await this.knowledgeBase.unarchiveOrgDocument(
                actor.organizationId,
                doc.id,
                actor.userId,
            );
            if (!result) {
                throw new NotFoundException({ status: 'error', message: 'Document not found' });
            }
            restoredToUnfiled = result.restoredToUnfiled;
        }
        return { document: await this.reload(actor, doc.id), restoredToUnfiled };
    }

    // ─── Shared folders ──────────────────────────────────────────────────

    async createFolder(
        actor: KnowledgeLibraryActor,
        input: { name: string; parentId?: string | null },
    ): Promise<MemoryFolder> {
        this.assertCanManageOrganization(actor);
        return this.folders.createOrganizationFolder(actor.organizationId, actor.userId, input);
    }

    async renameFolder(
        actor: KnowledgeLibraryActor,
        folderId: string,
        name: string,
    ): Promise<MemoryFolder> {
        this.assertCanManageOrganization(actor);
        return this.folders.renameOrganizationFolder(
            actor.organizationId,
            actor.userId,
            folderId,
            name,
        );
    }

    async moveFolder(
        actor: KnowledgeLibraryActor,
        folderId: string,
        parentId: string | null,
    ): Promise<MemoryFolder> {
        this.assertCanManageOrganization(actor);
        return this.folders.moveOrganizationFolder(
            actor.organizationId,
            actor.userId,
            folderId,
            parentId,
        );
    }

    /** Delete a shared folder: its documents (recursively) move to Unfiled. */
    async deleteFolder(
        actor: KnowledgeLibraryActor,
        folderId: string,
    ): Promise<{ deletedFolders: number; unfiledDocuments: number }> {
        this.assertCanManageOrganization(actor);
        return this.folders.deleteOrganizationFolder(
            actor.organizationId,
            actor.userId,
            folderId,
            (ids) => this.documents.clearFolders(ids),
        );
    }

    // ─── Export ──────────────────────────────────────────────────────────

    /**
     * One document as a Markdown file with YAML front matter, named
     * `<slug>.md`. Requires view access to the document's Work; a document
     * the person cannot view is reported exactly like one that does not
     * exist.
     */
    async exportMarkdown(
        actor: KnowledgeLibraryActor,
        documentId: string,
    ): Promise<{ filename: string; content: string }> {
        const doc = await this.requireViewable(actor, documentId);
        const [scope, folders] = await Promise.all([
            this.resolveScope(actor.organizationId),
            this.folders.listOrganizationFolders(actor.organizationId),
        ]);
        const body = (doc.metadata ?? {}).body;
        const file = renderKbMarkdownExport({
            title: doc.title,
            slug: doc.slug,
            description: doc.description,
            class: doc.kbDocumentClass,
            tags: doc.tags,
            status: doc.status,
            source: doc.source,
            workName: doc.workId ? (scope.workNameById.get(doc.workId) ?? null) : null,
            folderPath: doc.folderId
                ? (folders.find((f) => f.id === doc.folderId)?.path ?? null)
                : null,
            revision: doc.revision ?? 1,
            revisionAt: doc.revisionAt ?? null,
            createdAt: doc.createdAt,
            body: typeof body === 'string' ? body : '',
        });
        await this.recordActivity(
            actor.userId,
            ActivityActionType.KB_DOCUMENT_EXPORTED,
            `Exported knowledge document ${doc.title}`,
            doc,
            { documentIds: [doc.id], format: 'md', documentCount: 1, missingCount: 0 },
        );
        return file;
    }

    // ─── internal ────────────────────────────────────────────────────────

    private async resolveScope(organizationId: string): Promise<LibraryScope> {
        const rows = await this.works.findIdNamesByOrganization(organizationId);
        return {
            workIds: rows.map((row) => row.id),
            organizationId,
            workNameById: new Map(rows.map((row) => [row.id, row.name])),
        };
    }

    private async requireInScope(
        actor: KnowledgeLibraryActor,
        documentId: string,
    ): Promise<WorkKnowledgeDocument> {
        const scope = await this.resolveScope(actor.organizationId);
        const [doc] = await this.documents.findInLibraryScope(scope, [documentId]);
        if (!doc) {
            throw new NotFoundException({ status: 'error', message: 'Document not found' });
        }
        return doc;
    }

    /**
     * A document of the library the person may view. No view access to its
     * Work reads exactly like a document that does not exist (404, same
     * body), so a reader cannot probe for documents they cannot see.
     */
    private async requireViewable(
        actor: KnowledgeLibraryActor,
        documentId: string,
    ): Promise<WorkKnowledgeDocument> {
        const doc = await this.requireInScope(actor, documentId);
        if (doc.workId) {
            try {
                await this.ownership.ensureCanView(doc.workId, actor.userId);
            } catch (error) {
                if (error instanceof ForbiddenException || error instanceof NotFoundException) {
                    throw new NotFoundException({ status: 'error', message: 'Document not found' });
                }
                throw error;
            }
        }
        return doc;
    }

    private async reload(
        actor: KnowledgeLibraryActor,
        documentId: string,
    ): Promise<KbLibraryDocumentDto> {
        const scope = await this.resolveScope(actor.organizationId);
        const [[doc], folders] = await Promise.all([
            this.documents.findInLibraryScope(scope, [documentId]),
            this.folders.listOrganizationFolders(actor.organizationId),
        ]);
        if (!doc) {
            throw new NotFoundException({ status: 'error', message: 'Document not found' });
        }
        const editable = await this.editableWorkIds(actor.userId, [doc]);
        return this.toLibraryDto(doc, {
            folderById: new Map(folders.map((f) => [f.id, f])),
            workNameById: scope.workNameById,
            canEdit: doc.workId ? editable.has(doc.workId) : actor.canManageOrganization,
        });
    }

    /** Works on this page the person may edit — one role lookup per distinct Work. */
    private async editableWorkIds(
        userId: string,
        docs: WorkKnowledgeDocument[],
    ): Promise<Set<string>> {
        const workIds = [
            ...new Set(docs.map((doc) => doc.workId).filter((id): id is string => !!id)),
        ];
        const editable = new Set<string>();
        await Promise.all(
            workIds.map(async (workId) => {
                const role = await this.ownership.getUserRole(workId, userId);
                if (role && EDIT_ROLES.has(role)) editable.add(workId);
            }),
        );
        return editable;
    }

    private async assertCanCurate(
        actor: KnowledgeLibraryActor,
        docs: WorkKnowledgeDocument[],
    ): Promise<void> {
        if (docs.some((doc) => !doc.workId)) {
            this.assertCanManageOrganization(actor);
        }
        const workIds = [
            ...new Set(docs.map((doc) => doc.workId).filter((id): id is string => !!id)),
        ];
        for (const workId of workIds) {
            await this.ownership.ensureCanEdit(workId, actor.userId);
        }
    }

    private assertCanManageOrganization(actor: KnowledgeLibraryActor): void {
        if (!actor.canManageOrganization) {
            throw new ForbiddenException({
                status: 'error',
                code: 'OrganizationManageRequired',
                message: 'You need edit access to change how organization knowledge is filed.',
            });
        }
    }

    private toLibraryDto(
        doc: WorkKnowledgeDocument,
        ctx: {
            folderById: Map<string, MemoryFolder>;
            workNameById: Map<string, string>;
            canEdit: boolean;
        },
    ): KbLibraryDocumentDto {
        const folder = doc.folderId ? ctx.folderById.get(doc.folderId) : undefined;
        const base: KbDocumentDto = {
            id: doc.id,
            workId: doc.workId ?? null,
            organizationId: doc.organizationId ?? null,
            path: doc.path,
            slug: doc.slug,
            title: doc.title,
            description: doc.description ?? null,
            class: doc.kbDocumentClass as KbDocumentClassContract,
            tags: doc.tags ?? [],
            categories: doc.categories ?? [],
            status: doc.status,
            locked: doc.locked,
            lockMode: (doc.lockMode ?? null) as KbDocumentDto['lockMode'],
            language: doc.language,
            wordCount: doc.wordCount ?? null,
            tokenCount: doc.tokenCount ?? null,
            source: doc.source,
            sourceUploadId: doc.sourceUploadId ?? null,
            sourceUrl: doc.sourceUrl ?? null,
            generatedByAgentRunId: doc.generatedByAgentRunId ?? null,
            createdById: doc.createdById ?? null,
            updatedById: doc.updatedById ?? null,
            createdAt: doc.createdAt.toISOString(),
            updatedAt: doc.updatedAt.toISOString(),
            lastCommitSha: doc.lastCommitSha ?? null,
            lastIndexedAt: doc.lastIndexedAt ? doc.lastIndexedAt.toISOString() : null,
            decision: doc.decision ?? null,
            reviewState: doc.reviewState ?? null,
        };
        return {
            ...base,
            // A folder id that no longer resolves reads as Unfiled.
            folderId: folder ? folder.id : null,
            folderPath: folder ? folder.path : null,
            workName: doc.workId ? (ctx.workNameById.get(doc.workId) ?? null) : null,
            revision: doc.revision ?? 1,
            revisionAt: doc.revisionAt ? new Date(doc.revisionAt).toISOString() : null,
            archivedAt:
                doc.status === KbDocumentStatus.ARCHIVED && doc.archivedAt
                    ? new Date(doc.archivedAt).toISOString()
                    : null,
            archivedById:
                doc.status === KbDocumentStatus.ARCHIVED ? (doc.archivedById ?? null) : null,
            readState: 'read',
            pinnedAt: null,
            canEdit: ctx.canEdit,
        };
    }

    private async recordActivity(
        userId: string,
        actionType: ActivityActionType,
        summary: string,
        doc: WorkKnowledgeDocument,
        details: Record<string, unknown>,
    ): Promise<void> {
        if (!this.activityLog) return;
        try {
            await this.activityLog.log({
                userId,
                workId: doc.workId ?? undefined,
                actionType,
                action: actionType,
                status: ActivityStatus.COMPLETED,
                summary,
                details: {
                    documentId: doc.id,
                    workId: doc.workId ?? null,
                    organizationId: doc.organizationId ?? null,
                    ...details,
                },
            });
        } catch (error) {
            this.logger.warn(
                `Failed to record activity ${actionType}: ${(error as Error).message}`,
            );
        }
    }
}

function clampLimit(limit: number | undefined): number {
    if (limit === undefined || !Number.isFinite(limit)) return KB_LIBRARY_PAGE_SIZE_DEFAULT;
    return Math.min(Math.max(Math.trunc(limit), 1), KB_LIBRARY_PAGE_SIZE_MAX);
}

/** Opaque page cursor. Today an offset; callers must not rely on its shape. */
export function encodeCursor(offset: number): string {
    return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): number {
    if (!cursor) return 0;
    try {
        const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
            o?: unknown;
        };
        if (typeof parsed.o === 'number' && Number.isInteger(parsed.o) && parsed.o >= 0) {
            return parsed.o;
        }
    } catch {
        // fall through
    }
    throw new BadRequestException({ status: 'error', message: 'Invalid cursor' });
}
