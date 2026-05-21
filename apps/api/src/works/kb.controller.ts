import {
    BadRequestException,
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    Patch,
    Post,
    Query,
    UploadedFile,
    UseGuards,
    UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
    ApiBearerAuth,
    ApiBody,
    ApiConsumes,
    ApiOperation,
    ApiQuery,
    ApiResponse,
    ApiTags,
} from '@nestjs/swagger';
import { KnowledgeBaseService } from '@ever-works/agent/services';
import {
    CreateKbDocumentDto,
    CreateKbTagDto,
    CreateKbUploadDto,
    KbDocumentQueryDto,
    LockKbDocumentDto,
    RestoreKbDocumentDto,
    UpdateKbDocumentDto,
    UpdateKbTagDto,
} from '@ever-works/agent/dto';
import { AuthSessionGuard, CurrentUser } from '../auth';
import { AuthenticatedUser } from '@src/auth/types/auth.types';
import type {
    KbDocumentClass,
    KbDocumentStatus,
    KbLockMode,
    KbUploadExtractionStatus,
} from '@ever-works/agent/entities';

/** Per-upload byte cap — spec §9.1 default is 200 MB, tunable per tenant. */
const KB_UPLOAD_MAX_BYTES = Number(process.env.KB_UPLOAD_MAX_BYTES) || 200 * 1024 * 1024;

/**
 * Knowledge Base REST surface — per-Work routes.
 *
 * Spec: `docs/specs/features/knowledge-base/spec.md` §12.
 *
 * All routes nest under `/api/works/:id/kb/...` mirroring the existing
 * `WorksController` route convention. A dedicated controller (rather
 * than extending `WorksController`) keeps the KB surface separable
 * for review + future ownership boundaries.
 */
@ApiTags('Knowledge Base')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(AuthSessionGuard)
export class KbController {
    constructor(private readonly kb: KnowledgeBaseService) {}

    // ─── Documents ─────────────────────────────────────────────────────

