import {
    IsString,
    IsOptional,
    IsNumber,
    IsBoolean,
    IsArray,
    IsObject,
    Min,
    Max,
    MinLength,
    MaxLength,
    ValidateNested,
    IsEnum,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ConversationOptionsDto {
    @ApiPropertyOptional({
        description: 'Role context for the AI',
        example: 'assistant',
        maxLength: 100,
    })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    role?: string;

    @ApiPropertyOptional({
        description: 'Temperature for response randomness (0-2)',
        example: 0.7,
        minimum: 0,
        maximum: 2,
    })
    @IsOptional()
    @IsNumber()
    @Min(0)
    @Max(2)
    temperature?: number;

    @ApiPropertyOptional({
        description: 'Maximum tokens in response',
        example: 1000,
        minimum: 1,
        maximum: 32000,
    })
    @IsOptional()
    @IsNumber()
    @Min(1)
    @Max(32000)
    maxTokens?: number;

    @ApiPropertyOptional({ description: 'Custom system prompt', maxLength: 2000 })
    @IsOptional()
    @IsString()
    @MaxLength(2000)
    systemPrompt?: string;

    @ApiPropertyOptional({
        description: 'Additional context for the conversation',
        maxLength: 1000,
    })
    @IsOptional()
    @IsString()
    @MaxLength(1000)
    context?: string;

    @ApiPropertyOptional({ description: 'List of rules for the AI to follow', type: [String] })
    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    @MaxLength(200, { each: true })
    rules?: string[];

    @ApiPropertyOptional({ description: 'Whether to use the default system prompt', default: true })
    @IsOptional()
    @IsBoolean()
    useDefaultSystemPrompt?: boolean;

    @ApiPropertyOptional({
        description: 'Maximum number of messages to include in context',
        example: 20,
        minimum: 1,
        maximum: 100,
    })
    @IsOptional()
    @IsNumber()
    @Min(1)
    @Max(100)
    messageLimit?: number;

    @ApiPropertyOptional({ description: 'Additional metadata' })
    @IsOptional()
    @IsObject()
    metadata?: Record<string, any>;
}

export class SendMessageDto {
    @ApiProperty({
        description: 'Message to send to the AI',
        example: 'Hello, can you help me with...',
        maxLength: 10000,
    })
    @IsString()
    @MinLength(1)
    @MaxLength(10000)
    message: string;

    @ApiPropertyOptional({ description: 'Conversation options', type: ConversationOptionsDto })
    @IsOptional()
    @ValidateNested()
    @Type(() => ConversationOptionsDto)
    options?: ConversationOptionsDto;
}

export class SendMessageWithLimitDto extends SendMessageDto {
    @ApiPropertyOptional({
        description: 'Override message limit for this request',
        example: 10,
        minimum: 1,
        maximum: 50,
    })
    @IsOptional()
    @IsNumber()
    @Min(1)
    @Max(50)
    messageLimit?: number;
}

export enum ExpertiseType {
    CLOUD_ARCHITECTURE = 'Cloud Architecture',
    DEVOPS = 'DevOps',
    BACKEND = 'Backend Development',
    FRONTEND = 'Frontend Development',
    DATABASE = 'Database Design',
    SECURITY = 'Security',
    MACHINE_LEARNING = 'Machine Learning',
    MOBILE = 'Mobile Development',
    DATA_ENGINEERING = 'Data Engineering',
    BLOCKCHAIN = 'Blockchain',
}

export class ChatAsExpertDto {
    @ApiProperty({
        description: 'Message to send to the expert',
        example: 'How do I optimize this query?',
        maxLength: 10000,
    })
    @IsString()
    @MinLength(1)
    @MaxLength(10000)
    message: string;

    @ApiProperty({
        description: 'Area of expertise',
        enum: ExpertiseType,
        example: ExpertiseType.BACKEND,
    })
    @IsEnum(ExpertiseType)
    expertise: ExpertiseType;

    @ApiPropertyOptional({
        description: 'Temperature for response randomness',
        example: 0.7,
        minimum: 0,
        maximum: 2,
    })
    @IsOptional()
    @IsNumber()
    @Min(0)
    @Max(2)
    temperature?: number;

    @ApiPropertyOptional({
        description: 'Message limit for context',
        example: 10,
        minimum: 1,
        maximum: 50,
    })
    @IsOptional()
    @IsNumber()
    @Min(1)
    @Max(50)
    messageLimit?: number;
}
