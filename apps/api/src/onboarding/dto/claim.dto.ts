import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, MinLength } from 'class-validator';

export class ClaimAcceptDto {
    @ApiProperty({ description: 'Single-use claim token from the invitation email.' })
    @IsString()
    @IsNotEmpty()
    @MinLength(32)
    token: string;
}

export class ClaimPreviewResponseDto {
    @ApiProperty() workName: string;
    @ApiProperty() role: string;
    @ApiProperty() expiresAt: string;
    @ApiPropertyOptional({ description: 'Set when role = owner-claim.' })
    expectedProviderUsername?: string | null;
    @ApiPropertyOptional({ description: 'Upstream source URL of the work, if available.' })
    sourceUrl?: string | null;
}

export class ClaimAcceptResponseDto {
    @ApiProperty() invitationId: string;
    @ApiProperty() workId: string;
    @ApiProperty() role: string;
    @ApiProperty({
        description:
            'For owner-claim: completed | pending_recipient_acceptance | failed. For member roles: not_required.',
    })
    transferStatus: string;
    @ApiPropertyOptional({
        description:
            'For owner-claim, the path to follow on the git provider to confirm the transfer.',
    })
    providerAcceptanceUrl?: string;
}
