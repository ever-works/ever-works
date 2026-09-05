import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * `POST /api/ingest/sentry/bindings` — claim a Sentry installation for
 * the authenticated user (see `SentryInstallBindingService`). The uuid
 * is the one Sentry shows on the integration's installation page; it is
 * the ONLY input, and it never chooses the target account — the caller's
 * session does.
 */
export class ClaimSentryBindingDto {
    @ApiProperty({
        description: 'The Sentry integration installation uuid (from the installation page).',
        example: '5f6e4d3c-2b1a-4c9d-8e7f-0a1b2c3d4e5f',
    })
    @IsUUID()
    installationUuid!: string;

    @ApiPropertyOptional({
        description:
            'Human-readable label (e.g. the Sentry organization slug) for the settings UI.',
        maxLength: 200,
    })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    label?: string;
}
