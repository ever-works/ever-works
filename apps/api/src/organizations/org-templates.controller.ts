import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { OrgTemplateCatalogService, OrgTemplateEntry } from './org-template-catalog.service';

/**
 * Prebuilt-company catalog endpoint (teams-and-companies spec §6).
 * Same posture as `/api/agent-templates`: authenticated, read-only,
 * empty list on any catalog failure (the wizard skips its template step).
 */
@ApiTags('Organizations')
@ApiBearerAuth('JWT-auth')
@Controller('api/org-templates')
export class OrgTemplatesController {
    constructor(private readonly catalog: OrgTemplateCatalogService) {}

    @Get()
    @ApiOperation({
        summary: 'List prebuilt company templates',
        description:
            'Catalog of agentcompanies/v1 packages from the ever-works/orgs repo. Empty when the catalog is unreachable — clients treat that as "no template step".',
    })
    @ApiResponse({ status: 200, description: 'Templates listed' })
    async list(): Promise<OrgTemplateEntry[]> {
        return this.catalog.list();
    }
}
