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

export class ConversationOptionsDto {
    @IsOptional()
    @IsString()
    @MaxLength(100)
    role?: string;

    @IsOptional()
    @IsNumber()
    @Min(0)
    @Max(2)
    temperature?: number;

    @IsOptional()
    @IsNumber()
    @Min(1)
    @Max(32000)
    maxTokens?: number;

    @IsOptional()
    @IsString()
    @MaxLength(2000)
    systemPrompt?: string;

    @IsOptional()
    @IsString()
    @MaxLength(1000)
    context?: string;

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    @MaxLength(200, { each: true })
    rules?: string[];

    @IsOptional()
    @IsBoolean()
    useDefaultSystemPrompt?: boolean;

    @IsOptional()
    @IsNumber()
    @Min(1)
    @Max(100)
    messageLimit?: number;

    @IsOptional()
    @IsObject()
    metadata?: Record<string, any>;
}

export class SendMessageDto {
    @IsString()
    @MinLength(1)
    @MaxLength(10000)
    message: string;

    @IsOptional()
    @ValidateNested()
    @Type(() => ConversationOptionsDto)
    options?: ConversationOptionsDto;
}

export class SendMessageWithLimitDto extends SendMessageDto {
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
    @IsString()
    @MinLength(1)
    @MaxLength(10000)
    message: string;

    @IsEnum(ExpertiseType)
    expertise: ExpertiseType;

    @IsOptional()
    @IsNumber()
    @Min(0)
    @Max(2)
    temperature?: number;

    @IsOptional()
    @IsNumber()
    @Min(1)
    @Max(50)
    messageLimit?: number;
}
