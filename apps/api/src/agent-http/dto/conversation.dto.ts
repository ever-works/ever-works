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
