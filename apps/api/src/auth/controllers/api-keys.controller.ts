import { Controller, Post, Get, Delete, Body, Param, Request, NotFoundException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { ApiKeyService } from '../services/api-key.service';
import { CreateApiKeyDto } from '../dto/api-key.dto';

@ApiTags('API Keys')
@ApiBearerAuth()
@Controller('api/auth/api-keys')
export class ApiKeysController {
	constructor(private readonly apiKeyService: ApiKeyService) {}

	@Post()
	@ApiOperation({ summary: 'Create a new API key' })
	@ApiResponse({ status: 201, description: 'API key created successfully' })
	@ApiResponse({ status: 400, description: 'Maximum number of keys reached' })
	async create(@Request() req: any, @Body() dto: CreateApiKeyDto) {
		return this.apiKeyService.createKey(req.user.userId, dto.name, dto.expiresAt);
	}

	@Get()
	@ApiOperation({ summary: 'List all API keys for the current user' })
	@ApiResponse({ status: 200, description: 'List of API keys' })
	async list(@Request() req: any) {
		return this.apiKeyService.listKeys(req.user.userId);
	}

	@Delete(':id')
	@ApiOperation({ summary: 'Revoke an API key' })
	@ApiResponse({ status: 200, description: 'API key revoked' })
	@ApiResponse({ status: 404, description: 'API key not found' })
	async revoke(@Request() req: any, @Param('id') id: string) {
		const deleted = await this.apiKeyService.revokeKey(id, req.user.userId);
		if (!deleted) {
			throw new NotFoundException('API key not found');
		}
		return { message: 'API key revoked successfully' };
	}
}
