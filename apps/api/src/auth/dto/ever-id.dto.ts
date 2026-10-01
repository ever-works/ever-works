import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
    ArrayMaxSize,
    IsArray,
    IsIn,
    IsNotEmpty,
    IsOptional,
    IsString,
    Matches,
    MaxLength,
    ValidateNested,
} from 'class-validator';
import { TermsAcceptanceClaimDto } from './auth.dto';

/** NFR-6: a sealed transaction or pending value is at most 3,072 characters; 4,096 leaves headroom. */
const SEALED_MAX = 4_096;

/**
 * APW-12 (Ever ID) — request bodies of `/api/auth/ever-id/*` (plan §5.1). Bounds
 * are the plan's: `returnTo` ≤ 2,048 characters (re-checked as a same-site
 * relative path by the service, FR-10), `pending`/`transaction` ≤ 4,096.
 */

export class EverIdAuthorizeDto {
    @ApiPropertyOptional({
        description:
            'Where to return after signing in: a relative path starting with "/" but not "//". Anything else falls back to the dashboard.',
        maxLength: 2048,
    })
    @IsOptional()
    @IsString()
    @MaxLength(2048)
    returnTo?: string;
}

export class EverIdCallbackDto {
    @ApiProperty({ description: 'The authorization code the provider returned.' })
    @IsString()
    @IsNotEmpty()
    @MaxLength(SEALED_MAX)
    code: string;

    @ApiProperty({ description: 'The `state` the provider returned.' })
    @IsString()
    @IsNotEmpty()
    @MaxLength(512)
    state: string;

    @ApiPropertyOptional({ description: 'The `iss` the provider returned with the code (FR-12).' })
    @IsOptional()
    @IsString()
    @MaxLength(512)
    iss?: string;

    @ApiProperty({
        description: 'The sealed transaction from `POST /authorize`.',
        maxLength: SEALED_MAX,
    })
    @IsString()
    @IsNotEmpty()
    @MaxLength(SEALED_MAX)
    transaction: string;
}

export class EverIdSignUpConfirmDto {
    @ApiProperty({
        description: 'The sealed pending sign-up from the callback.',
        maxLength: SEALED_MAX,
    })
    @IsString()
    @IsNotEmpty()
    @MaxLength(SEALED_MAX)
    pending: string;

    @ApiProperty({
        description:
            'The terms documents the person accepted on the confirmation screen — the same claims the register route takes. Every currently required document must be present (FR-23).',
        type: [TermsAcceptanceClaimDto],
        maxItems: 10,
    })
    @IsArray()
    @ArrayMaxSize(10)
    @ValidateNested({ each: true })
    @Type(() => TermsAcceptanceClaimDto)
    terms: TermsAcceptanceClaimDto[];
}

export class EverIdConnectConfirmDto {
    @ApiProperty({
        description: 'The sealed pending connection from the callback.',
        maxLength: SEALED_MAX,
    })
    @IsString()
    @IsNotEmpty()
    @MaxLength(SEALED_MAX)
    pending: string;
}

/** `POST /authorize` and `POST /connect/authorize` answer this. */
export class EverIdAuthorizationStartDto {
    @ApiProperty({ description: 'The provider address to send the browser to.' })
    authorizationUrl: string;

    @ApiProperty({
        description: 'The sealed transaction to keep in an HttpOnly cookie.',
        maxLength: SEALED_MAX,
    })
    transaction: string;
}

/** One app that read the person's App Works with a delegated permission. */
export class ExternalIdentityDelegatedClientResponseDto {
    @ApiProperty()
    clientId: string;

    @ApiProperty({ description: 'The configured display name, or the client id itself.' })
    displayName: string;

    @ApiProperty({ description: 'ISO-8601 time of the last delegated read.' })
    lastSeenAt: string;
}

/** `ExternalIdentityDto` — issuer and subject are never returned to the browser (plan §5.1). */
export class ExternalIdentityResponseDto {
    @ApiProperty()
    id: string;

    @ApiProperty({ description: 'The provider display name (FR-2).' })
    displayName: string;

    @ApiProperty({ description: 'The e-mail address the identity had when it was connected.' })
    email: string;

    @ApiProperty({ description: 'ISO-8601 time of connection.' })
    linkedAt: string;

