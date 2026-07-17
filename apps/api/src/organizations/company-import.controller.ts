import { Body, Controller, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CompanyImportReport, CompanyImportService } from './company-import.service';
import { ImportCompanyDto } from './dto/import-company.dto';

/**
 * Teams & Prebuilt Companies — company-template import (spec §6.2).
 *
 * Creates a NEW Organization (so no `:orgId` ownership guard applies —
 * `AuthSessionGuard` authenticates, the org lands in the caller's own
 * Tenant exactly like `POST /api/organizations`). Heavier than a plain
 * create → stricter throttle.
 */
@ApiTags('Organizations')
@ApiBearerAuth('JWT-auth')
@Controller('api/organizations')
export class CompanyImportController {
    constructor(private readonly importer: CompanyImportService) {}

    @Post('import-company')
    @Throttle({ long: { limit: 5, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Create an Organization from a prebuilt company template',
        description:
            'Materializes an agentcompanies/v1 package from the ever-works/orgs catalog: Organization + Teams + paused Agents + Skills + draft Works + Tasks. Per-entity failures are reported in `skipped[]`, not thrown.',
    })
    @ApiResponse({ status: 201, description: 'Organization imported' })
    @ApiResponse({ status: 404, description: 'Unknown template slug' })
    @ApiResponse({ status: 503, description: 'Catalog unavailable' })
    async importCompany(
        @Req() req: { user: { userId: string } },
        @Body() dto: ImportCompanyDto,
    ): Promise<CompanyImportReport> {
        return this.importer.importCompany(req.user.userId, {
            templateSlug: dto.templateSlug,
            name: dto.name,
        });
    }
}
