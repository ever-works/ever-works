import {
    BadRequestException,
    Body,
    Controller,
    Delete,
    Get,
    Header,
    HttpCode,
    HttpStatus,
    Logger,
    NotFoundException,
    Param,
    ParseUUIDPipe,
    Patch,
    Post,
    Query,
    Res,
    UploadedFile,
    UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
    MemoryFilesService,
    MemoryFoldersService,
    MemoryFolderSyncService,
    KnowledgeBaseService,
    type MemoryFileRow,
} from '@ever-works/agent/services';
import { UserUploadRepository, WorkKnowledgeUploadRepository } from '@ever-works/agent/database';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { ScopeContextService } from '../scope';
import { OrganizationMembershipService } from '../organizations/organization-membership.service';
import { UploadsService } from '../uploads/uploads.service';
import {
    CreateMemoryFolderDto,
    DeleteMemoryFolderQueryDto,
    DownloadMemoryFileQueryDto,
    ListMemoryFilesQueryDto,
    MoveMemoryFilesDto,
    UpdateMemoryFolderDto,
    UploadMemoryFileDto,
} from './dto/memory-files.dto';

const UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

// Minimal Express response surface — mirrors uploads.controller.ts to
// avoid pulling the full express type graph into this module.
type ServeResponse = {
    status(code: number): ServeResponse;
    setHeader(name: string, value: string | number): void;
    json(body: unknown): void;
    send(body: string | Buffer): void;
};

/** Active content types are never served with their real MIME (see uploads.controller). */
const ACTIVE_MIMES = new Set([
    'text/html',
    'text/css',
    'text/javascript',
    'application/javascript',
]);

/**
 * Memory Files — the unified Files area of /memory.
 *
 * One surface over BOTH upload spines (`user_uploads` chat/plain uploads
 * and `work_knowledge_uploads` KB originals), organized into the
 * caller's `memory_folders` tree. Everything here is USER-scoped: rows
 * resolve against the caller's own uploads / Works / active-org Memory,
 * and any cross-user id is a 404 (never 403). The active Organization —
 * used only to include org-scoped Memory originals — comes from the
 * request scope context, never a param, matching OrgMemoryController.
 *
 * Deletion here NEVER destroys bytes (v1 additive rule): DELETE on a
 * file only unfiles it; folder delete unlinks and removes the tree.
 */
@ApiTags('Memory Files')
@ApiBearerAuth('JWT-auth')
@Controller('api/memory/files')
export class MemoryFilesController {
    private readonly logger = new Logger(MemoryFilesController.name);

    constructor(
        private readonly foldersService: MemoryFoldersService,
        private readonly filesService: MemoryFilesService,
        private readonly syncService: MemoryFolderSyncService,
        private readonly kb: KnowledgeBaseService,
        private readonly uploads: UploadsService,
        private readonly userUploads: UserUploadRepository,
        private readonly kbUploads: WorkKnowledgeUploadRepository,
        private readonly scopeContext: ScopeContextService,
        private readonly membership: OrganizationMembershipService,
    ) {}

    @Get('tree')
    @ApiOperation({
        summary: 'The caller’s Memory folder tree with per-folder file counts',
    })
    @ApiResponse({ status: 200, description: '{ folders }' })
    async getTree(@CurrentUser() auth: AuthenticatedUser) {
        const folders = await this.foldersService.getTree(auth.userId);
        return { folders };
    }

    @Get()
    @ApiOperation({
        summary: 'Unified file list — chat uploads + KB originals, one shape',
        description:
            'Lists the caller’s files across both upload spines as unified rows with provenance (work/task/mission/idea/agent/chat) mapped from the attachment edge tables. `folderId` lists one folder; omitted = the unfiled root. `q` searches every folder.',
    })
    @ApiResponse({ status: 200, description: '{ files }' })
    async list(@CurrentUser() auth: AuthenticatedUser, @Query() query: ListMemoryFilesQueryDto) {
        const organizationId = this.scopeContext.getOrganizationId() ?? undefined;
        const files = await this.filesService.list(auth.userId, {
            organizationId,
            // Search spans everything; browsing is folder-scoped with the
            // root (unfiled) as the default.
            folderId: query.q ? undefined : (query.folderId ?? null),
            source: query.source,
            q: query.q,
        });
        return { files };
    }

