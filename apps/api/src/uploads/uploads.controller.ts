import {
    BadRequestException,
    Controller,
    Get,
    Header,
    HttpCode,
    HttpStatus,
    Param,
    Post,
    Res,
    UploadedFile,
    UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { UploadsService } from './uploads.service';

const MAX_UPLOAD_BYTES = Number(process.env.UPLOADS_MAX_BYTES) || 5 * 1024 * 1024;

// Minimal Express response surface — mirrors the local style in
// `works.controller.ts` (see `DownloadResponse` there). Avoids pulling
// the full express type-graph into this module, which conflicts with
// the global `Express.Response` namespace used elsewhere in the build.
type ServeResponse = {
    status(code: number): ServeResponse;
    setHeader(name: string, value: string | number): void;
    json(body: unknown): void;
    send(body: string | Buffer): void;
};

@ApiTags('Uploads')
@Controller('api/uploads')
export class UploadsController {
    constructor(private readonly uploads: UploadsService) {}

    /**
     * Image upload — auth-gated, MIME-sniffed, size-capped, user-scoped.
     *
     * Rate-limited tighter than the global cap because:
     *  (1) each call writes to disk, so it costs more than a JSON read,
     *  (2) it's an obvious target for storage-exhaustion DoS.
     *
     * Two routes (`/api/uploads` and `/api/uploads/image`) share the
     * same handler — the e2e probe path-walks a candidate list so we
     * accept either spelling.
     */
    @Post()
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ default: { limit: 20, ttl: 60_000 } })
    @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
    @ApiOperation({
        summary: 'Upload an image',
        description:
            'Multipart upload of an image (png/jpeg/gif/webp). Auth required. Returns a URL + sha256 id. The server validates the magic bytes — declaring the wrong Content-Type is rejected.',
    })
    @ApiResponse({ status: 201, description: 'Upload accepted, returns { id, url, ... }' })
    @ApiResponse({
        status: 400,
        description: 'Validation failed (size, MIME, magic-byte mismatch)',
    })
    @ApiResponse({ status: 401, description: 'Unauthenticated' })
    @ApiResponse({ status: 413, description: 'File exceeds size cap' })
    async upload(
        @CurrentUser() auth: AuthenticatedUser,
        @UploadedFile() file: Express.Multer.File | undefined,
    ) {
        if (!file) {
            throw new BadRequestException({
                status: 'error',
                message: "Multipart field 'file' is required",
            });
        }
        return this.uploads.saveImage(auth.userId, file);
    }

    @Post('image')
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ default: { limit: 20, ttl: 60_000 } })
    @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
    @ApiOperation({ summary: 'Upload an image (alias of POST /api/uploads)' })
    async uploadImage(
        @CurrentUser() auth: AuthenticatedUser,
        @UploadedFile() file: Express.Multer.File | undefined,
    ) {
        return this.upload(auth, file);
    }

    /**
     * Serve a previously-uploaded file. The URL embeds the owning
     * userId so we can enforce that ONLY the owner (or someone they
     * shared the URL with — the URL contains an unguessable sha256)
     * can fetch it.
     *
     * We require authentication, and require the requester's userId to
     * match the URL segment. This is conservative — if the product ever
     * needs public-by-link sharing, lift the gate then; tightening later
     * would break existing links.
     */
    @Get(':userId/:filename')
    @Header(
        'Content-Security-Policy',
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    )
    @Header('X-Content-Type-Options', 'nosniff')
    @Header('Cache-Control', 'private, max-age=300')
    @ApiOperation({ summary: 'Serve a previously uploaded file (owner-only)' })
    async serve(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('userId') userId: string,
        @Param('filename') filename: string,
        @Res() res: ServeResponse,
    ) {
        if (auth.userId !== userId) {
            // Don't 403 vs 404 — leaking "this file exists but isn't
            // yours" is a small enumeration tell. Treat as not-found.
            res.status(HttpStatus.NOT_FOUND).json({ status: 'error', message: 'Not found' });
            return;
        }
        const { buffer, mimeType } = await this.uploads.readFile(userId, filename);
        res.setHeader('Content-Type', mimeType);
        res.setHeader('Content-Length', buffer.length);
        // `inline` is safe here because we (a) pinned a strict CSP that
        // disallows script and frame execution and (b) set nosniff so the
        // browser will not reinterpret the bytes as HTML even if Content-
        // Type is somehow wrong.
        res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
        res.send(buffer);
    }
}