    @ApiProperty({ enum: ['sign-up', 'settings', 'provisioning'] })
    linkedVia: string;

    @ApiProperty({
        nullable: true,
        type: String,
        description: 'ISO-8601 time of the last sign-in.',
    })
    lastLoginAt: string | null;

    @ApiProperty({ type: [ExternalIdentityDelegatedClientResponseDto] })
    delegatedClients: ExternalIdentityDelegatedClientResponseDto[];
}

export class ExternalIdentityListResponseDto {
    @ApiProperty({ type: [ExternalIdentityResponseDto] })
    items: ExternalIdentityResponseDto[];

    @ApiProperty({
        description: 'Whether disconnecting would leave another way to sign in (FR-28).',
    })
    canDisconnect: boolean;

    @ApiPropertyOptional({ enum: ['last_sign_in_method'] })
    disconnectBlockedReason?: string;

    @ApiPropertyOptional({ description: 'Where the person manages apps at the provider (FR-48).' })
    manageUrl?: string;
}

/** `GET /logout-url`. */
export class EverIdLogoutUrlResponseDto {
    @ApiProperty({ description: "The provider's sign-out address." })
    url: string;

    @ApiProperty({ description: 'The `state` the provider echoes back on return (FR-36).' })
    state: string;
}

/** `GET /client-config` — no secrets (FR-39). */
export class EverIdClientConfigResponseDto {
    @ApiProperty()
    issuer: string;

    @ApiProperty({
        description: 'The public local clients allowed to exchange a token for a session.',
        isArray: true,
        example: [{ kind: 'cli', clientId: 'example-cli-client' }],
    })
    localClients: Array<{ kind: 'cli' | 'node'; clientId: string }>;

    @ApiProperty({ type: [String] })
    scopes: string[];
}

/** `GET /admin/health` (spec §6.7). */
export class EverIdHealthResponseDto {
    @ApiProperty({ nullable: true, type: String })
    discoveryRefreshedAt: string | null;

    @ApiProperty({ nullable: true, type: String })
    jwksRefreshedAt: string | null;

    @ApiProperty({ nullable: true, type: String })
    lastLogoutNoticeAt: string | null;
}

/** One public local client allowed to exchange a token for a session (FR-2, FR-39). */
export class EverIdLocalClientDto {
    @ApiProperty({ enum: ['cli', 'node'] })
    @IsIn(['cli', 'node'])
    kind: 'cli' | 'node';

    @ApiProperty({ maxLength: 255 })
    @IsString()
    @IsNotEmpty()
    @MaxLength(255)
    clientId: string;
}

/** The name the Connected identities card shows for an app that read with a delegated permission (FR-48). */
export class EverIdDelegatedClientNameDto {
    @ApiProperty({ maxLength: 255 })
    @IsString()
    @IsNotEmpty()
    @MaxLength(255)
    clientId: string;

    @ApiProperty({ maxLength: 60 })
    @IsString()
    @IsNotEmpty()
    @MaxLength(60)
    displayName: string;
}

/**
 * `PATCH /admin/settings` — the administrator-managed, non-secret settings. The
 * issuer, the client and its secret are operator configuration (environment)
 * and cannot be written here.
 */
export class EverIdAdminSettingsDto {
    @ApiPropertyOptional({ type: [EverIdLocalClientDto], maxItems: 5 })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(5)
    @ValidateNested({ each: true })
    @Type(() => EverIdLocalClientDto)
    localClients?: EverIdLocalClientDto[];

    @ApiPropertyOptional({ type: [EverIdDelegatedClientNameDto], maxItems: 10 })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(10)
    @ValidateNested({ each: true })
    @Type(() => EverIdDelegatedClientNameDto)
    delegatedClientNames?: EverIdDelegatedClientNameDto[];

    @ApiPropertyOptional({ description: 'The Manage in Ever ID link target (https).' })
    @IsOptional()
    @IsString()
    @MaxLength(2048)
    @Matches(/^https:\/\/\S+$/, { message: 'accountManagementUrl must be an https address' })
    accountManagementUrl?: string;

    @ApiPropertyOptional({ maxLength: 40 })
    @IsOptional()
    @IsString()
    @IsNotEmpty()
    @MaxLength(40)
    displayName?: string;
}
