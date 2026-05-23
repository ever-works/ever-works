import {
    BadRequestException,
    Body,
    Controller,
    ForbiddenException,
    Get,
    Header,
    Headers,
    HttpCode,
    HttpStatus,
    Inject,
    NotFoundException,
    NotImplementedException,
    Optional,
    Param,
    Post,
    Query,
    Req,
    Res,
    UploadedFile,
    UseInterceptors,
} from '@nestjs/common';
import { WorkRepository } from '@ever-works/agent/database';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { AnonymousAuthService } from '../auth/services/anonymous-auth.service';
import { AUTH_PROVIDER } from '../auth/providers/auth-provider.constants';
import { AuthProvider } from '../auth/providers/auth-provider.abstract';
import { toHeaders } from '../auth/providers/request-headers';
import { UploadsService } from './uploads.service';
import { PresignUploadDto } from './dto/presign-upload.dto';

const MAX_UPLOAD_BYTES = Number(process.env.UPLOADS_MAX_BYTES) || 5 * 1024 * 1024;

// Minimal Express response / request surfaces — mirrors the local style
// in `works.controller.ts` to avoid pulling the full express type-graph
// into this module, which conflicts with the global `Express.Response`
// namespace used elsewhere in the build.
type ServeResponse = {
    status(code: number): ServeResponse;
    setHeader(name: string, value: string | number): void;
    json(body: unknown): void;
    send(body: string | Buffer): void;
};

type AnonRequest = {
    ip?: string;
    headers: Record<string, string | string[] | undefined>;
    user?: AuthenticatedUser;
};

@ApiTags('Uploads')
@Controller('api/uploads')
export class UploadsController {
    constructor(
        private readonly uploads: UploadsService,
        private readonly anonymousAuthService: AnonymousAuthService,
        // Codex P2 finding on PR #890: `AuthSessionGuard` returns early
        // when `@Public()` is set without populating `request.user`, so
        // the old `req.user?.userId` check below was dead code and every
        // authenticated caller hitting /anonymous or /presign got
        // re-anon-minted. We resolve the bearer ourselves via the same
        // provider the guard would have called, so an authenticated
        // session is honored on public-by-default upload routes.
        @Inject(AUTH_PROVIDER) private readonly authProvider: AuthProvider,
        // EW-644 (Codex P1): when `?workId=` is supplied, we must verify
        // the authenticated caller actually owns / has access to the
        // referenced Work before passing it to the storage backend.
        // Without this check, a user who knows another user's workId
        // could write uploads into the victim's data repo using the
        // victim's GitHub credentials. WorkRepository is `@Optional()`
        // for unit tests that don't exercise the workId path; the
        // module provides it in production.
        @Optional() private readonly workRepository?: WorkRepository,
    ) {}

    /**
     * Image upload — auth-gated, MIME-sniffed, size-capped, user-scoped.
     *
     * Rate-limited tighter than the global cap because:
     *  (1) each call writes to disk / object store, so it costs more than a JSON read,
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
        // EW-644: optional workId — required for backends that resolve
        // their destination per Work (currently only `github-storage`
        // in mode `data-repo`). Other backends ignore it. Validation
        // (UUID shape) happens in UploadsService.
        @Query('workId') workId?: string,
    ) {
        if (!file) {
            throw new BadRequestException({
                status: 'error',
                message: "Multipart field 'file' is required",
            });
        }
        if (workId) {
            await this.assertWorkAccess(auth.userId, workId);
        }
        return this.uploads.saveImage(auth.userId, file, workId ? { workId } : undefined);
    }

    @Post('image')
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ default: { limit: 20, ttl: 60_000 } })
    @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
    @ApiOperation({ summary: 'Upload an image (alias of POST /api/uploads)' })
    async uploadImage(
        @CurrentUser() auth: AuthenticatedUser,
        @UploadedFile() file: Express.Multer.File | undefined,
        @Query('workId') workId?: string,
    ) {
        return this.upload(auth, file, workId);
    }

    /**
     * EW-644 (Codex P1) — verify the authenticated caller actually has
     * access to the Work referenced by `workId` before any storage
     * backend uses it to resolve repo coordinates / a token.
     *
     * Today the check is strict: only the Work creator (`work.userId`)
     * can upload to it. Extending to org members + write-permission
     * roles is a follow-up alongside the broader Work-access service —
     * for now we mirror the same `work.userId !== auth.userId` rule the
     * data-sync controller uses (see `apps/api/src/data-sync/data-sync.controller.ts:73`).
     *
     * Throws NotFound (not Forbidden) when the Work either doesn't
     * exist or belongs to someone else, so an attacker probing for
     * valid Work UUIDs can't enumerate ownership via the response code.
     */
    private async assertWorkAccess(userId: string, workId: string): Promise<void> {
        if (!this.workRepository) {
            // No work-access plumbing in this NestJS context (e.g. an
            // older harness that didn't bind `DatabaseModule`). Refuse
            // the upload rather than silently bypassing the check.
            throw new ForbiddenException({
                status: 'error',
                code: 'WorkAccessUnchecked',
                message: 'Work access checks are not configured on this server',
            });
        }
        const work = await this.workRepository.findById(workId);
        if (!work || work.userId !== userId) {
            throw new NotFoundException({
                status: 'error',
                message: 'Work not found',
            });
        }
    }

