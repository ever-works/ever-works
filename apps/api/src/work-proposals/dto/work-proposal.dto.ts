import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { WorkProposalSource, WorkProposalStatus } from '@ever-works/agent/user-research';

export class ListWorkProposalsQueryDto {
    @ApiProperty({
        required: false,
        isArray: true,
        enum: WorkProposalStatus,
        description: 'Filter by status (default: pending only)',
    })
    @IsOptional()
    @IsArray()
    @IsEnum(WorkProposalStatus, { each: true })
    statuses?: WorkProposalStatus[];
}

export class AcceptWorkProposalDto {
    @ApiProperty({ description: 'The work that was created from this proposal.' })
    @IsUUID()
    workId: string;
}

export class UpdateWorkProposalPreferencesDto {
    @ApiProperty({ description: 'When true, the user opts out of background research.' })
    optOut: boolean;
}

export class WorkProposalResponseDto {
    @ApiProperty()
    @IsUUID()
    id: string;

    @ApiProperty()
    @IsString()
    title: string;

    @ApiProperty()
    @IsString()
    description: string;

    @ApiProperty()
    @IsString()
    slugSuggestion: string;

    @ApiProperty({
        type: 'array',
        items: {
            type: 'object',
            properties: { name: { type: 'string' }, slug: { type: 'string' } },
        },
    })
    suggestedCategories: Array<{ name: string; slug: string }>;

    @ApiProperty({
        type: 'array',
        items: {
            type: 'object',
            properties: { name: { type: 'string' }, type: { type: 'string' } },
        },
    })
    suggestedFields: Array<{ name: string; type: string }>;

    @ApiProperty({
        type: 'array',
        items: {
            type: 'object',
            properties: { pluginId: { type: 'string' }, reason: { type: 'string' } },
        },
    })
    recommendedPlugins: Array<{ pluginId: string; reason: string }>;

    @ApiProperty()
    reasoning: string;

    @ApiProperty({ enum: WorkProposalSource })
    source: WorkProposalSource;

    @ApiProperty({ enum: WorkProposalStatus })
    status: WorkProposalStatus;

    @ApiProperty({ required: false, nullable: true })
    acceptedWorkId?: string | null;

    @ApiProperty()
    generatedAt: Date;
}

export class RefreshResponseDto {
    @ApiProperty({ enum: ['queued', 'rate-limited'] })
    status: 'queued' | 'rate-limited';

    @ApiProperty({ required: false })
    error?: string;
}
