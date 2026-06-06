import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    NotFoundException,
    Param,
    ParseUUIDPipe,
    Patch,
    Post,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PluginAllowlistRepository } from '@ever-works/agent/plugins';
import type { PluginAllowlistEntity } from '@ever-works/agent/plugins';
import { AuthSessionGuard } from '../auth';
import { IsPlatformAdminGuard } from '../auth/guards/platform-admin.guard';
import {
    CreatePluginAllowlistEntryBodyDto,
    PluginAllowlistEntryResponseDto,
    PluginAllowlistResponseDtoClass,
    UpdatePluginAllowlistEntryBodyDto,
} from './dto/plugin-allowlist.dto';

/**
 * EW-693 / T23 — Admin allowlist CRUD for non-first-party plugins.
 *
 * First-party `@ever-works/*` is implicitly permitted by the installer
 * and has NO rows here. Everything else MUST have an enabled
 * `plugin_allowlist` row before
 * `POST /api/plugins/:id/install` will fetch anything (FR-11).
 *
 * Gated by `IsPlatformAdminGuard` — platform admins only. The session
 * guard runs first so unauthenticated requests 401 before the admin
 * check fires.
 */
@ApiTags('Plugin Admin Allowlist')
@ApiBearerAuth('JWT-auth')
@Controller('api/admin/plugins/allowlist')
@UseGuards(AuthSessionGuard, IsPlatformAdminGuard)
export class PluginAllowlistController {
    constructor(private readonly allowlist: PluginAllowlistRepository) {}

    @Get()
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'List every allowlist entry (enabled + disabled)',
        description:
            'Returns every row in `plugin_allowlist`, ordered alphabetically by package name. ' +
            'First-party `@ever-works/*` plugins are NOT listed here — they are implicitly permitted by the installer.',
    })
    @ApiResponse({ status: 200, type: PluginAllowlistResponseDtoClass })
    async list(): Promise<PluginAllowlistResponseDtoClass> {
        const rows = await this.allowlist.findAll();
        return { entries: rows.map(toResponseDto) };
    }

    @Post()
    @HttpCode(HttpStatus.CREATED)
    @ApiOperation({
        summary: 'Add a package to the allowlist',
        description:
            'Once added, the package is eligible for `POST /api/plugins/:id/install`. ' +
            'Use `enabled: false` to register a row without permitting installs yet.',
    })
    @ApiResponse({ status: 201, type: PluginAllowlistEntryResponseDto })
    async create(
        @Body() body: CreatePluginAllowlistEntryBodyDto,
    ): Promise<PluginAllowlistEntryResponseDto> {
        const entry = await this.allowlist.create({
            packageName: body.packageName,
            versionRange: body.versionRange,
            integrity: body.integrity ?? null,
            source: body.source ?? 'npm',
            enabled: body.enabled ?? true,
        });
        return toResponseDto(entry);
    }

    @Patch(':id')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Update an existing allowlist entry (toggle / re-pin)',
    })
    @ApiParam({ name: 'id', description: 'Allowlist entry UUID' })
    @ApiResponse({ status: 200, type: PluginAllowlistEntryResponseDto })
    @ApiResponse({ status: 404, description: 'No allowlist entry with that id' })
    async update(
        @Param('id', new ParseUUIDPipe()) id: string,
        @Body() body: UpdatePluginAllowlistEntryBodyDto,
    ): Promise<PluginAllowlistEntryResponseDto> {
        const existing = await this.allowlist.findById(id);
        if (!existing) {
            throw new NotFoundException(`Allowlist entry "${id}" not found`);
        }
        const updated = await this.allowlist.update(id, {
            ...(body.versionRange !== undefined ? { versionRange: body.versionRange } : {}),
            ...(body.integrity !== undefined ? { integrity: body.integrity } : {}),
            ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        });
        if (!updated) throw new NotFoundException(`Allowlist entry "${id}" not found`);
        return toResponseDto(updated);
    }

    @Delete(':id')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({
        summary: 'Remove an allowlist entry',
        description:
            'Removes the row. Already-installed plugins keep working — uninstalling them is a separate ' +
            '`DELETE /api/plugins/:id/install` call.',
    })
    @ApiParam({ name: 'id', description: 'Allowlist entry UUID' })
    @ApiResponse({ status: 204 })
    @ApiResponse({ status: 404, description: 'No allowlist entry with that id' })
    async remove(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
        const ok = await this.allowlist.deleteById(id);
        if (!ok) throw new NotFoundException(`Allowlist entry "${id}" not found`);
    }
}

function toResponseDto(row: PluginAllowlistEntity): PluginAllowlistEntryResponseDto {
    return {
        id: row.id,
        packageName: row.packageName,
        versionRange: row.versionRange,
        integrity: row.integrity ?? undefined,
        source: row.source,
        enabled: row.enabled,
        createdAt: row.createdAt.toISOString(),
    };
}
