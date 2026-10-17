import {
    Controller,
    Post,
    Get,
    Delete,
    Body,
    Param,
    Request,
    NotFoundException,
    UseGuards,
    HttpCode,
    HttpStatus,
    Optional,
    ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { ApiKeyService } from '../services/api-key.service';
import { IntegrationKeyService } from '../services/integration-key.service';
import { CreateApiKeyDto, CreateIntegrationKeyDto, RotateApiKeyDto } from '../dto/api-key.dto';
import { IntegrationForbiddenGuard } from '../integration/integration-forbidden.guard';
import { SessionCredentialOnly } from '../integration/integration.decorators';

/**
 * API keys — personal (`ew_live_`) and, since EW-P1-2, integration (`ew_int_`).
 *
 *   POST   /api/auth/api-keys                 create a personal key   (session only)
 *   GET    /api/auth/api-keys                 list my personal keys
 *   POST   /api/auth/api-keys/integration     create an integration key (session only, Tenant owner)
 *   GET    /api/auth/api-keys/integration     list the Tenant's integration keys (Tenant owner)
 *   POST   /api/auth/api-keys/:id/rotate      rotate in place with a grace period (session only)
 *   DELETE /api/auth/api-keys/:id             revoke (integration keys are deactivated, not deleted)
 *
 * `IntegrationForbiddenGuard` keeps every integration key off this controller,
 * and `@SessionCredentialOnly()` keeps every machine credential — including a
 * personal `ew_live_` key — from minting or rotating keys.
 */
@ApiTags('API Keys')
@ApiBearerAuth()
@Controller('api/auth/api-keys')
@UseGuards(IntegrationForbiddenGuard)
export class ApiKeysController {
    constructor(
        private readonly apiKeyService: ApiKeyService,
        // Appended LAST + @Optional() so existing positional constructions in
        // the specs keep compiling; the integration routes 404 without it.
        @Optional() private readonly integrationKeys?: IntegrationKeyService,
    ) {}

    @Post()
    @SessionCredentialOnly()
    @ApiOperation({ summary: 'Create a new API key' })
    @ApiResponse({ status: 201, description: 'API key created successfully' })
    @ApiResponse({ status: 400, description: 'Maximum number of keys reached' })
    @ApiResponse({ status: 403, description: 'Called with an API key instead of a session' })
    async create(@Request() req: any, @Body() dto: CreateApiKeyDto) {
        return this.apiKeyService.createKey(req.user.userId, dto.name, dto.expiresAt);
    }

    @Get()
    @ApiOperation({ summary: 'List all API keys for the current user' })
    @ApiResponse({ status: 200, description: 'List of API keys' })
    async list(@Request() req: any) {
        return this.apiKeyService.listKeys(req.user.userId);
    }

    @Post('integration')
    @SessionCredentialOnly()
    @ApiOperation({
        summary: 'Create an integration key (ew_int_…) pinned to organizations, with scopes',
    })
    @ApiResponse({
        status: 201,
        description: 'Integration key created; the secret is returned once',
    })
    @ApiResponse({
        status: 400,
        description: 'Invalid scopes or pins, or the cap of 20 is reached',
    })
    @ApiResponse({ status: 403, description: 'Not the workspace owner, or not a session' })
    async createIntegration(@Request() req: any, @Body() dto: CreateIntegrationKeyDto) {
        return this.requireIntegrationKeys().create(req.user.userId, dto);
    }

    @Get('integration')
    @ApiOperation({ summary: "List the workspace's integration keys (workspace owner only)" })
    @ApiResponse({ status: 200, description: 'Integration keys (never the secret)' })
    async listIntegration(@Request() req: any) {
        return this.requireIntegrationKeys().list(req.user.userId);
    }

    @Post(':id/rotate')
    @SessionCredentialOnly()
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary:
            'Rotate an API key in place; the previous secret works until the grace period ends',
    })
    @ApiResponse({ status: 200, description: 'New secret (returned once) and the grace deadline' })
    @ApiResponse({ status: 404, description: 'API key not found' })
    async rotate(
        @Request() req: any,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() dto: RotateApiKeyDto,
    ) {
        const rotated = await this.apiKeyService.rotateKey(id, req.user.userId, dto?.graceHours);
        // The new secret exists only in this response: the audit row can never
        // be allowed to fail the request (`recordRotation` swallows its own
        // errors too; this is the belt to those braces).
        await this.integrationKeys?.recordRotation(req.user.userId, id).catch(() => undefined);
        return rotated;
    }

    @Delete(':id')
    @ApiOperation({ summary: 'Revoke an API key' })
    @ApiResponse({ status: 200, description: 'API key revoked' })
    @ApiResponse({ status: 404, description: 'API key not found' })
    async revoke(@Request() req: any, @Param('id') id: string) {
        // Integration keys are switched off (kept for audit); everything else
        // keeps today's delete.
        if (await this.integrationKeys?.revoke(id, req.user.userId)) {
            return { message: 'API key revoked successfully' };
        }
        const deleted = await this.apiKeyService.revokeKey(id, req.user.userId);
        if (!deleted) {
            throw new NotFoundException('API key not found');
        }
        return { message: 'API key revoked successfully' };
    }

    private requireIntegrationKeys(): IntegrationKeyService {
        if (!this.integrationKeys) throw new NotFoundException();
        return this.integrationKeys;
    }
}
