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

// Security (DoS): the import bodies are typed as plain (erased) TS
// interfaces, so the global ValidationPipe — which only enforces
// constraints on class-validator-decorated classes — applies no
// size/shape limits to them. The AccountImportService then iterates the
// top-level `works`/`userPlugins` arrays and each work's nested arrays
// (items/categories/tags/collections/comparisons) with no bound. A single
// authenticated request carrying e.g. a `works` array of millions of
// elements (or a work with millions of items) can exhaust memory. These
// caps reject only abusively large payloads before they reach the
// service; the limits are far above any realistic export (an account
// exporting hundreds of works, each a directory site with tens of
// thousands of items, stays well under them), so every legitimate import
// is unchanged. (A full class-validator DTO tree mirroring the shared
// `AccountExportPayload` contract + a body-parser byte cap are the
// complementary defenses and are tracked separately.)
const MAX_IMPORT_WORKS = 5000;
const MAX_IMPORT_USER_PLUGINS = 5000;
const MAX_IMPORT_ITEMS_PER_WORK = 100000;
const MAX_IMPORT_NESTED_PER_WORK = 50000;

function assertImportPayloadBounds(payload: AccountExportPayload | undefined | null): void {
    const data = payload?.data;
    if (!data || typeof data !== 'object') {
        return;
    }
    if (Array.isArray(data.works) && data.works.length > MAX_IMPORT_WORKS) {
        throw new BadRequestException(
            `Import payload too large: works exceeds ${MAX_IMPORT_WORKS}`,
        );
    }
    if (Array.isArray(data.userPlugins) && data.userPlugins.length > MAX_IMPORT_USER_PLUGINS) {
        throw new BadRequestException(
            `Import payload too large: userPlugins exceeds ${MAX_IMPORT_USER_PLUGINS}`,
        );
    }
    if (Array.isArray(data.works)) {
        for (const work of data.works) {
            if (!work || typeof work !== 'object') {
                continue;
            }
            if (Array.isArray(work.items) && work.items.length > MAX_IMPORT_ITEMS_PER_WORK) {
                throw new BadRequestException(
                    `Import payload too large: a work's items exceeds ${MAX_IMPORT_ITEMS_PER_WORK}`,
                );
            }
            for (const nested of [
                work.categories,
                work.tags,
                work.collections,
                work.comparisons,
                work.members,
                work.customDomains,
                work.workPlugins,
            ]) {
                if (Array.isArray(nested) && nested.length > MAX_IMPORT_NESTED_PER_WORK) {
                    throw new BadRequestException(
                        `Import payload too large: a work's nested array exceeds ${MAX_IMPORT_NESTED_PER_WORK}`,
                    );
                }
            }
        }
    }
}

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
        // Security (DoS): bound the untrusted arrays before the service
        // iterates them unguarded.
        assertImportPayloadBounds(payload);
        return this.importService.previewImport(auth.userId, payload);
    }

    @Post('import/apply')
    @HttpCode(HttpStatus.OK)
    async applyImport(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: { payload: AccountExportPayload; resolutions: ConflictResolution[] },
    ) {
        // Security (DoS): bound the untrusted arrays before the service
        // iterates them unguarded (mirrors the preview guard).
        assertImportPayloadBounds(body?.payload);
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
        // PASS-4 review fix (HIGH): widen the body so callers can
        // toggle the v2-tail sections. Previously the controller
        // only accepted `includeSecrets`, so the v2 subdir layout
        // in GitHubSyncService never actually fired from the API
        // surface — the toggles silently defaulted.
        @Body()
        body: {
            includeSecrets?: boolean;
            includeAgents?: boolean;
            includeSkills?: boolean;
            includeTasks?: boolean;
            includeTaskChat?: boolean;
        },
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
