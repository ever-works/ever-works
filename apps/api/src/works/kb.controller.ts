import {
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
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { KnowledgeBaseService } from '@ever-works/agent/services';
import {
    CreateKbDocumentDto,
    CreateKbTagDto,
    KbDocumentQueryDto,
    LockKbDocumentDto,
    RestoreKbDocumentDto,
    UpdateKbDocumentDto,
    UpdateKbTagDto,
} from '@ever-works/agent/dto';
import { AuthSessionGuard, CurrentUser } from '../auth';
import { AuthenticatedUser } from '@src/auth/types/auth.types';

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
            class: query.class,
            status: query.status,
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
            class: body.class,
            body: body.body,
            description: body.description ?? null,
            tags: body.tags,
            categories: body.categories,
            language: body.language,
            status: body.status,
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
        return this.kb.updateDocument(workId, docId, auth.userId, body);
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
        return this.kb.lockDocument(workId, docId, auth.userId, body.mode);
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
        description: 'Stub in Phase 1A; full Git integration lands in Phase 1B (EW-641).',
    })
    @ApiResponse({ status: 200, description: 'KB document restored' })
    @ApiResponse({ status: 400, description: 'Restore not yet available in Phase 1A' })
    async restoreDocument(
        @CurrentUser() _auth: AuthenticatedUser,
        @Param('id') _workId: string,
        @Param('docId') _docId: string,
        @Body() _body: RestoreKbDocumentDto,
    ) {
        return this.kb.restoreDocumentFromHistory();
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
}
