import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsIn,
    IsNotEmpty,
    IsOptional,
    IsString,
    IsUUID,
    Matches,
    MaxLength,
} from 'class-validator';
import type { TeamMemberRole, TeamMemberType } from '@ever-works/agent/teams';

/**
 * Teams & Prebuilt Companies — request DTOs
 * (`docs/specs/features/teams-and-companies/spec.md` §3).
 */

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export class CreateTeamDto {
    @ApiProperty({ description: 'Team display name', maxLength: 200 })
    @IsString()
    @IsNotEmpty()
    @MaxLength(200)
    name: string;

    @ApiPropertyOptional({ description: 'Kebab-case slug; derived from name when omitted' })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    @Matches(SLUG_PATTERN, { message: 'slug must be kebab-case (a-z, 0-9, dashes)' })
    slug?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    @MaxLength(4000)
    description?: string;

    @ApiPropertyOptional({ description: 'Parent team id (team-in-team hierarchy)' })
    @IsOptional()
    @IsUUID()
    parentTeamId?: string;

    @ApiPropertyOptional({ description: 'Manager Agent id (descriptive, no authz)' })
    @IsOptional()
    @IsUUID()
    managerAgentId?: string;

    @ApiPropertyOptional({ description: 'Kebab-case lucide icon id' })
    @IsOptional()
    @IsString()
    @MaxLength(64)
    @Matches(SLUG_PATTERN, { message: 'avatarIcon must be a kebab-case lucide id' })
    avatarIcon?: string;
}

export class UpdateTeamDto {
    @ApiPropertyOptional({ maxLength: 200 })
    @IsOptional()
    @IsString()
    @IsNotEmpty()
    @MaxLength(200)
    name?: string;

    @ApiPropertyOptional({ nullable: true })
    @IsOptional()
    @IsString()
    @MaxLength(4000)
    description?: string;

    @ApiPropertyOptional({ description: 'New parent team id, or null to move to top level', nullable: true })
    @IsOptional()
    @IsUUID()
    parentTeamId?: string;

    @ApiPropertyOptional({ description: 'Manager Agent id, or null to clear', nullable: true })
    @IsOptional()
    @IsUUID()
    managerAgentId?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    @MaxLength(64)
    @Matches(SLUG_PATTERN, { message: 'avatarIcon must be a kebab-case lucide id' })
    avatarIcon?: string;
}

export class AddTeamMemberDto {
    @ApiProperty({ enum: ['agent', 'user'] })
    @IsIn(['agent', 'user'])
    memberType: TeamMemberType;

    @ApiProperty({ description: 'agents.id or users.id depending on memberType' })
    @IsUUID()
    memberId: string;

    @ApiPropertyOptional({ enum: ['lead', 'member'], default: 'member' })
    @IsOptional()
    @IsIn(['lead', 'member'])
    role?: TeamMemberRole;
}

export class RemoveTeamMemberQueryDto {
    @ApiProperty({ enum: ['agent', 'user'] })
    @IsIn(['agent', 'user'])
    memberType: TeamMemberType;
}
