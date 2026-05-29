import { Controller, Get, HttpCode, HttpStatus, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import {
    AgentTemplateCatalogService,
    type AstTemplateEntry,
    type AstTemplateEntityType,
} from './agent-template-catalog.service';

/**
 * `GET /api/agent-templates?entity=agent` (ADR-011, spec FR-27).
 *
 * Public read — the agent-template catalog is non-sensitive and is
 * consumed by the web app's server components / server action. Returns
 * an empty array when the catalog is unavailable; the caller falls back
 * to its built-in list, so a cold/unauthenticated catalog never errors.
 */
@ApiTags('Agents')
@Controller('api/agent-templates')
export class AgentTemplatesController {
    constructor(private readonly catalog: AgentTemplateCatalogService) {}

    @Get()
    @Public()
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'List agent templates from the ever-works/agents catalog' })
    @ApiResponse({ status: 200, description: 'Catalog entries (empty array when unavailable)' })
    async list(@Query('entity') entity?: string): Promise<AstTemplateEntry[]> {
        const normalized: AstTemplateEntityType =
            entity === 'skill' || entity === 'task' ? entity : 'agent';
        return this.catalog.list(normalized);
    }
}
