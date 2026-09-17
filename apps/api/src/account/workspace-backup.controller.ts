import {
    BadRequestException,
    Controller,
    Delete,
    ForbiddenException,
    Get,
    GoneException,
    Header,
    HttpCode,
    HttpStatus,
    NotFoundException,
    Param,
    Post,
    Query,
    Res,
    ServiceUnavailableException,
    Body,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
    BACKUP_DOMAINS,
    BACKUP_FORMAT_VERSION,
    buildBackupArchiveFilename,
} from '@ever-works/contracts';
import { WorkspaceBackupService } from '@ever-works/agent/account-transfer';
import { BACKUP_STORAGE, type BackupStorage } from '@ever-works/agent/account-transfer';
import { Inject, Optional } from '@nestjs/common';
import type { Readable } from 'node:stream';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { ScopeContextService } from '../scope/scope-context.service';
import { CreateBackupDto } from './dto/create-backup.dto';
import { BackupDto, toBackupDto } from './dto/backup.dto';

/**
 * Minimal response shape — the convention `usage.controller.ts` and
 * `activity-log.controller.ts` use so the file does not pull the whole
 * express typing in.
 */
type ArchiveResponse = {
    setHeader(name: string, value: string): void;
    status(code: number): ArchiveResponse;
    json(body: unknown): void;
};

/**
 * Workspace backup (AW-22) — `POST /api/account/backups` and friends.
 *
 * A separate controller from `AccountController` on purpose. That one owns
 * the JSON export, the import preview/apply and the config-repo sync, all of
 * which ship unchanged: they answer "give me a small, hand-editable file for
 * moving a couple of Works between environments", which is a different
 * question from "give me everything, with evidence of what everything
 * means". Two surfaces, two jobs, no behaviour removed from either.
 *
 * Every route is session-guarded by the global auth guard, resolves the
 * active workspace through `ScopeContextService`, and is additionally gated
 * to the workspace owner (spec FR-10). Creating is cheap; downloading takes
 * the whole workspace off the platform, so both are held to the same bar
 * until per-organization roles land.
 */
@ApiTags('Workspace backup')
@Controller('api/account/backups')
export class WorkspaceBackupController {
    constructor(
        private readonly backups: WorkspaceBackupService,
        private readonly scopeContext: ScopeContextService,
        @Optional() @Inject(BACKUP_STORAGE) private readonly storage?: BackupStorage,
    ) {}

    /** Route 1 — start a backup, or adopt the one already running. */
    @Post()
    @ApiOperation({ summary: 'Start a complete backup of the active workspace' })
    @HttpCode(HttpStatus.ACCEPTED)
    async create(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: CreateBackupDto,
        @Res() res: ArchiveResponse,
    ): Promise<void> {
        const scope = this.scope(auth);
        await this.assertOwner(scope);
        const outcome = await this.backups.create(scope, {
            includeFullHistory: body?.includeFullHistory === true,
        });

        switch (outcome.kind) {
            case 'unavailable':
                // Never a button that always fails (spec FR-46, S-26).
                throw new ServiceUnavailableException({
                    code: 'backup_storage_unconfigured',
                    message: 'Backups are not available in this deployment.',
                });
            case 'rate_limited':
                res.status(HttpStatus.TOO_MANY_REQUESTS).json({
                    code: 'backup_rate_limited',
                    retryAt: outcome.retryAt.toISOString(),
                    limit: outcome.limit,
                });
                return;
            case 'adopted':
                // Spec S-9: the second tab shows the first tab's backup.
                res.status(HttpStatus.OK).json({
                    backup: toBackupDto(outcome.backup),
                    adopted: true,
                });
                return;
            case 'started':
                res.status(HttpStatus.ACCEPTED).json({ backup: toBackupDto(outcome.backup) });
        }
    }

