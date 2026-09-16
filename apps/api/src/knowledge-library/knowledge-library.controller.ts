import {
    Body,
    Controller,
    Get,
    Header,
    HttpCode,
    HttpStatus,
    NotFoundException,
    Param,
    ParseUUIDPipe,
    Patch,
    Post,
    Query,
    Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { KnowledgeLibraryService, type KnowledgeLibraryActor } from '@ever-works/agent/services';
import type {
    KbLibraryDocumentDto,
    KbLibraryFileResultDto,
    KbLibraryListDto,
    KbLibraryTreeDto,
    KbLibraryUnarchiveResultDto,
} from '@ever-works/contracts';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { OrganizationMembershipService } from '../organizations/organization-membership.service';
import { ScopeContextService } from '../scope';
import {
    ExportKnowledgeDocumentQueryDto,
    FileKnowledgeDocumentsDto,
    KnowledgeLibraryQueryDto,
} from './dto/knowledge-library.dto';

// Minimal Express response surface — mirrors kb.controller.ts to avoid
// pulling the full express type graph into this module.
type ServeResponse = {
    setHeader(name: string, value: string | number): void;
    send(body: string | Buffer): void;
};

const EMPTY_LIST: KbLibraryListDto = { documents: [], nextCursor: null, total: 0, unreadCount: 0 };

const EMPTY_TREE: KbLibraryTreeDto = {
    folders: [],
    unfiled: { documentCount: 0, hasUnread: false },
    documentCount: 0,
    archivedCount: 0,
    hasUnread: false,
    folderCount: 0,
    canManageFolders: false,
};

/**
 * Knowledge library — the organization shelf over the Knowledge Base.
 *
 * Authenticated by the global session guard (registered as an app guard, the
 * same way `MemoryFilesController` and `WorkspaceSearchController` rely on
 * it). Session-scoped exactly like `OrgMemoryController`: the Organization comes
 * from the request SCOPE CONTEXT (never a param), membership is asserted on
 * every call, and with no active Organization the reads return an empty
 * shelf rather than scanning anything. A document or folder outside the
 * Organization is a 404, never a 403 with detail.
 *
 * Shared-folder create / rename / move / delete live on the existing folder
 * surface (`/api/memory/files/folders` with `scope=organization`) so there is
 * one folder API; finding a document by name is the existing workspace
 * search (its `knowledge` kind). This controller serves the shelf itself.
 */
@ApiTags('Knowledge Library')
@ApiBearerAuth('JWT-auth')
@Controller('api/knowledge')
export class KnowledgeLibraryController {
    constructor(
        private readonly library: KnowledgeLibraryService,
        private readonly membership: OrganizationMembershipService,
        private readonly scopeContext: ScopeContextService,
    ) {}

    @Get('library')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'The knowledge library — one page of the organization shelf',
        description:
            'Every Knowledge Base document of every Work in the active Organization plus its organization documents, filterable by shared folder (or `unfiled`), archived state (excluded by default), class, Work and free text over title, description and slug. Sorted by the last substantive change by default. Cursor-paginated: 50 per page by default, never more than 200.',
    })
    @ApiQuery({
        name: 'folderId',
        required: false,
        description: 'A shared folder id, or `unfiled`',
    })
    @ApiQuery({ name: 'archived', required: false, enum: ['exclude', 'only', 'include'] })
    @ApiQuery({ name: 'q', required: false })
    @ApiQuery({ name: 'class', required: false, isArray: true })
    @ApiQuery({ name: 'workId', required: false })
    @ApiQuery({ name: 'sort', required: false, enum: ['recent', 'title', 'unread'] })
    @ApiQuery({ name: 'limit', required: false, description: '1–200, default 50' })
    @ApiQuery({ name: 'cursor', required: false })
    @ApiResponse({ status: 200, description: '{ documents, nextCursor, total, unreadCount }' })
    @ApiResponse({
        status: 404,
        description: 'Folder filter is not a shared folder of this Organization',
    })
    async list(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: KnowledgeLibraryQueryDto,
    ): Promise<KbLibraryListDto> {
        const actor = await this.resolveActor(auth);
        if (!actor) return EMPTY_LIST;
        return this.library.list(actor, {
            folderId: query.folderId,
            archived: query.archived,
            q: query.q,
            classes: query.class,
            workId: query.workId,
            sort: query.sort,
            limit: query.limit,
            cursor: query.cursor,
        });
    }

    @Get('tree')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'The knowledge library folder rail',
        description:
            'Shared folders of the active Organization as a tree with direct and subtree document counts, plus the Unfiled and Archived totals, the folder count against the 500 cap, and whether the caller may manage shared folders.',
    })
    @ApiResponse({ status: 200, description: 'KbLibraryTreeDto' })
    async tree(@CurrentUser() auth: AuthenticatedUser): Promise<KbLibraryTreeDto> {
        const actor = await this.resolveActor(auth);
        if (!actor) return EMPTY_TREE;
        return this.library.tree(actor);
    }

    @Patch('documents/file')
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    @ApiOperation({
        summary: 'File documents into a shared folder (folderId null = Unfiled)',
        description:
            'Moves up to 100 documents in one action. Requires edit access to every affected Work. Only a folder of the same Organization is accepted. Filing never changes a document’s revision; each moved document gets an activity entry.',
    })
    @ApiResponse({ status: 200, description: '{ filed, folderId }' })
    @ApiResponse({ status: 403, description: 'No edit access to an affected Work' })
    @ApiResponse({ status: 404, description: 'A document is not in this Organization' })
    @ApiResponse({
        status: 422,
        description: 'Over 100 documents, or a folder of another Organization',
    })
    async file(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: FileKnowledgeDocumentsDto,
    ): Promise<KbLibraryFileResultDto> {
        const actor = await this.requireActor(auth);
        return this.library.fileDocuments(actor, {
            documentIds: body.documentIds,
            folderId: body.folderId,
        });
    }

    @Post('documents/:docId/archive')
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Archive a document from the shelf (never a delete)',
        description:
            'Same transition as the per-Work archive action, reachable for any document of the Organization. The document stays readable and exportable, leaves the default listing and agent context, and keeps its folder, history and pins. Idempotent.',
    })
    @ApiResponse({ status: 200, description: 'The archived document as a library row' })
    @ApiResponse({ status: 404, description: 'Document not in this Organization' })
    async archive(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('docId', new ParseUUIDPipe()) docId: string,
    ): Promise<KbLibraryDocumentDto> {
        const actor = await this.requireActor(auth);
        return this.library.archive(actor, docId);
    }

    @Post('documents/:docId/unarchive')
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Restore an archived document to the shelf',
        description:
            'The inverse of archive — NOT the per-Work `/restore`, which restores a body from a Git commit. Returns the document to the folder it was archived from; `restoredToUnfiled` is true when that folder no longer exists. Idempotent.',
    })
    @ApiResponse({ status: 200, description: '{ document, restoredToUnfiled }' })
    @ApiResponse({ status: 404, description: 'Document not in this Organization' })
    async unarchive(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('docId', new ParseUUIDPipe()) docId: string,
    ): Promise<KbLibraryUnarchiveResultDto> {
        const actor = await this.requireActor(auth);
        return this.library.unarchive(actor, docId);
    }

    @Get('documents/:docId/export')
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    @Header('X-Content-Type-Options', 'nosniff')
    @Header('Cache-Control', 'private, no-store')
    @ApiOperation({
        summary: 'Export one document as Markdown',
        description:
            'A single `<slug>.md` file: YAML front matter with the document’s metadata, then its body. Requires view access to the document’s Work; a document the caller cannot view is reported as not found.',
    })
    @ApiQuery({ name: 'format', required: false, enum: ['md'] })
    @ApiResponse({ status: 200, description: 'text/markdown attachment' })
    @ApiResponse({ status: 404, description: 'Document not found' })
    async export(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('docId', new ParseUUIDPipe()) docId: string,
        @Query() _query: ExportKnowledgeDocumentQueryDto,
        @Res() res: ServeResponse,
    ): Promise<void> {
        const actor = await this.requireActor(auth);
        const file = await this.library.exportMarkdown(actor, docId);
        const buffer = Buffer.from(file.content, 'utf8');
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
        res.setHeader('Content-Length', buffer.length);
        res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
        res.send(buffer);
    }

    // ─── internal ────────────────────────────────────────────────────────

    /**
     * The acting person in the active Organization, or `null` when there is
     * no active Organization. Membership is asserted (404 on a mismatch —
     * the existence-leak contract). Managing organization content goes
     * through `ensureAdmin`, the single seam a future Organization admin
     * role tightens.
     */
    private async resolveActor(auth: AuthenticatedUser): Promise<KnowledgeLibraryActor | null> {
        const organizationId = this.scopeContext.getOrganizationId();
        if (!organizationId) return null;
        await this.membership.ensureMember(organizationId, auth.userId);
        let canManageOrganization = false;
        try {
            await this.membership.ensureAdmin(organizationId, auth.userId);
            canManageOrganization = true;
        } catch {
            canManageOrganization = false;
        }
        return { userId: auth.userId, organizationId, canManageOrganization };
    }

    private async requireActor(auth: AuthenticatedUser): Promise<KnowledgeLibraryActor> {
        const actor = await this.resolveActor(auth);
        if (!actor) {
            throw new NotFoundException({ status: 'error', message: 'Document not found' });
        }
        return actor;
    }
}
