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

export class StartConversationDto {
    @IsOptional()
    @IsObject()
    metadata?: Record<string, any>;

    @IsOptional()
    @IsString()
    @MaxLength(200)
    title?: string;
}

export class UpdateConversationTitleDto {
    @IsString()
    @MinLength(1)
    @MaxLength(200)
    title: string;
}

export class UpdateConversationContextDto {
    @IsObject()
    context: Record<string, any>;
}

export class PruneMessagesDto {
    @IsNumber()
    @Min(1)
    @Max(1000)
    keepLast: number;
}

export class ConversationQueryDto {
    @IsOptional()
    @IsNumber()
    @Type(() => Number)
    @Min(1)
    @Max(100)
    limit?: number;

    @IsOptional()
    @IsNumber()
    @Type(() => Number)
    @Min(0)
    offset?: number;
}

export class HistoryQueryDto {
    @IsOptional()
    @IsNumber()
    @Type(() => Number)
    @Min(1)
    @Max(200)
    limit?: number;
}

export class SessionIdParamDto {
    @IsString()
    @MinLength(1)
    sessionId: string;
}

// Response DTOs
export class ConversationResponseDto {
    success: boolean;

    response: string;

    error?: string;

    metadata?: {
        model?: string;
        provider?: string;
        tokensUsed?: number;
        sessionId?: string;
        messageCount?: number;
    };
}

export class StartConversationResponseDto {
    success: boolean;

    sessionId: string;

    message: string;
}

export class ConversationListItemDto {
    sessionId: string;

    title?: string;

    createdAt: Date;

    updatedAt: Date;

    messageCount: number;
}

export class ConversationListResponseDto {
    success: boolean;

    conversations: ConversationListItemDto[];

    total: number;
}

export class MessageDto {
    role: string;

    content: string;
}

export class ConversationHistoryResponseDto {
    success: boolean;

    sessionId: string;

    messages: MessageDto[];

    context: Record<string, any>;

    totalMessages: number;
}

export class ConversationStatsResponseDto {
    success: boolean;

    sessionId: string;

    messageCount: number;

    firstMessage?: Date;

    lastMessage?: Date;

    context: Record<string, any>;
}

export class OperationResponseDto {
    success: boolean;

    sessionId: string;

    message: string;
}
