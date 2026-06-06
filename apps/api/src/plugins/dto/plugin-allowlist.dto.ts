import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';
import type {
    CreatePluginAllowlistEntryDto as CreateAllowlistEntry,
    PluginAllowlistEntryDto as AllowlistEntry,
    PluginAllowlistResponseDto as AllowlistResponse,
    UpdatePluginAllowlistEntryDto as UpdateAllowlistEntry,
} from '@ever-works/contracts/api';

/**
 * EW-693 / T23 — admin allowlist DTOs. Pure wire-types layered with
 * `class-validator` for the global ValidationPipe so admins can
 * `POST /admin/plugins/allowlist` with confidence that bad payloads
 * 400 before they reach the repository.
 */

export class CreatePluginAllowlistEntryBodyDto implements CreateAllowlistEntry {
    @ApiProperty({ description: 'Full npm package name', example: '@some-vendor/cool-plugin' })
    @IsString()
    readonly packageName!: string;

    @ApiProperty({
        description: 'Semver range pinning permitted versions',
        example: '^2.0.0',
    })
    @IsString()
    readonly versionRange!: string;

    @ApiPropertyOptional({ description: 'Optional sha512 integrity pin' })
    @IsOptional()
    @IsString()
    readonly integrity?: string;

    @ApiPropertyOptional({ enum: ['npm', 'github-packages'], default: 'npm' })
    @IsOptional()
    @IsIn(['npm', 'github-packages'])
    readonly source?: 'npm' | 'github-packages';

    @ApiPropertyOptional({ default: true })
    @IsOptional()
    @IsBoolean()
    readonly enabled?: boolean;
}

export class UpdatePluginAllowlistEntryBodyDto implements UpdateAllowlistEntry {
    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    readonly versionRange?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    readonly integrity?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsBoolean()
    readonly enabled?: boolean;
}

export class PluginAllowlistEntryResponseDto implements AllowlistEntry {
    @ApiProperty()
    readonly id!: string;

    @ApiProperty()
    readonly packageName!: string;

    @ApiProperty()
    readonly versionRange!: string;

    @ApiPropertyOptional()
    readonly integrity?: string;

    @ApiProperty({ enum: ['npm', 'github-packages'] })
    readonly source!: 'npm' | 'github-packages';

    @ApiProperty()
    readonly enabled!: boolean;

    @ApiProperty()
    readonly createdAt!: string;
}

export class PluginAllowlistResponseDtoClass implements AllowlistResponse {
    @ApiProperty({ type: [PluginAllowlistEntryResponseDto] })
    readonly entries!: readonly PluginAllowlistEntryResponseDto[];
}
