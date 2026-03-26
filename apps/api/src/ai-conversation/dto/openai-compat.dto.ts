import {
    IsArray,
    IsBoolean,
    IsNumber,
    IsOptional,
    IsString,
    Allow,
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
    @Allow()
    parameters?: Record<string, unknown>;

    @IsOptional()
    @Allow()
    strict?: boolean;
}

export class OpenAiToolDefinitionDto {
    @IsString()
    type: 'function';

    @ValidateNested()
    @Type(() => OpenAiFunctionDto)
    function: OpenAiFunctionDto;
}

export class OpenAiMessageDto {
    @IsString()
    role: string;

    @Allow()
    content: string | null;

    @IsOptional()
    @IsString()
    name?: string;

    @IsOptional()
    @Allow()
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
    @IsOptional()
    @IsString()
    model?: string;

    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => OpenAiMessageDto)
    messages: OpenAiMessageDto[];

    @IsOptional()
    @IsNumber()
    temperature?: number;

    @IsOptional()
    @IsNumber()
    max_tokens?: number;

    @IsOptional()
    @IsNumber()
    top_p?: number;

    @IsOptional()
    @IsNumber()
    frequency_penalty?: number;

    @IsOptional()
    @IsNumber()
    presence_penalty?: number;

    @IsOptional()
    @IsArray()
    stop?: string[];

    @IsOptional()
    @IsBoolean()
    stream?: boolean;

    @IsOptional()
    @Allow()
    stream_options?: Record<string, unknown>;

    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => OpenAiToolDefinitionDto)
    tools?: OpenAiToolDefinitionDto[];

    @IsOptional()
    @Allow()
    tool_choice?: 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } };

    @IsOptional()
    @Allow()
    response_format?: { type: 'text' | 'json_object' };

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
