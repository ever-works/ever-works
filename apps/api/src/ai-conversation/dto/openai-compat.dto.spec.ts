import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
    OpenAiChatCompletionRequestDto,
    OpenAiFunctionDto,
    OpenAiMessageDto,
    OpenAiToolDefinitionDto,
} from './openai-compat.dto';

const constraintsFor = (
    errs: { property: string; constraints?: Record<string, string> }[],
    property: string,
) => errs.find((e) => e.property === property)?.constraints ?? {};

describe('ai-conversation OpenAI compat DTOs validation', () => {
    describe('OpenAiFunctionDto', () => {
        it('accepts a name-only payload', async () => {
            const dto = plainToInstance(OpenAiFunctionDto, { name: 'lookup' });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('accepts a fully populated function declaration', async () => {
            const dto = plainToInstance(OpenAiFunctionDto, {
                name: 'lookup',
                description: 'Look up a value',
                parameters: { type: 'object', properties: { q: { type: 'string' } } },
                strict: true,
            });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects missing name via @IsString', async () => {
            const dto = plainToInstance(OpenAiFunctionDto, {});
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'name').isString).toBeDefined();
        });

        it('rejects non-string description via @IsString', async () => {
            const dto = plainToInstance(OpenAiFunctionDto, {
                name: 'x',
                description: 42 as unknown as string,
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'description').isString).toBeDefined();
        });

        it('accepts arbitrary parameters object via @Allow', async () => {
            const dto = plainToInstance(OpenAiFunctionDto, {
                name: 'x',
                parameters: { anything: 'goes', nested: { foo: 1 } },
            });
            expect(await validate(dto)).toHaveLength(0);
        });
    });

    describe('OpenAiToolDefinitionDto', () => {
        it('accepts a fully valid tool definition', async () => {
            const dto = plainToInstance(OpenAiToolDefinitionDto, {
                type: 'function',
                function: { name: 'search' },
            });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects non-string type via @IsString', async () => {
            const dto = plainToInstance(OpenAiToolDefinitionDto, {
                type: 1 as unknown as 'function',
                function: { name: 'x' },
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'type').isString).toBeDefined();
        });

        it('propagates inner @IsString failures from the function child', async () => {
            const dto = plainToInstance(OpenAiToolDefinitionDto, {
                type: 'function',
                function: { description: 'no name' },
            });
            const errs = await validate(dto);
            const fnErr = errs.find((e) => e.property === 'function');
            expect(fnErr).toBeDefined();
            expect(fnErr?.children?.[0]?.property).toBe('name');
        });
    });

    describe('OpenAiMessageDto', () => {
        it('accepts a content-string user message', async () => {
            const dto = plainToInstance(OpenAiMessageDto, {
                role: 'user',
                content: 'Hello',
            });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('accepts a null content (assistant tool-call message)', async () => {
            const dto = plainToInstance(OpenAiMessageDto, {
                role: 'assistant',
                content: null,
                tool_calls: [
                    {
                        id: 'tc-1',
                        type: 'function',
                        function: { name: 'search', arguments: '{"q":"x"}' },
                    },
                ],
            });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('accepts a tool result message with tool_call_id', async () => {
            const dto = plainToInstance(OpenAiMessageDto, {
                role: 'tool',
                content: '{"result":"ok"}',
                tool_call_id: 'tc-1',
            });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects missing role via @IsString', async () => {
            const dto = plainToInstance(OpenAiMessageDto, { content: 'hi' });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'role').isString).toBeDefined();
        });

        it('rejects non-string optional name via @IsString', async () => {
            const dto = plainToInstance(OpenAiMessageDto, {
                role: 'user',
                content: 'hi',
                name: 42 as unknown as string,
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'name').isString).toBeDefined();
        });

        it('rejects non-string tool_call_id via @IsString', async () => {
            const dto = plainToInstance(OpenAiMessageDto, {
                role: 'tool',
                content: '{}',
                tool_call_id: 1 as unknown as string,
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'tool_call_id').isString).toBeDefined();
        });
    });

    describe('OpenAiChatCompletionRequestDto', () => {
        const valid = {
            messages: [{ role: 'user', content: 'hi' }],
        };

        it('accepts a minimal valid request', async () => {
            const dto = plainToInstance(OpenAiChatCompletionRequestDto, valid);
            expect(await validate(dto)).toHaveLength(0);
        });

        it('accepts a fully populated request', async () => {
            const dto = plainToInstance(OpenAiChatCompletionRequestDto, {
                model: 'gpt-4o',
                messages: [
                    { role: 'system', content: 'You are an assistant.' },
                    { role: 'user', content: 'Hi.' },
                ],
                temperature: 0.7,
                max_tokens: 100,
                top_p: 0.9,
                frequency_penalty: 0,
                presence_penalty: 0,
                stop: ['\nUser:'],
                stream: true,
                stream_options: { include_usage: true },
                tools: [
                    {
                        type: 'function',
                        function: { name: 'search' },
                    },
                ],
                tool_choice: 'auto',
                response_format: { type: 'json_object' },
                user: 'user-1',
            });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects missing messages via @IsArray', async () => {
            const dto = plainToInstance(OpenAiChatCompletionRequestDto, {});
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'messages').isArray).toBeDefined();
        });

        it('rejects non-array messages via @IsArray', async () => {
            const dto = plainToInstance(OpenAiChatCompletionRequestDto, {
                messages: 'not-an-array' as unknown as OpenAiMessageDto[],
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'messages').isArray).toBeDefined();
        });

        it('propagates inner message validation failures', async () => {
            const dto = plainToInstance(OpenAiChatCompletionRequestDto, {
                messages: [{ content: 'no role' }],
            });
            const errs = await validate(dto);
            const msgsErr = errs.find((e) => e.property === 'messages');
            expect(msgsErr).toBeDefined();
            expect(msgsErr?.children?.[0]?.children?.[0]?.property).toBe('role');
        });

        it('rejects non-numeric temperature via @IsNumber', async () => {
            const dto = plainToInstance(OpenAiChatCompletionRequestDto, {
                ...valid,
                temperature: 'high' as unknown as number,
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'temperature').isNumber).toBeDefined();
        });

        it('rejects non-numeric max_tokens via @IsNumber', async () => {
            const dto = plainToInstance(OpenAiChatCompletionRequestDto, {
                ...valid,
                max_tokens: '1000' as unknown as number,
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'max_tokens').isNumber).toBeDefined();
        });

        it('rejects non-boolean stream via @IsBoolean', async () => {
            const dto = plainToInstance(OpenAiChatCompletionRequestDto, {
                ...valid,
                stream: 'yes' as unknown as boolean,
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'stream').isBoolean).toBeDefined();
        });

        it('rejects non-array stop via @IsArray', async () => {
            const dto = plainToInstance(OpenAiChatCompletionRequestDto, {
                ...valid,
                stop: 'STOP' as unknown as string[],
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'stop').isArray).toBeDefined();
        });

        it('accepts arbitrary tool_choice payload via @Allow (string or object)', async () => {
            const dto = plainToInstance(OpenAiChatCompletionRequestDto, {
                ...valid,
                tool_choice: { type: 'function', function: { name: 'search' } },
            });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('accepts arbitrary response_format payload via @Allow', async () => {
            const dto = plainToInstance(OpenAiChatCompletionRequestDto, {
                ...valid,
                response_format: { type: 'text' },
            });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects non-string user via @IsString', async () => {
            const dto = plainToInstance(OpenAiChatCompletionRequestDto, {
                ...valid,
                user: 42 as unknown as string,
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'user').isString).toBeDefined();
        });

        it('rejects non-string model via @IsString', async () => {
            const dto = plainToInstance(OpenAiChatCompletionRequestDto, {
                ...valid,
                model: 42 as unknown as string,
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'model').isString).toBeDefined();
        });
    });
});
