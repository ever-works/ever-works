import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsEmail,
    IsIn,
    IsInt,
    IsObject,
    IsOptional,
    IsString,
    Max,
    MaxLength,
    Min,
    MinLength,
} from 'class-validator';
import {
    ALL_INVITATION_ROLES,
    INVITATION_ROLE_OWNER_CLAIM,
    type InvitationRole,
} from '@ever-works/agent/entities';

export class CreateInvitationDto {
    @ApiPropertyOptional({
        description:
            'Optional recipient email. Required for member-role invitations; optional for owner-claim links the operator will hand-deliver.',
    })
    @IsOptional()
    @IsEmail()
    email?: string;

    @ApiProperty({
        description:
            'Role granted on accept. owner-claim transfers work ownership; everything else creates a WorkMember row.',
        enum: ALL_INVITATION_ROLES,
        example: 'manager',
    })
    @IsIn(ALL_INVITATION_ROLES as unknown as string[])
    role: InvitationRole;

    @ApiPropertyOptional({
        description: 'Token lifetime in days (1–90). Defaults to 30.',
        minimum: 1,
        maximum: 90,
    })
    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(90)
    expiresInDays?: number;

    @ApiPropertyOptional({
        description:
            'Per-invitation context. owner-claim REQUIRES expectedProviderUsername (the git host login that must match at accept time).',
        example: { expectedProviderUsername: 'avelino' },
    })
    @IsOptional()
    @IsObject()
    metadata?: Record<string, unknown>;

    @ApiPropertyOptional({
        description: 'Provider login the claimant must match. Used for owner-claim invitations.',
    })
    @IsOptional()
    @IsString()
    @MinLength(1)
    @MaxLength(128)
    expectedProviderUsername?: string;
}

export class InvitationResponseDto {
    @ApiProperty() id: string;
    @ApiProperty() workId: string;
    @ApiProperty({ enum: ALL_INVITATION_ROLES }) role: InvitationRole;
    @ApiProperty({ nullable: true }) email: string | null;
    @ApiProperty() status: string;
    @ApiProperty() tokenExpiresAt: string;
    @ApiProperty() createdAt: string;
    @ApiProperty() invitedById: string;
    @ApiPropertyOptional({
        description:
            'The full claim URL — returned ONCE at creation; subsequent reads do NOT include the raw token.',
    })
    claimUrl?: string;
    @ApiPropertyOptional() metadata?: Record<string, unknown> | null;
}

export const OWNER_CLAIM_ROLE = INVITATION_ROLE_OWNER_CLAIM;