    @Get('works/:id/kb/documents')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'List KB documents for a Work' })
    @ApiQuery({ name: 'class', required: false })
    @ApiQuery({ name: 'status', required: false })
    @ApiQuery({ name: 'tag', required: false })
    @ApiQuery({ name: 'locked', required: false })
    @ApiQuery({ name: 'q', required: false })
    @ApiQuery({ name: 'limit', required: false })
    @ApiQuery({ name: 'offset', required: false })
    @ApiResponse({ status: 200, description: 'List of KB documents' })
    async listDocuments(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') workId: string,
        @Query() query: KbDocumentQueryDto,
    ) {
        return this.kb.listDocuments(workId, auth.userId, {
            class: query.class as KbDocumentClass | undefined,
            status: query.status as KbDocumentStatus | undefined,
            tag: query.tag,
            locked: query.locked,
            language: query.language,
            q: query.q,
            limit: query.limit,
            offset: query.offset,
        });
    }

    @Post('works/:id/kb/documents')
    @HttpCode(HttpStatus.CREATED)
    @ApiOperation({ summary: 'Create a KB document' })
    @ApiResponse({ status: 201, description: 'KB document created' })
    async createDocument(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') workId: string,
        @Body() body: CreateKbDocumentDto,
    ) {
        return this.kb.createDocument({
            workId,
            userId: auth.userId,
            path: body.path,
            title: body.title,
            class: body.class as KbDocumentClass,
            body: body.body,
            description: body.description ?? null,
            tags: body.tags,
            categories: body.categories,
            language: body.language,
            status: body.status as KbDocumentStatus | undefined,
        });
    }

    @Get('works/:id/kb/documents/:docIdOrPath')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Get a KB document by id or path' })
    @ApiResponse({ status: 200, description: 'KB document body + metadata' })
    async getDocument(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') workId: string,
        @Param('docIdOrPath') docIdOrPath: string,
    ) {
        return this.kb.getDocument(workId, docIdOrPath, auth.userId);
    }

    @Patch('works/:id/kb/documents/:docId')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Update a KB document' })
    @ApiResponse({ status: 200, description: 'KB document updated' })
    async updateDocument(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') workId: string,
        @Param('docId') docId: string,
        @Body() body: UpdateKbDocumentDto,
    ) {
        return this.kb.updateDocument(workId, docId, auth.userId, {
            ...body,
            status: body.status as KbDocumentStatus | undefined,
        });
    }

    @Delete('works/:id/kb/documents/:docId')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({ summary: 'Delete a KB document' })
    @ApiResponse({ status: 204, description: 'KB document deleted' })
    async deleteDocument(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') workId: string,
        @Param('docId') docId: string,
    ) {
        await this.kb.deleteDocument(workId, docId, auth.userId);
    }

    @Post('works/:id/kb/documents/:docId/lock')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Lock a KB document' })
    @ApiResponse({ status: 200, description: 'KB document locked' })
    async lockDocument(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') workId: string,
        @Param('docId') docId: string,
        @Body() body: LockKbDocumentDto,
    ) {
        return this.kb.lockDocument(workId, docId, auth.userId, body.mode as KbLockMode);
    }

    @Post('works/:id/kb/documents/:docId/unlock')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Unlock a KB document' })
    @ApiResponse({ status: 200, description: 'KB document unlocked' })
    async unlockDocument(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') workId: string,
        @Param('docId') docId: string,
    ) {
        return this.kb.unlockDocument(workId, docId, auth.userId);
    }

    @Post('works/:id/kb/documents/:docId/restore')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Restore a KB document to a prior Git commit',
        description:
            'Reads the body at the supplied commit SHA from the Work data repo, applies it to the document row, and enqueues a fresh Git mirror so the head commit moves forward with the restored content.',
    })
    @ApiResponse({ status: 200, description: 'KB document restored' })
    @ApiResponse({ status: 404, description: 'Document or commit not found' })
    async restoreDocument(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') workId: string,
        @Param('docId') docId: string,
        @Body() body: RestoreKbDocumentDto,
    ) {
        return this.kb.restoreDocumentFromHistory(workId, docId, auth.userId, body.commitSha);
    }

    @Get('works/:id/kb/documents/:docId/citations')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'List citations referencing a KB document' })
    @ApiResponse({ status: 200, description: 'Citation rows' })
    async listCitations(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') workId: string,
        @Param('docId') docId: string,
    ) {
        return this.kb.listCitationsForDocument(workId, docId, auth.userId);
    }

    // ─── Tags ──────────────────────────────────────────────────────────

    @Get('works/:id/kb/tags')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'List per-Work KB tags' })
    @ApiResponse({ status: 200, description: 'List of tags' })
    async listTags(@CurrentUser() auth: AuthenticatedUser, @Param('id') workId: string) {
        return this.kb.listTags(workId, auth.userId);
    }

    @Post('works/:id/kb/tags')
    @HttpCode(HttpStatus.CREATED)
    @ApiOperation({ summary: 'Create a KB tag' })
    @ApiResponse({ status: 201, description: 'Tag created' })
    async createTag(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') workId: string,
        @Body() body: CreateKbTagDto,
    ) {
        return this.kb.createTag(workId, auth.userId, body);
    }

    @Patch('works/:id/kb/tags/:tagId')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Update a KB tag' })
    @ApiResponse({ status: 200, description: 'Tag updated' })
    async updateTag(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') workId: string,
        @Param('tagId') tagId: string,
        @Body() body: UpdateKbTagDto,
    ) {
        return this.kb.updateTag(workId, tagId, auth.userId, body);
    }

    @Delete('works/:id/kb/tags/:tagId')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({ summary: 'Delete a KB tag' })
    @ApiResponse({ status: 204, description: 'Tag deleted' })
    async deleteTag(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') workId: string,
        @Param('tagId') tagId: string,
    ) {
        await this.kb.deleteTag(workId, tagId, auth.userId);
    }

    // ─── Uploads (EW-641 1B/b) ────────────────────────────────────────

    @Post('works/:id/kb/uploads')
    @HttpCode(HttpStatus.CREATED)
    @UseInterceptors(FileInterceptor('file', { limits: { fileSize: KB_UPLOAD_MAX_BYTES } }))
    @ApiConsumes('multipart/form-data')
    @ApiOperation({
        summary: 'Upload a source file to the Knowledge Base',
        description:
            'Multipart upload of a file destined for the KB. Server computes SHA-256, dedups against existing uploads in the same Work, persists bytes via the configured storage plugin, and synchronously creates a KB document for text-passthrough MIME types (markdown / plain). Non-text MIMEs are stored with extractionStatus=skipped pending Phase 1B/c extractor routing.',
    })
    @ApiBody({
        schema: {
            type: 'object',
            required: ['file'],
            properties: {
                file: { type: 'string', format: 'binary' },
                targetClass: {
                    type: 'string',
                    description: 'Optional kbDocumentClass for the resulting document',
                },
                title: { type: 'string' },
                description: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' } },
            },
        },
    })
    @ApiResponse({
        status: 201,
        description: 'Upload accepted; returns the upload row + the created KB doc (if any)',
    })
    @ApiResponse({ status: 400, description: 'Missing file or invalid metadata' })
    @ApiResponse({ status: 413, description: 'File exceeds the configured size cap' })
    @ApiResponse({ status: 503, description: 'Storage plugin not configured' })
    async createUpload(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') workId: string,
        @UploadedFile() file: Express.Multer.File | undefined,
        @Body() body: CreateKbUploadDto,
    ) {
        if (!file) {
            throw new BadRequestException({
                status: 'error',
                message: "Multipart field 'file' is required",
            });
        }
        return this.kb.createUpload({
            workId,
            userId: auth.userId,
            file: {
                buffer: file.buffer,
                originalFilename: file.originalname,
                mimeType: file.mimetype,
                size: file.size,
            },
            // Cast at the controller→service boundary — contracts package
            // exposes the class union as string literals while the agent
            // entity package keeps it as a runtime enum (Phase 1A handoff
            // gotcha #6). Runtime-equivalent, nominally distinct.
            targetClass: body.targetClass as KbDocumentClass | undefined,
            tags: body.tags,
            description: body.description ?? null,
            title: body.title,
        });
    }

    @Get('works/:id/kb/uploads')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'List KB uploads for a Work' })
    @ApiQuery({ name: 'status', required: false })
    @ApiQuery({ name: 'limit', required: false, type: Number })
    @ApiQuery({ name: 'offset', required: false, type: Number })
    @ApiResponse({ status: 200, description: 'Paginated list of upload rows' })
    async listUploads(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') workId: string,
        @Query('status') status?: KbUploadExtractionStatus,
        @Query('limit') limit?: string,
        @Query('offset') offset?: string,
    ) {
        return this.kb.listUploads(workId, auth.userId, {
            status,
            limit: limit !== undefined ? Number(limit) : undefined,
            offset: offset !== undefined ? Number(offset) : undefined,
        });
    }

    @Get('works/:id/kb/uploads/:uploadId')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Get a single KB upload row' })
    @ApiResponse({ status: 200, description: 'Upload row' })
    @ApiResponse({ status: 404, description: 'Upload not found' })
    async getUpload(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') workId: string,
        @Param('uploadId') uploadId: string,
    ) {
        return this.kb.getUpload(workId, uploadId, auth.userId);
    }

    @Post('works/:id/kb/uploads/:uploadId/retry-extraction')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Re-run extraction for a failed or skipped KB upload',
        description:
            'Owner / manager only. Reads the persisted bytes from storage and runs extract+materialize again. If the MIME type still has no extractor route (Phase 1B/b text passthrough only), the upload stays skipped with an updated reason.',
    })
    @ApiResponse({ status: 200, description: 'Re-extraction kicked off / completed' })
    @ApiResponse({ status: 403, description: 'Manager+ role required' })
    @ApiResponse({ status: 404, description: 'Upload not found' })
    @ApiResponse({ status: 409, description: 'Upload already produced a KB document' })
    async retryUploadExtraction(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') workId: string,
        @Param('uploadId') uploadId: string,
    ) {
        return this.kb.retryUploadExtraction(workId, uploadId, auth.userId);
    }
}
