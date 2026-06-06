import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsUrl } from 'class-validator';

export class ComposioToolkitDto {
    @ApiProperty({ description: 'Toolkit slug (e.g. GMAIL, GITHUB)' })
    slug!: string;

    @ApiProperty({ description: 'Human-friendly name' })
    name!: string;

    @ApiPropertyOptional({ description: 'Toolkit description' })
    description?: string;

    @ApiPropertyOptional({ description: 'Categories the toolkit belongs to', type: [String] })
    categories?: string[];
}

export class ComposioToolkitListDto {
    @ApiProperty({ type: [ComposioToolkitDto] })
    items!: ComposioToolkitDto[];
}

export class ComposioConnectedAccountDto {
    @ApiProperty({ description: 'Composio account id (ca_*)' })
    id!: string;

    @ApiProperty({ description: 'ACTIVE / INITIATED / EXPIRED / REVOKED / FAILED' })
    status!: string;

    @ApiPropertyOptional({ description: 'Toolkit slug this connection authenticates' })
    toolkitSlug?: string;

    @ApiPropertyOptional({ description: 'Composio user id the connection belongs to' })
    userId?: string;
}

export class ComposioConnectedAccountListDto {
    @ApiProperty({ type: [ComposioConnectedAccountDto] })
    items!: ComposioConnectedAccountDto[];
}

export class InitiateConnectionRequestDto {
    @ApiProperty({ description: 'Toolkit to connect (e.g. GMAIL)' })
    @IsString()
    @IsNotEmpty()
    toolkitSlug!: string;

    @ApiProperty({
        description:
            'Composio authConfig id (ac_*) to use for this connection. Create an auth config for the toolkit in the Composio dashboard (or via the auth-configs API) and pass its id here.',
    })
    @IsString()
    @IsNotEmpty()
    authConfigId!: string;

    @ApiPropertyOptional({
        description:
            'Where Composio should redirect after the OAuth dance completes. Defaults to the platform-configured callback page.',
    })
    @IsOptional()
    // Security: restrict to http/https and require a protocol so caller-supplied
    // callback URLs can't smuggle javascript:/data:/file: schemes into the OAuth
    // redirect (open-redirect / XSS). class-validator's IsUrl does NOT restrict
    // schemes unless protocols/require_protocol are set explicitly.
    @IsUrl({ require_tld: false, require_protocol: true, protocols: ['http', 'https'] })
    callbackUrl?: string;
}

export class InitiateConnectionResponseDto {
    @ApiProperty({ description: 'OAuth URL to open in a popup. User completes the flow here.' })
    redirectUrl!: string;

    @ApiPropertyOptional({
        description:
            'Composio connected-account id created by `initiate`. Stays INITIATED until the user completes OAuth, then transitions to ACTIVE. Poll `/connected-accounts` to detect the transition.',
    })
    connectedAccountId?: string;
}