    @Post('upload')
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    @UseInterceptors(FileInterceptor('file', { limits: { fileSize: UPLOAD_MAX_BYTES } }))
    @ApiOperation({
        summary: 'Upload a file into a Memory folder',
        description:
            'Multipart upload through the existing UploadsService validation pipeline (magic-byte sniff, size caps, sha256 keys), then files the resulting upload row into `folderId` (or the root when omitted).',
    })
    @ApiResponse({ status: 201, description: 'UploadResult + folderId' })
    async upload(
        @CurrentUser() auth: AuthenticatedUser,
        @UploadedFile() file: Express.Multer.File | undefined,
        @Body() body: UploadMemoryFileDto,
    ) {
        if (!file) {
            throw new BadRequestException({
                status: 'error',
                message: "Multipart field 'file' is required",
            });
        }
        // Validate folder ownership BEFORE storing bytes so a bad folder id
        // fails the request instead of leaving an unfiled surprise.
        if (body.folderId) {
            await this.foldersService.requireOwned(auth.userId, body.folderId);
        }
        const result = await this.uploads.saveFile(auth.userId, file);
        // `UploadsService` records the `user_uploads` ownership row on a
        // best-effort path (it swallows its own failures), so the filing
        // update can legitimately match zero rows. Report what actually
        // happened instead of echoing the requested folder: a response
        // claiming `folderId` for a file that is not in the folder — and
        // not in the Files area at all — is indistinguishable from
        // success to every client.
        let filedInto: string | null = null;
        if (body.folderId) {
            const filed = await this.userUploads.setFolderBySha256(
                auth.userId,
                result.hash,
                body.folderId,
            );
            if (filed) {
                filedInto = body.folderId;
            } else {
                this.logger.warn(
                    `Upload ${result.hash.slice(0, 12)}… could not be filed into folder ${body.folderId}: no upload row to update`,
                );
            }
        }
        return { ...result, folderId: filedInto };
    }

    @Post('folders')
    @HttpCode(HttpStatus.CREATED)
    @ApiOperation({ summary: 'Create a Memory folder (Global, or agent-private)' })
    @ApiResponse({ status: 201, description: 'The created folder' })
    @ApiResponse({ status: 409, description: 'A folder with that path already exists' })
    async createFolder(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: CreateMemoryFolderDto,
    ) {
        return this.foldersService.createFolder(auth.userId, {
            name: body.name,
            parentId: body.parentId ?? null,
            ownerAgentId: body.ownerAgentId ?? null,
        });
    }

    @Patch('folders/:id')
    @ApiOperation({
        summary: 'Rename / move a folder, or configure its git-sync target',
    })
    @ApiResponse({ status: 200, description: 'The updated folder' })
    @ApiResponse({ status: 404, description: 'No such folder for this user' })
    @ApiResponse({ status: 422, description: 'Illegal move (into own subtree)' })
    async updateFolder(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', new ParseUUIDPipe()) id: string,
        @Body() body: UpdateMemoryFolderDto,
    ) {
        if (body.name !== undefined) {
            await this.foldersService.renameFolder(auth.userId, id, body.name);
        }
        if (body.moveToRoot) {
            await this.foldersService.moveFolder(auth.userId, id, null);
        } else if (body.parentId !== undefined) {
            await this.foldersService.moveFolder(auth.userId, id, body.parentId);
        }
        if (body.clearSyncRepo) {
            await this.foldersService.configureSync(auth.userId, id, null);
        } else if (body.syncRepo !== undefined) {
            await this.foldersService.configureSync(auth.userId, id, body.syncRepo);
        }
        return this.foldersService.requireOwned(auth.userId, id);
    }

    @Delete('folders/:id')
    @ApiOperation({
        summary: 'Delete a folder (422 unless empty or recursive=true)',
        description:
            'Refuses while the subtree holds folders or files unless recursive=true; even then files are only UNLINKED back to the root — bytes are never destroyed.',
    })
    @ApiResponse({ status: 200, description: '{ deletedFolders, unlinkedFiles }' })
    @ApiResponse({ status: 404, description: 'No such folder for this user' })
    @ApiResponse({ status: 422, description: 'Folder not empty and recursive not set' })
    async deleteFolder(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', new ParseUUIDPipe()) id: string,
        @Query() query: DeleteMemoryFolderQueryDto,
    ) {
        return this.foldersService.deleteFolder(auth.userId, id, {
            recursive: query.recursive === 'true',
        });
    }

