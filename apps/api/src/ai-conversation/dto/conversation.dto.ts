import {
    IsString,
    IsOptional,
    IsNumber,
    IsObject,
    Min,
    MinLength,
    MaxLength,
    Max,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class StartConversationDto {
    @ApiPropertyOptional({ description: 'Additional metadata for the conversation' })
    @IsOptional()
    @IsObject()
    metadata?: Record<string, any>;

    @ApiPropertyOptional({
        description: 'Title for the conversation',
        example: 'Project Discussion',
        maxLength: 200,
    })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    title?: string;
}

export class UpdateConversationTitleDto {
    @ApiProperty({
        description: 'New title for the conversation',
        example: 'Updated Discussion',
        maxLength: 200,
    })
    @IsString()
    @MinLength(1)
    @MaxLength(200)
    title: string;
}

export class UpdateConversationContextDto {
    @ApiProperty({ description: 'Context object to update' })
    @IsObject()
    context: Record<string, any>;
}

export class PruneMessagesDto {
    @ApiProperty({
        description: 'Number of recent messages to keep',
        example: 10,
        minimum: 1,
        maximum: 1000,
    })
    @IsNumber()
    @Min(1)
    @Max(1000)
    keepLast: number;
}

export class ConversationQueryDto {
    @ApiPropertyOptional({
        description: 'Maximum number of conversations to return',
        example: 20,
        minimum: 1,
        maximum: 100,
    })
    @IsOptional()
    @IsNumber()
    @Type(() => Number)
    @Min(1)
    @Max(100)
    limit?: number;

    @ApiPropertyOptional({ description: 'Number of conversations to skip', example: 0, minimum: 0 })
    @IsOptional()
    @IsNumber()
    @Type(() => Number)
    @Min(0)
    offset?: number;
}

export class HistoryQueryDto {
    @ApiPropertyOptional({
        description: 'Maximum number of messages to return',
        example: 50,
        minimum: 1,
        maximum: 200,
    })
    @IsOptional()
    @IsNumber()
    @Type(() => Number)
    @Min(1)
    @Max(200)
    limit?: number;
}

export class SessionIdParamDto {
    @ApiProperty({ description: 'Conversation session ID' })
    @IsString()
    @MinLength(1)
    sessionId: string;
}
