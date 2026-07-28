import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    DIGEST_PERIODS,
    DIGEST_SCOPES,
    type DigestPeriod,
    type DigestScope,
} from '@ever-works/agent/digest';

/**
 * Body for `PUT /api/digest/settings`.
 *
 * One endpoint, two persistence targets, chosen by `scope`:
 *
 *   - `personal`     → `users.digestFrequency` (the pre-existing column).
 *   - `organization` → `organizations.digest_settings` (the new opt-in),
 *                      for the caller's ACTIVE organization only.
 *
 * They are independent records: saving one never reads or rewrites the
 * other, so enabling an org digest cannot silently change what a member
 * already receives personally.
 */
export class UpdateDigestSettingsDto {
    @ApiProperty({
        description: 'Which settings record to write.',
        enum: DIGEST_SCOPES as unknown as string[],
    })
    @IsIn(DIGEST_SCOPES as unknown as string[])
    scope: DigestScope;

    @ApiPropertyOptional({ description: 'Master switch for this scope.' })
    @IsOptional()
    @IsBoolean()
    enabled?: boolean;

    @ApiPropertyOptional({
        description: 'Delivery cadence.',
        enum: DIGEST_PERIODS as unknown as string[],
    })
    @IsOptional()
    @IsIn(DIGEST_PERIODS as unknown as string[])
    cadence?: DigestPeriod;

    @ApiPropertyOptional({
        description:
            'Include the AI narrative summary (organization scope only; the personal digest follows the install default). Ignored for `personal`.',
    })
    @IsOptional()
    @IsBoolean()
    narrative?: boolean;
}

/** Shape of `GET /api/digest/settings`. */
export interface DigestSettingsResponse {
    personal: {
        enabled: boolean;
        cadence: DigestPeriod;
    };
    /**
     * `null` when the session has no active organization (personal
     * surface, or a user not yet upgraded to a Tenant) — the UI renders
     * the org section as unavailable rather than inventing one.
     */
    organization: {
        organizationId: string;
        displayName: string;
        enabled: boolean;
        cadence: DigestPeriod;
        narrative: boolean;
        lastRunAt: string | null;
    } | null;
    /**
     * Whether an AI provider is configured for this install. Drives the
     * UI's "the narrative will be skipped" hint so the degradation is
     * visible BEFORE the first digest arrives, not only inside it.
     */
    aiConfigured: boolean;
}
