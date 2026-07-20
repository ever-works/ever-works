import { Controller, Get, HttpCode, HttpStatus, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import {
    WorksTemplateCatalogService,
    type WorkBlueprintEntry,
} from './works-template-catalog.service';

/**
 * `GET /api/work-templates?chipType=directory` (Works Templates spec, ADR-014).
 *
 * Public read — the Work-blueprint catalog is non-sensitive, org-curated,
 * and consumed by the web app's Create-Work server pages. Returns an empty
 * array when the catalog is unavailable; the caller falls back to its
 * built-in list, so a cold / rate-limited / unreachable catalog never errors.
 */
@ApiTags('Works')
@Controller('api/work-templates')
export class WorkTemplatesController {
    constructor(private readonly catalog: WorksTemplateCatalogService) {}

    @Get()
    @Public()
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'List Work blueprints from the ever-works/works catalog' })
    @ApiResponse({ status: 200, description: 'Blueprint entries (empty array when unavailable)' })
    async list(@Query('chipType') chipType?: string): Promise<WorkBlueprintEntry[]> {
        const normalized =
            typeof chipType === 'string' && chipType.length > 0 ? chipType : undefined;
        return this.catalog.list(normalized);
    }
}
