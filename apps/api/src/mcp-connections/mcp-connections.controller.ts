import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Patch,
    Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
    McpConnectionsService,
    type McpConnectionTestResult,
    type McpConnectionView,
} from '@ever-works/agent/mcp';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { CreateMcpConnectionDto, UpdateMcpConnectionDto } from './dto/mcp-connection.dto';

/**
 * Agent Plugins MCP slice — CRUD + test for the workspace-global manual
 * MCP connection registry (Settings → Connections).
 *
 * Responses are MASKED views: auth header VALUES never leave the service
 * layer — only `authHeaderNames`. Cross-user access to a row is a 404,
 * never a 403 (no existence leak).
 */
@ApiTags('mcp-connections')
@Controller('api/mcp-connections')
export class McpConnectionsController {
    constructor(private readonly service: McpConnectionsService) {}

    @Get()
    @ApiOperation({ summary: 'List my MCP connections (masked — header names only).' })
    @HttpCode(HttpStatus.OK)
    async list(@CurrentUser() auth: AuthenticatedUser): Promise<{ data: McpConnectionView[] }> {
        return { data: await this.service.list(auth.userId) };
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get one MCP connection (masked).' })
    @HttpCode(HttpStatus.OK)
    async get(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<McpConnectionView> {
        return this.service.get(auth.userId, id);
    }

    @Post()
    @ApiOperation({ summary: 'Add a manual MCP connection (creates the tenant inherit binding).' })
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async create(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: CreateMcpConnectionDto,
    ): Promise<McpConnectionView> {
        return this.service.create(auth.userId, {
            name: body.name,
            url: body.url,
            transport: body.transport,
            authHeaders: body.authHeaders,
        });
    }

    @Patch(':id')
    @ApiOperation({ summary: 'Update an MCP connection (enable/disable, url, transport, auth).' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async update(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: UpdateMcpConnectionDto,
    ): Promise<McpConnectionView> {
        return this.service.update(auth.userId, id, {
            name: body.name,
            url: body.url,
            transport: body.transport,
            authHeaders: body.authHeaders,
            enabled: body.enabled,
        });
    }

    @Delete(':id')
    @ApiOperation({ summary: 'Delete an MCP connection (cascades to bindings).' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async remove(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<{ deleted: true }> {
        return this.service.remove(auth.userId, id);
    }

    @Post(':id/test')
    @ApiOperation({
        summary: 'Connect + list tools; stamps lastConnectedAt / lastError on the row.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 20, ttl: 60_000 } })
    async test(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<McpConnectionTestResult> {
        return this.service.test(auth.userId, id);
    }
}
