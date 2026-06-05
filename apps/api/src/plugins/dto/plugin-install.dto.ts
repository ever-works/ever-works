import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import type {
    PluginCatalogEntry,
    PluginCatalogResponse,
    PluginInstallRequestDto,
    PluginInstallStateDto,
    PluginInstallResponseDto,
} from '@ever-works/contracts';

/**
 * EW-693 / T21 — class-based DTOs that mirror the wire-types from
 * `@ever-works/contracts/api/plugins` so Swagger picks them up while
 * the controller still consumes the same shape as any other client.
 *
 * The runtime classes are kept narrow — pure value-objects, no
 * behaviour — so `class-validator` + `class-transformer` can do their
 * job without dragging the contract layer into the API runtime.
 */

export class PluginInstallRequestBodyDto implements PluginInstallRequestDto {
    @ApiPropertyOptional({
        description: 'Exact npm version to install. Omit for `latest`.',
        example: '1.2.0',
    })
    @IsOptional()
    @IsString()
    readonly version?: string;

    @ApiPropertyOptional({
        description:
            'Optional sha512 integrity. When set the installer refuses if the registry-returned integrity does not match.',
    })
    @IsOptional()
    @IsString()
    readonly integrity?: string;

    @ApiPropertyOptional({
        description: 'Preferred registry source — defaults to "npm".',
        enum: ['npm', 'github-packages'],
    })
    @IsOptional()
    @IsIn(['npm', 'github-packages'])
    readonly source?: 'npm' | 'github-packages';
}

export class PluginInstallStateResponseDto implements PluginInstallStateDto {
    @ApiProperty()
    readonly pluginId!: string;

    @ApiProperty({ enum: ['available', 'installing', 'installed', 'error'] })
    readonly installState!: 'available' | 'installing' | 'installed' | 'error';

    @ApiProperty({ enum: ['bundled', 'registry'] })
    readonly source!: 'bundled' | 'registry';

    @ApiPropertyOptional()
    readonly registrySpec?: string;

    @ApiPropertyOptional()
    readonly installedVersion?: string;

    @ApiPropertyOptional()
    readonly integrity?: string;

    @ApiPropertyOptional()
    readonly installError?: string;

    @ApiPropertyOptional()
    readonly updatedAt?: string;
}

export class PluginInstallResultDto implements PluginInstallResponseDto {
    @ApiProperty()
    readonly pluginId!: string;

    @ApiProperty({ type: PluginInstallStateResponseDto })
    readonly install!: PluginInstallStateResponseDto;
}

export class PluginCatalogEntryDto implements PluginCatalogEntry {
    @ApiProperty()
    readonly pluginId!: string;

    @ApiProperty()
    readonly name!: string;

    @ApiProperty()
    readonly description!: string;

    @ApiProperty()
    readonly category!: string;

    @ApiProperty({ type: [String] })
    readonly capabilities!: readonly string[];

    @ApiProperty()
    readonly version!: string;

    @ApiProperty({ enum: ['core', 'registry'] })
    readonly distribution!: 'core' | 'registry';

    @ApiPropertyOptional()
    readonly packageName?: string;

    @ApiPropertyOptional()
    readonly latestVersion?: string;

    @ApiPropertyOptional()
    readonly homepage?: string;

    @ApiPropertyOptional()
    readonly author?: string;

    @ApiPropertyOptional()
    readonly deprecated?: boolean;

    @ApiProperty({ type: PluginInstallStateResponseDto })
    readonly install!: PluginInstallStateResponseDto;
}

export class PluginCatalogResponseDto implements PluginCatalogResponse {
    @ApiProperty({ type: [PluginCatalogEntryDto] })
    readonly entries!: readonly PluginCatalogEntryDto[];

    @ApiPropertyOptional()
    readonly fetchedAt?: string;

    @ApiPropertyOptional()
    readonly degraded?: boolean;

    @ApiPropertyOptional()
    readonly degradedReason?: string;
}
