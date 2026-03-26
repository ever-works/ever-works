import {
    IsArray,
    IsBoolean,
    IsNumber,
    IsOptional,
    IsString,
    ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

// ────────────────────────────────────────────────────────────────
// Request types (OpenAI wire format)
// ────────────────────────────────────────────────────────────────

export class OpenAiFunctionDto {
    @IsString()
    name: string;

    @IsOptional()
    @IsString()
    description?: string;

    @IsOptional()
    parameters?: Record<string, unknown>;
}

export class OpenAiToolDefinitionDto {
    @IsString()
    type: 'function';

    @ValidateNested()
    @Type(() => OpenAiFunctionDto)
    function: OpenAiFunctionDto;
}

export class OpenAiMessageDto {
    @ApiProperty({ description: 'Message role' })
    @IsString()
    role: string;

    @ApiProperty({ description: 'Message content' })
    content: string | null;

    @IsOptional()
    @IsString()
    name?: string;

    @IsOptional()
    tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
    }>;

    @IsOptional()
    @IsString()
    tool_call_id?: string;
}

export class OpenAiChatCompletionRequestDto {
    @ApiPropertyOptional({ description: 'Model identifier' })
    @IsOptional()
    @IsString()
    model?: string;

    @ApiProperty({ description: 'Array of messages', type: [OpenAiMessageDto] })
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => OpenAiMessageDto)
    messages: OpenAiMessageDto[];

    @ApiPropertyOptional({ description: 'Sampling temperature (0-2)' })
    @IsOptional()
    @IsNumber()
    temperature?: number;

    @ApiPropertyOptional({ description: 'Maximum tokens to generate' })
    @IsOptional()
    @IsNumber()
    max_tokens?: number;

    @ApiPropertyOptional({ description: 'Nucleus sampling parameter' })
    @IsOptional()
    @IsNumber()
    top_p?: number;

    @ApiPropertyOptional({ description: 'Frequency penalty (-2 to 2)' })
    @IsOptional()
    @IsNumber()
    frequency_penalty?: number;

    @ApiPropertyOptional({ description: 'Presence penalty (-2 to 2)' })
    @IsOptional()
    @IsNumber()
    presence_penalty?: number;

    @ApiPropertyOptional({ description: 'Stop sequences' })
    @IsOptional()
    @IsArray()
    stop?: string[];

    @ApiPropertyOptional({ description: 'Enable streaming' })
    @IsOptional()
    @IsBoolean()
    stream?: boolean;

    @ApiPropertyOptional({ description: 'Tool definitions', type: [OpenAiToolDefinitionDto] })
    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => OpenAiToolDefinitionDto)
    tools?: OpenAiToolDefinitionDto[];

    @ApiPropertyOptional({ description: 'Tool choice strategy' })
    @IsOptional()
    tool_choice?: 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } };

    @ApiPropertyOptional({ description: 'Response format' })
    @IsOptional()
    response_format?: { type: 'text' | 'json_object' };

    @ApiPropertyOptional({ description: 'User identifier for tracking' })
    @IsOptional()
    @IsString()
    user?: string;
}

// ────────────────────────────────────────────────────────────────
// Response types (OpenAI wire format)
// ────────────────────────────────────────────────────────────────

export interface OpenAiToolCallResponse {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
}

export interface OpenAiChatCompletionResponse {
    id: string;
    object: 'chat.completion';
    created: number;
    model: string;
    choices: Array<{
        index: number;
        message: {
            role: 'assistant';
            content: string | null;
            tool_calls?: OpenAiToolCallResponse[];
        };
        finish_reason: string | null;
    }>;
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}

export interface OpenAiChatCompletionChunkResponse {
    id: string;
    object: 'chat.completion.chunk';
    created: number;
    model: string;
    choices: Array<{
        index: number;
        delta: {
            role?: 'assistant';
            content?: string | null;
            tool_calls?: Array<{
                index: number;
                id?: string;
                type?: 'function';
                function?: { name?: string; arguments?: string };
            }>;
        };
        finish_reason: string | null;
    }>;
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    } | null;
}
