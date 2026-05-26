import {
    BadRequestException,
    Controller,
    Get,
    Post,
    Delete,
    Body,
    Query,
    HttpCode,
    HttpStatus,
    Header,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import {
    AccountExportService,
    AccountImportService,
    GitHubSyncService,
} from '@ever-works/agent/account-transfer';
import type { AccountExportPayload, ConflictResolution } from '@ever-works/agent/account-transfer';

@Controller('api/account')
export class AccountController {
    constructor(
        private readonly exportService: AccountExportService,
        private readonly importService: AccountImportService,
        private readonly syncService: GitHubSyncService,
    ) {}

    // ─── Export ──────────────────────────────────────────────────

    @Get('export')
    @HttpCode(HttpStatus.OK)
    @Header('Content-Disposition', 'attachment; filename="account-export.json"')
    async exportData(
        @CurrentUser() auth: AuthenticatedUser,
        @Query('includeSecrets') includeSecrets: string,
        // Phase 19.6 — per-feature toggles for the v2 payload tail.
        // All default `false` so a v1 caller (no query params) gets a
        // v1-shaped payload exactly as before.
        @Query('includeAgents') includeAgents?: string,
        @Query('includeSkills') includeSkills?: string,
        @Query('includeTasks') includeTasks?: string,
        @Query('includeTaskChat') includeTaskChat?: string,
    ) {
        return this.exportService.exportAccountData(auth.userId, {
            includeSecrets: includeSecrets === 'true',
            includeAgents: includeAgents === 'true',
            includeSkills: includeSkills === 'true',
            includeTasks: includeTasks === 'true',
            includeTaskChat: includeTaskChat === 'true',
        });
    }

    // ─── Import ─────────────────────────────────────────────────

    @Post('import/preview')
    @HttpCode(HttpStatus.OK)
    async previewImport(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() payload: AccountExportPayload,
    ) {
        // The body type is a structural one — without explicit DTO
        // validators an empty `{}` reaches the service and throws
        // unhandled, which surfaces as a 500. Reject only truly empty
        // bodies (no fields at all) so we surface a clean 400 instead.
        if (!payload || typeof payload !== 'object' || Object.keys(payload).length === 0) {
            throw new BadRequestException('Request body is empty');
        }
        return this.importService.previewImport(auth.userId, payload);
    }

    @Post('import/apply')
    @HttpCode(HttpStatus.OK)
    async applyImport(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: { payload: AccountExportPayload; resolutions: ConflictResolution[] },
    ) {
        return this.importService.applyImport(auth.userId, body.payload, body.resolutions || []);
    }

    // ─── GitHub Sync ────────────────────────────────────────────

    @Get('sync/status')
    @HttpCode(HttpStatus.OK)
    async getSyncStatus(@CurrentUser() auth: AuthenticatedUser) {
        return this.syncService.getSyncStatus(auth.userId);
    }

    @Post('sync/configure')
    @HttpCode(HttpStatus.OK)
    async configureSyncRepo(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: { repoFullName?: string; createNew?: boolean },
    ) {
        return this.syncService.configureSyncRepo(auth.userId, body);
    }

    @Post('sync/push')
    @HttpCode(HttpStatus.OK)
    async pushToGitHub(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: { includeSecrets?: boolean },
    ) {
        await this.syncService.pushToGitHub(auth.userId, body);
        return { status: 'success' };
    }

    @Post('sync/pull')
    @HttpCode(HttpStatus.OK)
    async pullFromGitHub(@CurrentUser() auth: AuthenticatedUser) {
        return this.syncService.pullFromGitHub(auth.userId);
    }

    @Post('sync/pull/apply')
    @HttpCode(HttpStatus.OK)
    async applyPull(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: { resolutions: ConflictResolution[] },
    ) {
        return this.syncService.applyPull(auth.userId, body.resolutions || []);
    }

    @Delete('sync')
    @HttpCode(HttpStatus.OK)
    async removeSyncConfig(@CurrentUser() auth: AuthenticatedUser) {
        await this.syncService.removeSyncConfig(auth.userId);
        return { status: 'success' };
    }
}