    @Post('folders/:id/sync')
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Manual "Sync now" — commit the folder’s files to its git repo',
        description:
            'Walks the folder subtree and commits every file (≤5MB) to the configured repo/branch/dirPrefix via the git facade. Returns per-file results including a skip list. 422 when no syncRepo is configured.',
    })
    @ApiResponse({ status: 200, description: '{ folderId, commitSha, results }' })
    @ApiResponse({ status: 404, description: 'No such folder for this user' })
    @ApiResponse({ status: 422, description: 'No syncRepo configured on the folder' })
    async syncFolder(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', new ParseUUIDPipe()) id: string,
    ) {
        const organizationId = this.scopeContext.getOrganizationId() ?? undefined;
        return this.syncService.syncFolder(auth.userId, id, {
            organizationId,
            readBytes: (row) => this.readFileBytes(auth.userId, organizationId, row),
        });
    }

    @Patch('move')
    @ApiOperation({
        summary: 'Move file(s) into a folder (folderId=null unfiles them)',
    })
    @ApiResponse({ status: 200, description: '{ moved }' })
    @ApiResponse({ status: 404, description: 'A file or the folder was not found' })
    async moveFiles(@CurrentUser() auth: AuthenticatedUser, @Body() body: MoveMemoryFilesDto) {
        const organizationId = this.scopeContext.getOrganizationId() ?? undefined;
        return this.filesService.moveFiles(auth.userId, body.files, body.folderId, {
            organizationId,
        });
    }

    @Delete(':id')
    @ApiOperation({
        summary: 'Remove a file from the Files area (unlink only — bytes stay)',
        description:
            'v1 additive rule: this only clears the folder membership so the file returns to the unfiled root. Destroying upload bytes is out of scope.',
    })
    @ApiResponse({ status: 200, description: '{ moved }' })
    @ApiResponse({ status: 404, description: 'No such file for this user' })
    async unlinkFile(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', new ParseUUIDPipe()) id: string,
        @Query() query: DownloadMemoryFileQueryDto,
    ) {
        const organizationId = this.scopeContext.getOrganizationId() ?? undefined;
        return this.filesService.moveFiles(auth.userId, [{ source: query.source, id }], null, {
            organizationId,
        });
    }

    @Get(':id/download')
    @Header(
        'Content-Security-Policy',
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    )
    @Header('X-Content-Type-Options', 'nosniff')
    @Header('Cache-Control', 'private, max-age=300')
    @ApiOperation({
        summary: 'Download a file’s bytes (owner-gated, both spines)',
        description:
            'Delegates to the spine that stored the bytes: UploadsService.readFile for chat/plain uploads, the KB storage plugin for KB originals (per-Work rows re-check Work view access; org rows re-check org membership). Same CSP/nosniff/active-MIME-collapse posture as the /api/uploads serve route.',
    })
    async download(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', new ParseUUIDPipe()) id: string,
        @Query() query: DownloadMemoryFileQueryDto,
        @Res() res: ServeResponse,
    ) {
        const organizationId = this.scopeContext.getOrganizationId() ?? undefined;
        const { buffer, mimeType, filename } = await this.resolveBytes(
            auth.userId,
            organizationId,
            query.source,
            id,
        );
        const baseMime = mimeType.split(';')[0].trim().toLowerCase();
        const safeMime = ACTIVE_MIMES.has(baseMime) ? 'application/octet-stream' : mimeType;
        // CR/LF/quotes would allow header injection via a hostile filename.
        const safeFilename = filename.replace(/["\r\n]/g, '_').slice(0, 200) || 'download';
        res.setHeader('Content-Type', safeMime);
        res.setHeader('Content-Length', buffer.length);
        res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
        res.send(buffer);
    }

    // ─── internal ────────────────────────────────────────────────────────

    private async resolveBytes(
        userId: string,
        organizationId: string | undefined,
        source: 'upload' | 'kb-upload',
        id: string,
    ): Promise<{ buffer: Buffer; mimeType: string; filename: string }> {
        if (source === 'upload') {
            const row = await this.userUploads.findByIdOwned(id, userId);
            if (!row) {
                throw new NotFoundException({ status: 'error', message: 'File not found' });
            }
            // The stored object's basename is what readFile keys on — same
            // derivation the Memory ingest path uses (org-memory.controller).
            const filename = row.storagePath.split('/').pop() ?? '';
            const { buffer, mimeType } = await this.uploads.readFile(userId, filename, {
                workId: row.workId ?? undefined,
            });
            return { buffer, mimeType, filename: row.originalFilename ?? filename };
        }

        const row = await this.kbUploads.findForMemoryFiles(id, { userId, organizationId });
        if (!row) {
            throw new NotFoundException({ status: 'error', message: 'File not found' });
        }
        if (row.workId) {
            const bytes = await this.kb.getUploadBytes(row.workId, row.id, userId);
            return { buffer: bytes.buffer, mimeType: bytes.mimeType, filename: bytes.filename };
        }
        if (!organizationId) {
            throw new NotFoundException({ status: 'error', message: 'File not found' });
        }
        // Defense-in-depth for org originals: membership, like OrgMemoryController.
        await this.membership.ensureMember(organizationId, userId);
        const bytes = await this.kb.getOrgUploadBytes(organizationId, row.id);
        return { buffer: bytes.buffer, mimeType: bytes.mimeType, filename: bytes.filename };
    }

    /** Byte reader handed to the sync walk — one row at a time, both spines. */
    private async readFileBytes(
        userId: string,
        organizationId: string | undefined,
        row: MemoryFileRow,
    ): Promise<Buffer> {
        const { buffer } = await this.resolveBytes(userId, organizationId, row.source, row.id);
        return buffer;
    }
}