    /** Route 2 — the history list (spec FR-30). */
    @Get()
    @ApiOperation({ summary: 'List recent backups of the active workspace' })
    async list(
        @CurrentUser() auth: AuthenticatedUser,
        @Query('limit') limit?: string,
        @Query('cursor') cursor?: string,
    ): Promise<{ backups: BackupDto[]; nextCursor: string | null; limits: unknown }> {
        const scope = this.scope(auth);
        await this.assertOwner(scope);
        const parsed = Number(limit);
        const page = await this.backups.list(scope, {
            ...(Number.isFinite(parsed) && parsed > 0 ? { limit: parsed } : {}),
            cursor: cursor ?? null,
        });

        return {
            backups: page.rows.map(toBackupDto),
            nextCursor: page.nextCursor,
            // The card reads the values in force rather than repeating the
            // defaults, so an operator who shortens retention does not leave
            // the interface promising fourteen days (spec FR-47).
            limits: this.backups.limits(),
        };
    }

    /** Route 3 — the poll target while a backup runs (spec FR-41). */
    @Get('current')
    @ApiOperation({ summary: 'The running backup, or the most recent one' })
    async current(@CurrentUser() auth: AuthenticatedUser): Promise<{
        backup: BackupDto | null;
        available: boolean;
        isOwner: boolean;
        limits: unknown;
    }> {
        const scope = this.scope(auth);
        const backup = (await this.backups.isWorkspaceOwner(scope))
            ? await this.backups.getCurrent(scope)
            : null;
        return {
            backup: backup ? toBackupDto(backup) : null,
            available: await this.backups.isAvailable(),
            // The card needs to RENDER the not-owner state with its reason
            // attached, so this route answers rather than refuses (spec S-8).
            isOwner: await this.backups.isWorkspaceOwner(scope),
            limits: this.backups.limits(),
        };
    }

    /**
     * Route 10 — the machine-readable field reference.
     *
     * Declared BEFORE `:id` so the literal path is matched first; a route
     * parameter would otherwise swallow it and answer "no such backup".
     */
    @Get('format')
    @ApiOperation({ summary: 'The archive format: version, domains and restorability' })
    format(): { formatVersion: string; domains: typeof BACKUP_DOMAINS } {
        return { formatVersion: BACKUP_FORMAT_VERSION, domains: BACKUP_DOMAINS };
    }

    /** Route 4 — one backup, only if it belongs to this workspace. */
    @Get(':id')
    @ApiOperation({ summary: 'One backup of the active workspace' })
    async get(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
    ): Promise<{ backup: BackupDto }> {
        const scope = this.scope(auth);
        await this.assertOwner(scope);
        const backup = await this.backups.get(scope, id);
        if (!backup) {
            // Cross-scope reads as absent, never as forbidden: a 403 would
            // confirm the id exists somewhere.
            throw new NotFoundException({ code: 'backup_not_found' });
        }
        return { backup: toBackupDto(backup) };
    }

    /** Route 5 — cancel a running backup (spec FR-8). */
    @Post(':id/cancel')
    @ApiOperation({ summary: 'Cancel a running backup' })
    @HttpCode(HttpStatus.ACCEPTED)
    async cancel(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Res() res: ArchiveResponse,
    ): Promise<void> {
        const scope = this.scope(auth);
        await this.assertOwner(scope);
        const backup = await this.backups.get(scope, id);
        if (!backup) {
            throw new NotFoundException({ code: 'backup_not_found' });
        }

        if (!(await this.backups.cancel(scope, id))) {
            // It settled a moment ago. Not an error the owner caused.
            res.status(HttpStatus.CONFLICT).json({ code: 'backup_already_finished' });
            return;
        }
        res.status(HttpStatus.ACCEPTED).json({ cancelled: true });
    }

    /** Route 6 — delete the bytes now; the record survives (spec FR-31). */
    @Delete(':id')
    @ApiOperation({ summary: 'Delete a backup archive immediately' })
    @HttpCode(HttpStatus.NO_CONTENT)
    async remove(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string): Promise<void> {
        const scope = this.scope(auth);
        await this.assertOwner(scope);
        const backup = await this.backups.get(scope, id);
        if (!backup) {
            throw new NotFoundException({ code: 'backup_not_found' });
        }
        await this.backups.deleteArtifact(scope, id);
    }

