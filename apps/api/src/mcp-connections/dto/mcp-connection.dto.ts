import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsBoolean,
    IsEnum,
    IsObject,
    IsOptional,
    IsString,
    Matches,
    MaxLength,
} from 'class-validator';
import type { McpConnectionTransport } from '@ever-works/agent/mcp';

export const MCP_CONNECTION_TRANSPORTS = ['streamable-http', 'sse'] as const;

/**
 * Agent Plugins MCP slice — DTOs for the manual connection registry.
 *
 * `authHeaders` is a `{headerName: value}` map validated shallowly here
 * (object shape); the service layer enforces header-name charset, count
 * and value-length caps. Values are write-only: no response DTO ever
 * carries them back (responses expose `authHeaderNames` only).
 */
export class CreateMcpConnectionDto {
    @ApiProperty({
        description:
            'Slug-safe server name — becomes the mcp__<name>__<tool> prefix. Lowercase letters, digits, hyphens; max 80 chars.',
        maxLength: 80,
    })
    @IsString()
    @Matches(/^[a-z0-9][a-z0-9-]{0,79}$/)
    name: string;

    @ApiProperty({ description: 'MCP server endpoint URL (http/https).', maxLength: 2048 })
    @IsString()
    @MaxLength(2048)
    url: string;

    @ApiProperty({ enum: MCP_CONNECTION_TRANSPORTS })
    @IsEnum(MCP_CONNECTION_TRANSPORTS)
    transport: McpConnectionTransport;

    @ApiPropertyOptional({
        description: 'Auth headers as {headerName: value}. Write-only — never echoed.',
        type: 'object',
        additionalProperties: { type: 'string' },
    })
    @IsOptional()
    @IsObject()
    authHeaders?: Record<string, string>;
}

export class UpdateMcpConnectionDto {
    @ApiPropertyOptional({ maxLength: 80 })
    @IsOptional()
    @IsString()
    @Matches(/^[a-z0-9][a-z0-9-]{0,79}$/)
    name?: string;

    @ApiPropertyOptional({ maxLength: 2048 })
    @IsOptional()
    @IsString()
    @MaxLength(2048)
    url?: string;

    @ApiPropertyOptional({ enum: MCP_CONNECTION_TRANSPORTS })
    @IsOptional()
    @IsEnum(MCP_CONNECTION_TRANSPORTS)
    transport?: McpConnectionTransport;

    @ApiPropertyOptional({
        description:
            'Replacement auth headers as {headerName: value}. Write-only — never echoed. Pass null to clear.',
        type: 'object',
        additionalProperties: { type: 'string' },
        nullable: true,
    })
    @IsOptional()
    @IsObject()
    authHeaders?: Record<string, string>;

    @ApiPropertyOptional()
    @IsOptional()
    @IsBoolean()
    enabled?: boolean;
}

export class SetAgentMcpBindingDto {
    @ApiProperty({
        description:
            'Per-agent override: false disables an inherited connection for this agent; true binds it explicitly.',
    })
    @IsBoolean()
    enabled: boolean;
}
