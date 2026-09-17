import {
    BadRequestException,
    Body,
    Controller,
    Get,
    Header,
    HttpCode,
    HttpStatus,
    Param,
    Post,
    Query,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
    PLAYBOOK_SLUG_PATTERN,
    type PlaybookDetailResponse,
    type PlaybookListResponse,
    type PlaybookPreflightReport,
} from '@ever-works/contracts';
import { AuthSessionGuard, CurrentUser } from '../auth';
import type { AuthenticatedUser } from '@src/auth/types/auth.types';
import { ListPlaybooksDto, PreflightPlaybookDto } from './catalog.dto';
import { PlaybookCatalogService } from './playbook-catalog.service';

function assertSlug(slug: string): void {
    if (!PLAYBOOK_SLUG_PATTERN.test(slug)) {
        throw new BadRequestException({ code: 'invalid_slug', message: 'Invalid playbook slug.' });
    }
}

/**
 * Capability & playbook catalogue (AW-21) — read-only routes.
 *
 *   GET  /api/catalog/playbooks                  the caller's catalogue, with readiness
 *   GET  /api/catalog/playbooks/:slug            one playbook + full readiness
 *   POST /api/catalog/playbooks/:slug/preflight  readiness + the itemised plan; creates nothing
 *
 * Every other catalogue section (Skills, Workflows, Task templates, Starting
 * points) is served by its own existing endpoint — this controller never
 * re-exposes them. Responses are per caller (readiness depends on which
 * plugins the caller has enabled), so nothing here may be cached by a proxy.
 */
@ApiTags('catalog')
@ApiBearerAuth()
@UseGuards(AuthSessionGuard)
@Controller('api/catalog')
export class CatalogController {
    constructor(private readonly catalog: PlaybookCatalogService) {}

    @Get('playbooks')
    @HttpCode(HttpStatus.OK)
    @Header('Cache-Control', 'private, no-store')
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    @ApiOperation({
        summary: 'List playbooks with the caller’s readiness',
        description:
            'Union of every enabled playbook-provider, filtered by category, search (title first, then tags, then summary and step titles) and readiness. `limit` is clamped to 50.',
    })
    @ApiResponse({ status: 200, description: '{ items, total }' })
    async list(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: ListPlaybooksDto,
    ): Promise<PlaybookListResponse> {
        return this.catalog.list(auth.userId, query);
    }

    @Get('playbooks/:slug')
    @HttpCode(HttpStatus.OK)
    @Header('Cache-Control', 'private, no-store')
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    @ApiOperation({ summary: 'Read one playbook and the caller’s full readiness' })
    @ApiParam({ name: 'slug' })
    @ApiResponse({ status: 200, description: '{ entry, readiness }' })
    @ApiResponse({ status: 400, description: 'invalid_slug' })
    @ApiResponse({ status: 404, description: 'playbook_not_found' })
    async detail(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('slug') slug: string,
    ): Promise<PlaybookDetailResponse> {
        assertSlug(slug);
        return this.catalog.detail(auth.userId, slug);
    }

    @Post('playbooks/:slug/preflight')
    @HttpCode(HttpStatus.OK)
    @Header('Cache-Control', 'private, no-store')
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Check whether a playbook could be set up, and itemise what it would create',
        description:
            'Read-only. Never creates, enables, installs or writes anything. Checks that do not answer within 2 s are listed in `unknown`.',
    })
    @ApiParam({ name: 'slug' })
    @ApiResponse({ status: 200, description: 'PlaybookPreflightReport' })
    @ApiResponse({ status: 400, description: 'invalid_slug' })
    @ApiResponse({ status: 404, description: 'playbook_not_found' })
    async preflight(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('slug') slug: string,
        @Body() body: PreflightPlaybookDto,
    ): Promise<PlaybookPreflightReport> {
        assertSlug(slug);
        return this.catalog.preflight(auth.userId, slug, body);
    }
}