    /** Route 7 — mint a fresh, short-lived, workspace-bound link (spec FR-12). */
    @Post(':id/download-link')
    @ApiOperation({ summary: 'Mint a download link for a ready archive' })
    @HttpCode(HttpStatus.OK)
    async downloadLink(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
    ): Promise<{ url: string; expiresAt: string }> {
        const scope = this.scope(auth);
        await this.assertOwner(scope);
        const backup = await this.backups.get(scope, id);
        if (!backup) {
            throw new NotFoundException({ code: 'backup_not_found' });
        }
        this.assertDownloadable(backup);

        const minted = this.backups.mintDownloadToken(scope, id);
        return {
            url: `/api/account/backups/${encodeURIComponent(id)}/download?token=${encodeURIComponent(minted.token)}`,
            expiresAt: minted.expiresAt.toISOString(),
        };
    }

    /**
     * Route 8 — the archive itself, streamed.
     *
     * Never buffered: the bytes go from the storage backend to the socket,
     * which is the whole reason this epic exists. `Content-Disposition` is
     * built from the format's own filename rule and the workspace slug, so
     * nothing a caller supplied ends up in a response header.
     */
    @Get(':id/download')
    @ApiOperation({ summary: 'Download a ready archive' })
    @Header('Cache-Control', 'no-store')
    async download(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Query('token') token: string,
        @Res() res: ArchiveResponse & { pipe?: unknown },
    ): Promise<void> {
        const scope = this.scope(auth);
        await this.assertOwner(scope);
        if (!token || !this.backups.verifyDownloadToken(scope, id, token)) {
            // A stale link is re-minted by the client without the owner
            // seeing anything unusual (spec S-15).
            throw new ForbiddenException({ code: 'backup_token_invalid' });
        }

        const backup = await this.backups.get(scope, id);
        if (!backup) {
            throw new NotFoundException({ code: 'backup_not_found' });
        }
        this.assertDownloadable(backup);
        if (!this.storage || !backup.storageKey) {
            throw new ServiceUnavailableException({ code: 'backup_storage_unconfigured' });
        }

        const object = await this.storage.getArchiveStream(backup.storageKey);
        // Built from the archive's OWN manifest, never from anything the
        // caller sent, so no request value can reach a response header.
        const filename = buildBackupArchiveFilename(
            backup.manifestSummary?.workspace?.slug ?? 'workspace',
            new Date(backup.finishedAt ?? backup.requestedAt).toISOString(),
            backup.id.slice(0, 6),
        );

        res.setHeader('Content-Type', object.mimeType);
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        if (object.size !== undefined) {
            res.setHeader('Content-Length', String(object.size));
        }
        if (backup.sha256) {
            res.setHeader('X-Checksum-Sha256', backup.sha256);
        }

        await this.backups.recordDownload(scope, backup);
        (object.stream as Readable).pipe(res as unknown as NodeJS.WritableStream);
    }

    /**
     * Refuse anyone who is not the workspace owner (spec FR-10), with a
     * stable code the card renders its own copy for.
     */
    private async assertOwner(scope: {
        userId: string;
        organizationId: string | null;
        tenantId: string | null;
    }): Promise<void> {
        if (!(await this.backups.isWorkspaceOwner(scope))) {
            throw new ForbiddenException({
                code: 'backup_owner_only',
                message: 'Only the workspace owner can create or download a backup.',
            });
        }
    }

    /** The workspace one request may see (spec FR-9). */
    private scope(auth: AuthenticatedUser) {
        if (!auth?.userId) {
            throw new ForbiddenException({ code: 'backup_owner_only' });
        }
        return {
            userId: auth.userId,
            organizationId: this.scopeContext.getOrganizationId(),
            tenantId: this.scopeContext.getTenantId(),
        };
    }

    /**
     * An archive whose bytes are gone reads as `410 Gone` with the date, not
     * as `404` — the row is still there and the owner should see that a
     * backup WAS taken that day (spec S-16).
     */
    private assertDownloadable(backup: { status: string; expiresAt?: Date | null }): void {
        if (backup.status === 'ready' || backup.status === 'ready_with_gaps') {
            return;
        }
        if (backup.status === 'expired' || backup.status === 'deleted') {
            throw new GoneException({
                code: 'backup_archive_gone',
                status: backup.status,
                expiresAt: backup.expiresAt ? new Date(backup.expiresAt).toISOString() : null,
            });
        }
        throw new BadRequestException({ code: 'backup_not_ready', status: backup.status });
    }
}
