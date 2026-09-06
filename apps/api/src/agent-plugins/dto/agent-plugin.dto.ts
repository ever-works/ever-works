import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsBoolean,
    IsIn,
    IsOptional,
    IsString,
    IsUrl,
    MaxLength,
    MinLength,
} from 'class-validator';

/**
 * Remote sources that require an allowlist entry.
 *
 * `local` is absent on purpose: a local package already sits in a directory
 * the operator configured and controls, so an allowlist entry would be asking
 * their permission for bytes they put there themselves.
 */
export const AGENT_PLUGIN_ALLOWLIST_SOURCES = ['git', 'npm'] as const;

/**
 * Every DTO here is validated by the GLOBAL pipe, which runs with
 * `whitelist: true` and `forbidNonWhitelisted: true`. Two consequences worth
 * stating, because both fail quietly:
 *
 * - A property with no class-validator decorator is silently DELETED from the
 *   body before the handler sees it. The symptom is a field that is always
 *   `undefined`, with no error anywhere.
 * - An unknown field is a 400, so adding a field to a request DTO is a
 *   wire-compatibility event in both directions during a rolling deploy.
 */

export class ListAgentPluginPackagesQueryDto {
    @ApiPropertyOptional({
        description: 'Filter to packages whose name or a contributed skill matches this text.',
    })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    search?: string;
}

export class CreateAgentPluginAllowlistEntryDto {
    @ApiProperty({
        description: 'The npm package name, or git URL, this entry permits fetching.',
    })
    @IsString()
    @MinLength(1)
    @MaxLength(2048)
    packageName: string;

    @ApiProperty({ enum: AGENT_PLUGIN_ALLOWLIST_SOURCES })
    @IsIn(AGENT_PLUGIN_ALLOWLIST_SOURCES)
    source: (typeof AGENT_PLUGIN_ALLOWLIST_SOURCES)[number];

    @ApiPropertyOptional({
        description: 'Permitted versions — a semver range for npm, a ref pattern for git.',
    })
    @IsOptional()
    @IsString()
    @MaxLength(256)
    versionRange?: string;

    @ApiPropertyOptional({
        description: 'Expected sha512 (npm) or commit (git), when pinned exactly.',
    })
    @IsOptional()
    @IsString()
    @MaxLength(256)
    integrity?: string;

    @ApiPropertyOptional({
        description: 'Why this entry exists — an audit note for the next operator.',
    })
    @IsOptional()
    @IsString()
    @MaxLength(2000)
    notes?: string;
}

export class UpdateAgentPluginAllowlistEntryDto {
    @ApiPropertyOptional({
        description:
            'Revoke permission without deleting the row, so the reason it existed stays visible.',
    })
    @IsOptional()
    @IsBoolean()
    enabled?: boolean;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    @MaxLength(256)
    versionRange?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    @MaxLength(2000)
    notes?: string;
}

/** Which remote source a package is installed from. */
export const AGENT_PLUGIN_INSTALL_SOURCES = ['git', 'npm'] as const;

export class InstallAgentPluginPackageDto {
    @ApiProperty({ enum: AGENT_PLUGIN_INSTALL_SOURCES })
    @IsIn(AGENT_PLUGIN_INSTALL_SOURCES)
    source: (typeof AGENT_PLUGIN_INSTALL_SOURCES)[number];

    @ApiPropertyOptional({
        description: 'HTTPS clone URL. Required when source is "git".',
    })
    @IsOptional()
    @IsString()
    @MaxLength(2048)
    url?: string;

    @ApiPropertyOptional({
        description: 'Branch or tag to pin. Only meaningful when source is "git".',
    })
    @IsOptional()
    @IsString()
    @MaxLength(256)
    ref?: string;

    @ApiPropertyOptional({
        description: 'Package name. Required when source is "npm".',
    })
    @IsOptional()
    @IsString()
    @MaxLength(214)
    packageName?: string;

    @ApiPropertyOptional({
        description: 'Version or dist-tag. Only meaningful when source is "npm".',
    })
    @IsOptional()
    @IsString()
    @MaxLength(256)
    version?: string;
}

export class DescriptorQueryDto {
    /**
     * Override the endpoint the descriptor points at, for a self-hosted
     * deployment.
     *
     * Validated rather than taken raw. This value is written verbatim into the
     * `mcp.json` we hand out, and a consuming client connects to whatever it
     * finds there — so an unvalidated string here becomes somebody else's
     * outbound request. A bare `@Query('url')` string bypasses the global
     * pipe entirely, because the pipe validates DTO classes.
     *
     * https only, for the same reason the git acquirer requires it: package
     * contents are read as agent instructions, and a plaintext hop is an
     * injection point.
     *
     * `disallow_auth` and `allow_fragments: false` are not decoration — they
     * are what makes this agree with `validateRemoteUrl`, which spec 7.2.1
     * requires and which rejects both. `@IsUrl` permits both by default, so
     * without them `https://user:pass@host/` reached the descriptor, and
     * `buildEverWorksMcpDescriptor` REPORTS a bad URL in `findings` rather
     * than throwing. The endpoint would answer 200 with an `mcp.json`
     * carrying embedded credentials — contradicting the one promise it makes
     * in its own OpenAPI description, that the descriptor contains none. A
     * consumer writing `files` to disk and ignoring `findings` gets the
     * credential; a fragment is refused for the same reason the importer
     * refuses it, so the two ends cannot disagree about what is valid.
     */
    @ApiPropertyOptional({ description: 'Self-hosted MCP endpoint (https).' })
    @IsOptional()
    @IsUrl({
        protocols: ['https'],
        require_protocol: true,
        disallow_auth: true,
        allow_fragments: false,
    })
    @MaxLength(2048)
    url?: string;
}