    /**
     * EW-637 — anonymous upload entrypoint for the website's landing-page
     * prompt-with-attachments flow.
     *
     * When the request arrives unauthenticated, we mint an anonymous user
     * inline (re-using the same TTL-bounded row the `/api/auth/anonymous`
     * route creates) and scope the upload to that anon user. The returned
     * `anonAccessToken` is the bearer the website will send back when it
     * later submits the prompt — same shape as the regular anonymous-auth
     * response so the website doesn't need a separate token-handling path.
     *
     * If the request IS already authenticated, we honor the existing
     * session and skip the anon-mint — letting a real user attach files
     * via this endpoint is harmless and saves the website a code branch.
     *
     * The upload's lifetime is tied to the anon user's TTL
     * (`ANONYMOUS_USER_TTL_DAYS`, default 3). When that user is GC'd by
     * the `anonymous-user-cleanup` schedule, their files go too (the
     * cleanup job already handles this for Works; storage-side GC for
     * uploads is a follow-up — see EW-637 comments).
     */
    @Public()
    @Post('anonymous')
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ default: { limit: 10, ttl: 60_000 } })
    @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
    @ApiOperation({
        summary: 'Upload from an anonymous (pre-signup) visitor',
        description:
            'Accepts a multipart file from an unauthenticated visitor. Mints an anonymous user inline (or honors an existing session if a bearer is supplied) and scopes the upload to it. Returns { uploadId, url, expiresAt, anonAccessToken? }. uploadId is what the caller passes back when submitting their prompt. Lifetime is tied to the anonymous user TTL (ANONYMOUS_USER_TTL_DAYS, default 3 days).',
    })
    @ApiResponse({ status: 201, description: 'Upload accepted' })
    @ApiResponse({ status: 400, description: 'Validation failed' })
    @ApiResponse({ status: 413, description: 'File exceeds size cap' })
    async uploadAnonymous(
        @UploadedFile() file: Express.Multer.File | undefined,
        @Req() req: AnonRequest,
        @Headers('x-correlation-id') correlationHeader: string | undefined,
    ) {
        if (!file) {
            throw new BadRequestException({
                status: 'error',
                message: "Multipart field 'file' is required",
            });
        }

        // Honor an existing session if one happened through — anon callers
        // reach this point with `req.user` unset (because @Public() bypasses
        // AuthSessionGuard), an authenticated caller is supported as a
        // no-branch convenience.
        const { userId, anonAccessToken, anonymousExpiresAt } = await this.resolveActingUser(req);

        const result = await this.uploads.saveImage(userId, file);

        // Note: `correlationHeader` is accepted but not yet propagated to
        // analytics. Hook it into the ZeroFrictionFunnel emit in a follow-up
        // once the website starts sending it. For now we acknowledge it
        // exists so the API contract is stable.
        void correlationHeader;

        return {
            uploadId: result.key ?? `${userId}/${result.filename}`,
            id: result.id,
            url: result.url,
            filename: result.filename,
            size: result.size,
            mimeType: result.mimeType,
            hash: result.hash,
            expiresAt: anonymousExpiresAt ?? null,
            ...(anonAccessToken ? { anonAccessToken } : {}),
        };
    }

    /**
     * EW-637 — mint a presigned upload URL when the active storage backend
     * supports direct-to-cloud uploads (S3 / MinIO). Local-fs and
     * github-storage don't, in which case we return HTTP 501 with a hint
     * to use POST /api/uploads instead.
     *
     * This endpoint is intentionally public-by-default (same anon-mint
     * fallback as POST /api/uploads/anonymous) so the website can hand
     * the browser a presigned URL before the visitor signs up.
     */
    @Public()
    @Post('presign')
    @HttpCode(HttpStatus.OK)
    @Throttle({ default: { limit: 20, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Mint a presigned upload URL (when backend supports it)',
        description:
            'Requests a pre-signed upload URL for direct browser-to-cloud upload. Only available when STORAGE_BACKEND supports it (S3, MinIO). Returns 501 for local-fs / github-storage.',
    })
    @ApiResponse({ status: 200, description: 'Returns { url, key, fields?, expiresAt }' })
    @ApiResponse({
        status: 501,
        description: 'Backend does not support presign — use POST /api/uploads',
    })
    async presign(@Body() body: PresignUploadDto, @Req() req: AnonRequest) {
        const backend = await this.uploads.getBackend();
        if (!backend.presignPut) {
            throw new NotImplementedException({
                status: 'error',
                code: 'PresignNotSupported',
                message:
                    'Active storage backend does not support presigned uploads — use POST /api/uploads with multipart form data instead.',
            });
        }

        // Mint an anon user when no session is present, same as the anon
        // upload route — direct-to-cloud uploads need an owner segment.
        const { userId, anonAccessToken, anonymousExpiresAt } = await this.resolveActingUser(req);

        const presign = await backend.presignPut({
            filename: body.filename,
            mimeType: body.mimeType,
            size: body.size,
            ownerId: userId,
        });

        return {
            ...presign,
            ownerId: userId,
            expiresAt: presign.expiresAt,
            ...(anonAccessToken ? { anonAccessToken, anonymousExpiresAt } : {}),
        };
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
        // EW-644: optional `?workId=` — for backends that store keys
        // per-Work (`github-storage` in `data-repo` mode). The value
        // was emitted by `putObject` into the upload's URL; we just
        // round-trip it back into `readFile`.
        @Query('workId') workId?: string,
    ) {
        if (auth.userId !== userId) {
            // Don't 403 vs 404 — leaking "this file exists but isn't
            // yours" is a small enumeration tell. Treat as not-found.
            res.status(HttpStatus.NOT_FOUND).json({ status: 'error', message: 'Not found' });
            return;
        }
        // EW-644 (Codex P1): when the caller passes a workId, verify
        // ownership before forwarding it to the backend — same gate as
        // the upload path, so a stranger can't enumerate or read another
        // user's data-repo uploads by guessing workIds.
        if (workId) {
            await this.assertWorkAccess(auth.userId, workId);
        }
        const { buffer, mimeType } = await this.uploads.readFile(
            userId,
            filename,
            workId ? { workId } : undefined,
        );
        res.setHeader('Content-Type', mimeType);
        res.setHeader('Content-Length', buffer.length);
        // `inline` is safe here because we (a) pinned a strict CSP that
        // disallows script and frame execution and (b) set nosniff so the
        // browser will not reinterpret the bytes as HTML even if Content-
        // Type is somehow wrong.
        res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
        res.send(buffer);
    }

    /**
     * Resolve who's doing the upload: honor an existing session if a bearer
     * token came through; otherwise mint an anonymous user inline. Both
     * /anonymous and /presign route through here so the IP / user-agent
     * extraction strategy stays in one place.
     */
    private async resolveActingUser(req: AnonRequest): Promise<{
        userId: string;
        anonAccessToken: string | undefined;
        anonymousExpiresAt: string | null | undefined;
    }> {
        // Codex P2 finding on PR #890: `@Public()` routes never have
        // `req.user` populated (the guard short-circuits before it
        // gets to bearer parsing), so the old `req.user?.userId`
        // check was dead and every authenticated caller hitting
        // /anonymous or /presign was getting re-anon-minted. Resolve
        // the bearer here directly — same `authProvider.authenticate`
        // path the guard would have taken. We swallow the error case:
        // an unauthenticated request shouldn't fail the upload, it
        // should fall through to the anon-mint branch.
        const existing = await this.tryAuthenticate(req);
        if (existing) {
            return {
                userId: existing.userId,
                anonAccessToken: undefined,
                anonymousExpiresAt: undefined,
            };
        }

        const ipAddress =
            (typeof req.ip === 'string' && req.ip) ||
            (typeof req.headers['x-forwarded-for'] === 'string'
                ? (req.headers['x-forwarded-for'] as string).split(',')[0].trim()
                : null);
        const userAgent =
            typeof req.headers['user-agent'] === 'string'
                ? (req.headers['user-agent'] as string)
                : null;

        const anon = await this.anonymousAuthService.createAnonymousUser({
            ipAddress,
            userAgent,
        });
        return {
            userId: anon.user.id,
            anonAccessToken: anon.access_token,
            anonymousExpiresAt: anon.user.anonymousExpiresAt ?? null,
        };
    }

    /**
     * Best-effort bearer resolution for `@Public()` upload routes.
     * Returns the authenticated user when a valid session token is
     * present, otherwise `null`. Never throws — an invalid/missing
     * token falls through to anon-mint instead of 401-ing a route
     * that's documented as accepting anonymous traffic.
     */
    private async tryAuthenticate(req: AnonRequest): Promise<AuthenticatedUser | null> {
        const auth = req.headers?.authorization;
        if (!auth) return null;
        try {
            return await this.authProvider.authenticate(toHeaders(req.headers || {}));
        } catch {
            return null;
        }
    }
}
