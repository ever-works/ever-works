import {
    BadRequestException,
    Body,
    Controller,
    Delete,
    Get,
    Header,
    HttpCode,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Patch,
    Post,
    Query,
    Res,
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
    TransitionKbDecisionStatusDto,
    UpdateKbDocumentDto,
    UpdateKbTagDto,
} from '@ever-works/agent/dto';
import { AuthSessionGuard, CurrentUser } from '../auth';
import { AuthenticatedUser } from '@src/auth/types/auth.types';
import type {
    KbDecisionStatus,
    KbDocumentClass,
    KbDocumentSource,
    KbDocumentStatus,
    KbLockMode,
    KbReviewState,
    KbUploadExtractionStatus,
} from '@ever-works/agent/entities';

/** Per-upload byte cap — spec §9.1 default is 200 MB, tunable per tenant. */
const KB_UPLOAD_MAX_BYTES = Number(process.env.KB_UPLOAD_MAX_BYTES) || 200 * 1024 * 1024;

/**
 * Minimal Express response surface for `@Res()`-streamed routes. Mirrors
 * the local pattern in `uploads.controller.ts` to avoid pulling the full
 * express type-graph into this module (it conflicts with the global
 * `Express.Response` namespace used elsewhere in the build).
 */
type ServeResponse = {
    status(code: number): ServeResponse;
    setHeader(name: string, value: string | number): void;
    json(body: unknown): void;
    send(body: string | Buffer): void;
};

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
    @ApiQuery({
        name: 'reviewState',
        required: false,
        enum: ['proposed', 'accepted'],
        description:
            'Memory upgrades M8 — review-queue filter. `proposed` lists only agent-authored / synthesized documents awaiting human review (excluded from context injection until accepted); `accepted` lists the reviewed set including pre-M7 rows whose column is NULL. Omit to list everything.',
    })
    @ApiQuery({
        name: 'class',
        required: false,
        isArray: true,
        description:
            'Memory facets — repeatable class filter behind the workbench type chips (`?class=decision&class=output`). A single value keeps the original single-class behaviour.',
    })
    @ApiQuery({
        name: 'source',
        required: false,
        isArray: true,
        enum: ['user', 'agent', 'imported', 'seeded'],
        description:
            'Memory facets — repeatable provenance filter. The rendered badge (human / agent / synthesized / connector) is DERIVED from this plus the ingest provenance; the filter itself stays on the stored column.',
    })
    @ApiQuery({
        name: 'searchBody',
        required: false,
        description:
            'Memory facets — when true, `q` also matches the document body, not just title + description.',
    })
    @ApiQuery({ name: 'q', required: false })
    @ApiQuery({ name: 'limit', required: false })
    @ApiQuery({ name: 'offset', required: false })
    @ApiResponse({ status: 200, description: 'List of KB documents' })
    async listDocuments(
        @CurrentUser() auth: AuthenticatedUser,
        // Security: every UUID-shaped route param (`id`/workId, `docId`,
        // `tagId`, `uploadId`) is validated with `ParseUUIDPipe`, matching
        // the convention already used in `invitations.controller.ts`. This
        // rejects malformed/abusive identifiers at the pipe layer (400)
        // before they reach the service + repository, narrowing the attack
        // surface for any future raw-query path. `docIdOrPath` is left
        // unvalidated on purpose — it legitimately accepts non-UUID paths.
        @Param('id', new ParseUUIDPipe()) workId: string,
        @Query() query: KbDocumentQueryDto,
    ) {
        return this.kb.listDocuments(workId, auth.userId, {
            class: query.class as KbDocumentClass | undefined,
            // Memory facets — repeatable `?class=` / `?source=` chips.
            // Express folds a repeated key into an array, which the DTO
            // normalizes; a single `?class=x` still lands on `class`.
            classes: query.classes as KbDocumentClass[] | undefined,
            sources: query.sources as KbDocumentSource[] | undefined,
            searchBody: query.searchBody,
            status: query.status as KbDocumentStatus | undefined,
            tag: query.tag,
            locked: query.locked,
            language: query.language,
            reviewState: query.reviewState as KbReviewState | undefined,
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
        @Param('id', new ParseUUIDPipe()) workId: string,
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
        @Param('id', new ParseUUIDPipe()) workId: string,
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
        @Param('id', new ParseUUIDPipe()) workId: string,
        @Param('docId', new ParseUUIDPipe()) docId: string,
        @Body() body: UpdateKbDocumentDto,
    ) {
        return this.kb.updateDocument(workId, docId, auth.userId, {
            ...body,
            status: body.status as KbDocumentStatus | undefined,
            class: body.class as KbDocumentClass | undefined,
        });
    }

    @Delete('works/:id/kb/documents/:docId')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({ summary: 'Delete a KB document' })
    @ApiResponse({ status: 204, description: 'KB document deleted' })
    async deleteDocument(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', new ParseUUIDPipe()) workId: string,
        @Param('docId', new ParseUUIDPipe()) docId: string,
    ) {
        await this.kb.deleteDocument(workId, docId, auth.userId);
    }

    @Post('works/:id/kb/documents/:docId/lock')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Lock a KB document' })
    @ApiResponse({ status: 200, description: 'KB document locked' })
    async lockDocument(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', new ParseUUIDPipe()) workId: string,
        @Param('docId', new ParseUUIDPipe()) docId: string,
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
        @Param('id', new ParseUUIDPipe()) workId: string,
        @Param('docId', new ParseUUIDPipe()) docId: string,
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
        @Param('id', new ParseUUIDPipe()) workId: string,
        @Param('docId', new ParseUUIDPipe()) docId: string,
        @Body() body: RestoreKbDocumentDto,
    ) {
        return this.kb.restoreDocumentFromHistory(workId, docId, auth.userId, body.commitSha);
    }

    @Get('works/:id/kb/documents/:docId/history')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'List Git commits that touched a KB document',
        description:
            'Returns the commit log for the sidecar `.md` body under `.content/kb/`, newest first. Powers the history dialog (row 18) — operators click a row to feed the SHA back into the existing `/restore` endpoint.',
    })
    @ApiQuery({
        name: 'limit',
        required: false,
        description: 'Max commits to return (1-100, default 25)',
    })
    @ApiResponse({ status: 200, description: 'Commit history' })
    @ApiResponse({ status: 404, description: 'Document not found' })
    async getDocumentHistory(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', new ParseUUIDPipe()) workId: string,
        @Param('docId', new ParseUUIDPipe()) docId: string,
        @Query('limit') limit?: string,
    ) {
        const parsedLimit = limit && /^\d+$/.test(limit) ? Number(limit) : undefined;
        return this.kb.getDocumentHistory(workId, docId, auth.userId, {
            limit: parsedLimit,
        });
    }

    @Post('works/:id/kb/documents/:docId/decision-status')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Transition the status of a decision-class KB document',
        description:
            'Platform-side decision status machine (proposed → accepted → superseded → archived; archived reachable from every non-terminal state). Owner-scoped; validates the transition and returns 409 on an illegal move. Transitioning to superseded with `supersededByDocId` records the replacement chain on both documents.',
    })
    @ApiResponse({ status: 200, description: 'Decision status transitioned' })
    @ApiResponse({ status: 400, description: 'Not a decision-class document' })
    @ApiResponse({ status: 404, description: 'Document (or superseding document) not found' })
    @ApiResponse({ status: 409, description: 'Illegal status transition' })
    async transitionDecisionStatus(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', new ParseUUIDPipe()) workId: string,
        @Param('docId', new ParseUUIDPipe()) docId: string,
        @Body() body: TransitionKbDecisionStatusDto,
    ) {
        return this.kb.transitionDecisionStatus(
            workId,
            docId,
            auth.userId,
            // Contracts literal union → agent runtime enum at the
            // controller→service boundary (same cast pattern as `class`).
            body.status as KbDecisionStatus,
            {
                supersededByDocId: body.supersededByDocId,
                rationale: body.rationale,
            },
        );
    }

    @Post('works/:id/kb/documents/:docId/accept')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Accept a proposed (agent-authored) KB document',
        description:
            'Review action (memory upgrades M7). Flips reviewState to accepted so the document starts feeding agent context; a decision-class document still in proposed status is accepted as current in the same call. Idempotent.',
    })
    @ApiResponse({ status: 200, description: 'Document accepted' })
    @ApiResponse({ status: 404, description: 'Document not found' })
    async acceptDocument(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', new ParseUUIDPipe()) workId: string,
        @Param('docId', new ParseUUIDPipe()) docId: string,
    ) {
        return this.kb.acceptDocument(workId, docId, auth.userId);
    }

    @Post('works/:id/kb/documents/:docId/archive')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Archive a KB document (review action — never a physical delete)',
        description:
            'Review action (memory upgrades M7). Sets the document status to archived (kept readable, excluded from default listings and context injection); a decision-class document has its decision status archived too. Idempotent.',
    })
    @ApiResponse({ status: 200, description: 'Document archived' })
    @ApiResponse({ status: 404, description: 'Document not found' })
    async archiveDocument(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', new ParseUUIDPipe()) workId: string,
        @Param('docId', new ParseUUIDPipe()) docId: string,
    ) {
        return this.kb.archiveDocument(workId, docId, auth.userId);
    }

    @Get('works/:id/kb/documents/:docId/citations')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'List citations referencing a KB document' })
    @ApiResponse({ status: 200, description: 'Citation rows' })
    async listCitations(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', new ParseUUIDPipe()) workId: string,
        @Param('docId', new ParseUUIDPipe()) docId: string,
    ) {
        return this.kb.listCitationsForDocument(workId, docId, auth.userId);
    }

    @Get('works/:id/kb/documents/:docId/retrieval-trail')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: '“Ask why” — the deterministic retrieval trail for a KB document',
        description:
            'Memory upgrades M11. Returns the recorded facts about how this document reached a model: which questions retrieved it, when, how many documents came back alongside it, and how many citation rows exist against it. No LLM, no synthesis, no inference — a read of the append-only retrieval log, owner-scoped through the same gate as every other per-document route.',
    })
    @ApiQuery({
        name: 'windowDays',
        required: false,
        description: 'Rolling window in days (default 90, clamped 1…365).',
    })
    @ApiQuery({
        name: 'limit',
        required: false,
        description: 'Max trail entries returned (default 20, clamped 1…100).',
    })
    @ApiResponse({ status: 200, description: 'Retrieval trail for the document' })
    @ApiResponse({ status: 404, description: 'Document not found' })
    async getRetrievalTrail(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', new ParseUUIDPipe()) workId: string,
        @Param('docId', new ParseUUIDPipe()) docId: string,
        @Query('windowDays') windowDays?: string,
        @Query('limit') limit?: string,
    ) {
        return this.kb.getRetrievalTrail(workId, auth.userId, docId, {
            windowDays: windowDays && /^\d+$/.test(windowDays) ? Number(windowDays) : undefined,
            limit: limit && /^\d+$/.test(limit) ? Number(limit) : undefined,
        });
    }

    // ─── Tags ──────────────────────────────────────────────────────────

    @Get('works/:id/kb/tags')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'List per-Work KB tags' })
    @ApiResponse({ status: 200, description: 'List of tags' })
    async listTags(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', new ParseUUIDPipe()) workId: string,
    ) {
        return this.kb.listTags(workId, auth.userId);
    }

    @Post('works/:id/kb/tags')
    @HttpCode(HttpStatus.CREATED)
    @ApiOperation({ summary: 'Create a KB tag' })
    @ApiResponse({ status: 201, description: 'Tag created' })
    async createTag(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', new ParseUUIDPipe()) workId: string,
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
        @Param('id', new ParseUUIDPipe()) workId: string,
        @Param('tagId', new ParseUUIDPipe()) tagId: string,
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
        @Param('id', new ParseUUIDPipe()) workId: string,
        @Param('tagId', new ParseUUIDPipe()) tagId: string,
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
        @Param('id', new ParseUUIDPipe()) workId: string,
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
        @Param('id', new ParseUUIDPipe()) workId: string,
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
        @Param('id', new ParseUUIDPipe()) workId: string,
        @Param('uploadId', new ParseUUIDPipe()) uploadId: string,
    ) {
        return this.kb.getUpload(workId, uploadId, auth.userId);
    }

    /**
     * EW-641 Phase 1B/d row 21a — stream KB upload bytes back to the
     * caller so per-MIME viewers (`KbPdfViewer`, `KbXlsxViewer`,
     * `KbDocxViewer`, image/video/audio) can mount. Gated by
     * `ensureCanView` (same gate as `GET /works/:id/kb/uploads/:uploadId`),
     * pinned with a strict CSP + nosniff so the browser cannot
     * reinterpret the bytes as executable HTML even when the MIME is
     * application/xml-ish.
     *
     * Returns the raw buffer with the storage-recovered (or upload-row)
     * MIME type. Cache-Control is `private, max-age=300` — same as the
     * generic `uploads.controller.ts` `serve()` route. Content-Disposition
     * is `inline` because the viewers iframe / `<img>` / `<video>` the
     * URL directly; the download fallbacks attach their own `download`
     * attribute on the anchor (KbPdfViewer / KbXlsxViewer / KbDocxViewer).
     */
    @Get('works/:id/kb/uploads/:uploadId/download')
    @Header(
        'Content-Security-Policy',
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    )
    @Header('X-Content-Type-Options', 'nosniff')
    @Header('Cache-Control', 'private, max-age=300')
    @ApiOperation({
        summary: 'Stream the persisted bytes for a KB upload',
        description:
            'Owner / viewer+ only. Hands the raw upload bytes back so the per-MIME viewers (KbPdfViewer, KbXlsxViewer, KbDocxViewer, image / video / audio) can render inline. CSP-pinned to default-src none + nosniff so the response is safe to embed inside an iframe or media tag.',
    })
    @ApiResponse({ status: 200, description: 'Raw upload bytes' })
    @ApiResponse({ status: 404, description: 'Upload not found' })
    @ApiResponse({ status: 503, description: 'Storage plugin not configured' })
    async downloadUpload(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', new ParseUUIDPipe()) workId: string,
        @Param('uploadId', new ParseUUIDPipe()) uploadId: string,
        @Res() res: ServeResponse,
    ) {
        const { buffer, mimeType, filename } = await this.kb.getUploadBytes(
            workId,
            uploadId,
            auth.userId,
        );
        res.setHeader('Content-Type', mimeType);
        res.setHeader('Content-Length', buffer.length);
        // `inline` is safe because we (a) pinned CSP `default-src 'none';
        // frame-ancestors 'none'` so neither script execution nor
        // top-frame nesting can fire, and (b) set nosniff so the browser
        // won't reinterpret the bytes as HTML even if the recorded MIME
        // is wrong. The viewers expect inline so `<iframe src>` /
        // `<video src>` / `<img src>` Just Work.
        //
        // Security: `filename` is the raw multipart `originalFilename`
        // stored verbatim (unlike the sibling `uploads.controller.ts`
        // serve route whose filename is the validated `<hex64>.<ext>`
        // shape). Strip `"`/CR/LF before interpolating into the quoted
        // header value so an attacker-chosen filename containing a double
        // quote can't terminate the quoted-string and inject additional
        // `Content-Disposition` parameters (disposition / filename spoof).
        const safeFilename = filename.replace(/["\r\n]/g, '_');
        res.setHeader('Content-Disposition', `inline; filename="${safeFilename}"`);
        res.send(buffer);
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
        @Param('id', new ParseUUIDPipe()) workId: string,
        @Param('uploadId', new ParseUUIDPipe()) uploadId: string,
    ) {
        return this.kb.retryUploadExtraction(workId, uploadId, auth.userId);
    }
}
