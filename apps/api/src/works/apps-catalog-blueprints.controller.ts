import { Controller, Get, HttpException, HttpStatus, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { config } from '@ever-works/agent/config';
import { AuthSessionGuard } from '../auth';
import {
    AppsCatalogBlueprintsService,
    type AppsCatalogBlueprintList,
} from './apps-catalog-blueprints.service';

/**
 * `GET /api/apps-catalog/blueprints` — the create form's "Browse the Apps
 * catalog" tab (APW-01 T22). See {@link AppsCatalogBlueprintsService} for why it
 * reads the Blueprint topic on GitHub and why it is not `/api/apps-catalog`.
 *
 * Behind the session guard (only the create form reads it) and refused with
 * `400 app_works_disabled` while `EVER_WORKS_APP_WORKS_ENABLED` is off — the
 * same answer inspect gives, so a hidden surface cannot be reached by URL.
 */
@ApiTags('Works')
@ApiBearerAuth('JWT-auth')
@Controller('api/apps-catalog')
@UseGuards(AuthSessionGuard)
export class AppsCatalogBlueprintsController {
    constructor(private readonly blueprints: AppsCatalogBlueprintsService) {}

    @Get('blueprints')
    @Throttle({ long: { limit: 120, ttl: 60_000 } })
    @ApiOperation({
        summary: 'List the App Blueprints the create form can start from',
        description:
            'Every public ever-works repository carrying the ever-works-app-blueprint topic, newest listing at ' +
            'most 10 minutes old. `available: false` with no items when GitHub could not be read.',
    })
    @ApiQuery({ name: 'q', required: false, description: 'Search (2 characters or more).' })
    @ApiResponse({ status: 200, description: '`{ items, total, available, source }`.' })
    @ApiResponse({ status: 400, description: '`app_works_disabled`.' })
    async list(@Query('q') q?: string): Promise<AppsCatalogBlueprintList> {
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
        return this.blueprints.list(typeof q === 'string' ? q.slice(0, 100) : undefined);
    }
}
