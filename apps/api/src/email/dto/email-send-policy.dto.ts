import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min, ValidateNested } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
    AGENT_INBOX_MODES,
    EMAIL_SEND_CAP_MAX_CONFIGURABLE,
    type AgentInboxMode,
} from '@ever-works/contracts';

/**
 * Agent email (AW-05) — request bodies for the send-policy routes.
 *
 * Every ceiling field has three meanings, on purpose:
 *   - absent      → leave as it is
 *   - `null`      → inherit from the scope above (organization, then platform)
 *   - `0`         → explicitly no ceiling (the pre-ceiling behaviour)
 *   - 1…1,000,000 → that ceiling
 *
 * `@IsOptional()` lets `null` through untouched, which is exactly "inherit".
 */
const CAP_DESCRIPTION =
    'null = inherit from the organization / platform, 0 = no ceiling, a positive integer = that ceiling.';

export class UpdateAgentInboxDto {
    @ApiPropertyOptional({
        description:
            '`draft-review` holds everything this Agent writes until a person approves it; `auto-send` lets it send on its own, still inside every ceiling.',
        enum: AGENT_INBOX_MODES as unknown as string[],
    })
    @IsOptional()
    @IsIn(AGENT_INBOX_MODES as unknown as string[])
    mode?: AgentInboxMode;

    @ApiPropertyOptional({
        description:
            'Pin the address this Agent sends from (one of your email addresses). null = use its outbound assignment.',
        nullable: true,
    })
    @IsOptional()
    @IsUUID()
    emailAddressId?: string | null;

    @ApiPropertyOptional({
        description: `Sends per rolling 24 hours. ${CAP_DESCRIPTION}`,
        nullable: true,
    })
    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(EMAIL_SEND_CAP_MAX_CONFIGURABLE)
    dailySendCap?: number | null;

    @ApiPropertyOptional({
        description: `Sends per 60 seconds. ${CAP_DESCRIPTION}`,
        nullable: true,
    })
    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(EMAIL_SEND_CAP_MAX_CONFIGURABLE)
    burstSendCap?: number | null;

    @ApiPropertyOptional({
        description: `Distinct recipients per 5 minutes. ${CAP_DESCRIPTION}`,
        nullable: true,
    })
    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(EMAIL_SEND_CAP_MAX_CONFIGURABLE)
    recipientBurstCap?: number | null;

    @ApiPropertyOptional({
        description: `Recipients (to + cc + bcc) on one message. ${CAP_DESCRIPTION}`,
        nullable: true,
    })
    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(EMAIL_SEND_CAP_MAX_CONFIGURABLE)
    recipientsPerMessageCap?: number | null;
}

export class OrganizationEmailCapsDto {
    @ApiPropertyOptional({ nullable: true, description: CAP_DESCRIPTION })
    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(EMAIL_SEND_CAP_MAX_CONFIGURABLE)
    inboxDailySends?: number | null;

    @ApiPropertyOptional({ nullable: true, description: CAP_DESCRIPTION })
    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(EMAIL_SEND_CAP_MAX_CONFIGURABLE)
    inboxBurstSends?: number | null;

    @ApiPropertyOptional({ nullable: true, description: CAP_DESCRIPTION })
    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(EMAIL_SEND_CAP_MAX_CONFIGURABLE)
    inboxBurstRecipients?: number | null;

    @ApiPropertyOptional({ nullable: true, description: CAP_DESCRIPTION })
    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(EMAIL_SEND_CAP_MAX_CONFIGURABLE)
    recipientsPerMessage?: number | null;

    @ApiPropertyOptional({ nullable: true, description: CAP_DESCRIPTION })
    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(EMAIL_SEND_CAP_MAX_CONFIGURABLE)
    workspaceDailySends?: number | null;

    @ApiPropertyOptional({ nullable: true, description: CAP_DESCRIPTION })
    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(EMAIL_SEND_CAP_MAX_CONFIGURABLE)
    workspaceMonthlySends?: number | null;
}

export class UpdateOrganizationEmailSendPolicyDto {
    @ApiPropertyOptional({
        description:
            'Mode for Agents in this organization with no inbox settings of their own. null = platform default.',
        enum: AGENT_INBOX_MODES as unknown as string[],
        nullable: true,
    })
    @IsOptional()
    @IsIn(AGENT_INBOX_MODES as unknown as string[])
    defaultMode?: AgentInboxMode | null;

    @ApiPropertyOptional({ type: OrganizationEmailCapsDto, nullable: true })
    @IsOptional()
    @ValidateNested()
    @Type(() => OrganizationEmailCapsDto)
    caps?: OrganizationEmailCapsDto | null;
}
