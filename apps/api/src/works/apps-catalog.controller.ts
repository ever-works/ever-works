import {
    Controller,
    Get,
    HttpException,
    HttpStatus,
    Param,
    Query,
    UseGuards,
} from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiOperation,
    ApiParam,
    ApiQuery,
    ApiResponse,
    ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { APPS_CATALOG_PUBLIC_PER_MIN } from '@ever-works/contracts';
import type { AppsCatalogListingItem, AppsCatalogListingResponse } from '@ever-works/contracts';
import { config } from '@ever-works/agent/config';
import { AuthSessionGuard } from '../auth';
import { AppsCatalogManifestService } from './apps-catalog-manifest.service';

/**
 * APW-03 — `GET /api/apps-catalog` and `GET /api/apps-catalog/:id`, the
 * manifest-backed Apps catalog (see {@link AppsCatalogManifestService}).
 *
 * Registered AFTER `AppsCatalogBlueprintsController` in `WorksModule`, so the
 * fixed `blueprints` segment is matched before `:id` (the route-order rule plan
 * §4.1 states for `/licenses`).
 *
 * Behind the session guard and refused `400 app_works_disabled` while the App
 * Works switch is off, like inspect and the Blueprint listing: the only reader
 * today is the create form. (Plan §4.1 marks the route `@Public()` for a future
 * public catalog page; making it public is a one-line change once one exists.)
 */
@ApiTags('Works')
@ApiBearerAuth('JWT-auth')
@Controller('api/apps-catalog')
@UseGuards(AuthSessionGuard)
export class AppsCatalogController {
    constructor(private readonly catalog: AppsCatalogManifestService) {}

    @Get()
    @Throttle({ long: { limit: APPS_CATALOG_PUBLIC_PER_MIN, ttl: 60_000 } })
    @ApiOperation({
        summary: 'List the Apps catalog',
        description:
            'The App rows of the catalog repository’s manifest.json (EVER_WORKS_APPS_CATALOG_REPO at ' +
            'EVER_WORKS_APPS_CATALOG_REF), red licences never listed, text reduced to plain text. ' +
            '`available: false` with no items when the manifest could not be read.',
    })
    @ApiQuery({ name: 'q', required: false, description: 'Search (2 characters or more).' })
    @ApiQuery({
        name: 'status',
        required: false,
        description: '`production` · `beta` · `placeholder`.',
    })
    @ApiQuery({ name: 'page', required: false })
    @ApiQuery({ name: 'limit', required: false, description: '1–100, default 24.' })
    @ApiResponse({ status: 200, description: '`AppsCatalogListingResponse`.' })
    @ApiResponse({ status: 400, description: '`app_works_disabled`.' })
    async list(
        @Query('q') q?: string,
        @Query('status') status?: string,
        @Query('page') page?: string,
        @Query('limit') limit?: string,
    ): Promise<AppsCatalogListingResponse> {
        this.assertEnabled();
        return this.catalog.list({
            q: typeof q === 'string' ? q.slice(0, 100) : undefined,
            status: typeof status === 'string' ? status : undefined,
            page: page ? Number(page) : undefined,
            limit: limit ? Number(limit) : undefined,
        });
    }

    @Get(':id')
    @Throttle({ long: { limit: APPS_CATALOG_PUBLIC_PER_MIN, ttl: 60_000 } })
    @ApiOperation({ summary: 'Read one Apps catalog entry' })
    @ApiParam({ name: 'id', description: 'Blueprint id, e.g. `umami`.' })
    @ApiResponse({ status: 200, description: '`AppsCatalogListingItem`.' })
    @ApiResponse({ status: 404, description: '`not_found` — no such entry.' })
    async get(@Param('id') id: string): Promise<AppsCatalogListingItem> {
        this.assertEnabled();
        const item = await this.catalog.get(id);
        if (!item) {
            throw new HttpException(
                { status: 'error', code: 'not_found', message: `No Apps catalog entry "${id}".` },
                HttpStatus.NOT_FOUND,
            );
        }
        return item;
    }

    private assertEnabled(): void {
        if (!config.everWorks.apps.worksEnabled()) {
            throw new HttpException(
                {
                    status: 'error',
                    code: 'app_works_disabled',
                    message: 'App Works are not available on this instance.',
                },
                HttpStatus.BAD_REQUEST,
            );
        }
    }
}
