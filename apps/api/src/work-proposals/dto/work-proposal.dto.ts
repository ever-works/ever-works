import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import type { WorkProposalStatus } from '@ever-works/agent/user-research';

const STATUSES: WorkProposalStatus[] = ['pending', 'dismissed', 'accepted'];

export class ListWorkProposalsQueryDto {
	@ApiProperty({
		required: false,
		isArray: true,
		enum: STATUSES,
		description: 'Filter by status (default: pending only)'
	})
	@IsOptional()
	@IsArray()
	@IsIn(STATUSES, { each: true })
	statuses?: WorkProposalStatus[];
}

export class AcceptWorkProposalDto {
	@ApiProperty({ description: 'The work that was created from this proposal.' })
	@IsUUID()
	workId: string;
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
		items: { type: 'object', properties: { name: { type: 'string' }, slug: { type: 'string' } } }
	})
	suggestedCategories: Array<{ name: string; slug: string }>;

	@ApiProperty({
		type: 'array',
		items: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string' } } }
	})
	suggestedFields: Array<{ name: string; type: string }>;

	@ApiProperty({
		type: 'array',
		items: {
			type: 'object',
			properties: { pluginId: { type: 'string' }, reason: { type: 'string' } }
		}
	})
	recommendedPlugins: Array<{ pluginId: string; reason: string }>;

	@ApiProperty()
	reasoning: string;

	@ApiProperty({ enum: ['auto-signup', 'user-refresh', 'discover', 'scheduled'] })
	source: string;

	@ApiProperty({ enum: STATUSES })
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
