jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/facades', () => ({}));

import { OpenAiCompatService } from './openai-compat.service';
import type { WorkRepository } from '@ever-works/agent/database';
import type { AiFacadeService } from '@ever-works/agent/facades';

type ResMock = {
    write: jest.Mock;
    end: jest.Mock;
    headersSent: boolean;
    destroyed: boolean;
    writableEnded: boolean;
    status: jest.Mock;
    setHeader: jest.Mock;
    destroy: jest.Mock;
};

const makeRes = (overrides: Partial<ResMock> = {}): ResMock => ({
    write: jest.fn(),
    end: jest.fn(),
    setHeader: jest.fn(),
    status: jest.fn(),
    destroy: jest.fn(),
    headersSent: false,
    destroyed: false,
    writableEnded: false,
    ...overrides,
});

async function* asyncIter<T>(items: T[]) {
    for (const item of items) yield item;
}

async function* asyncThrow<T>(items: T[], err: Error) {
    for (const item of items) yield item;
    throw err;
}

describe('OpenAiCompatService', () => {
    let service: OpenAiCompatService;
    let aiFacade: jest.Mocked<
        Pick<AiFacadeService, 'createChatCompletion' | 'createStreamingChatCompletion'>
    >;
    let workRepository: jest.Mocked<Pick<WorkRepository, 'findByUser'>>;

    beforeEach(() => {
        aiFacade = {
            createChatCompletion: jest.fn(),
            createStreamingChatCompletion: jest.fn(),
        } as any;
        workRepository = {
            findByUser: jest.fn().mockResolvedValue([]),
        } as any;
        service = new OpenAiCompatService(
            aiFacade as unknown as AiFacadeService,
            workRepository as unknown as WorkRepository,
        );
    });

    describe('handleCompletion (non-streaming)', () => {
        it('maps DTO and returns OpenAI-shaped response', async () => {
            aiFacade.createChatCompletion.mockResolvedValue({
                id: 'cmp-1',
                created: 1700000000000,
                model: 'gpt-4o',
                choices: [
                    {
                        index: 0,
                        message: { role: 'assistant', content: 'Hello' },
                        finishReason: 'stop',
                    },
                ],
                usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
            } as any);

            const result = await service.handleCompletion(
                {
                    model: 'gpt-4o',
                    messages: [{ role: 'user', content: 'hi' }],
                    temperature: 0.5,
                    max_tokens: 50,
                } as any,
                { userId: 'user-1', workId: 'w-1' },
            );

            expect(result.id).toBe('cmp-1');
            expect(result.object).toBe('chat.completion');
            expect(result.created).toBe(1700000000); // ms → s
            expect(result.choices[0].message.content).toBe('Hello');
            expect(result.choices[0].finish_reason).toBe('stop');
            expect(result.usage).toEqual({
                prompt_tokens: 1,
                completion_tokens: 2,
                total_tokens: 3,
            });

            const [opts, facadeOpts] = aiFacade.createChatCompletion.mock.calls[0];
            expect(opts.model).toBe('gpt-4o');
            expect(opts.temperature).toBe(0.5);
            expect(opts.maxTokens).toBe(50);
            expect(facadeOpts).toEqual({ userId: 'user-1', workId: 'w-1' });
        });

        it('treats model="auto" as undefined model in internal options', async () => {
            aiFacade.createChatCompletion.mockResolvedValue({
                id: 'x',
                created: 0,
                model: 'm',
                choices: [],
            } as any);

            await service.handleCompletion(
                { model: 'auto', messages: [] } as any,
                { userId: 'u' },
            );

            const [opts] = aiFacade.createChatCompletion.mock.calls[0];
            expect(opts.model).toBeUndefined();
        });

        it('omits usage from response when upstream provides none', async () => {
            aiFacade.createChatCompletion.mockResolvedValue({
                id: 'x',
                created: 0,
                model: 'm',
                choices: [
                    { index: 0, message: { role: 'assistant', content: 'a' }, finishReason: 'stop' },
                ],
            } as any);

            const result = await service.handleCompletion(
                { messages: [] } as any,
                { userId: 'u' },
            );

            expect(result.usage).toBeUndefined();
        });

        it('maps non-string content to null', async () => {
            aiFacade.createChatCompletion.mockResolvedValue({
                id: 'x',
                created: 0,
                model: 'm',
                choices: [
                    { index: 0, message: { role: 'assistant', content: null }, finishReason: 'stop' },
                ],
            } as any);

            const result = await service.handleCompletion(
                { messages: [] } as any,
                { userId: 'u' },
            );

            expect(result.choices[0].message.content).toBeNull();
        });

        it('maps tool_calls in assistant response', async () => {
            aiFacade.createChatCompletion.mockResolvedValue({
                id: 'x',
                created: 0,
                model: 'm',
                choices: [
                    {
                        index: 0,
                        message: {
                            role: 'assistant',
                            content: '',
                            toolCalls: [
                                {
                                    id: 'call-1',
                                    type: 'function',
                                    function: { name: 'lookup', arguments: '{"q":"x"}' },
                                },
                            ],
                        },
                        finishReason: 'tool_calls',
                    },
                ],
            } as any);

            const result = await service.handleCompletion(
                { messages: [] } as any,
                { userId: 'u' },
            );

            expect(result.choices[0].message.tool_calls).toEqual([
                {
                    id: 'call-1',
                    type: 'function',
                    function: { name: 'lookup', arguments: '{"q":"x"}' },
                },
            ]);
        });

        it('resolves workId from workRepository when missing in facadeOptions', async () => {
            workRepository.findByUser.mockResolvedValue([{ id: 'auto-w' }] as any);
            aiFacade.createChatCompletion.mockResolvedValue({
                id: 'x',
                created: 0,
                model: 'm',
                choices: [],
            } as any);

            await service.handleCompletion(
                { messages: [] } as any,
                { userId: 'user-1' },
            );

            const [, facadeOpts] = aiFacade.createChatCompletion.mock.calls[0];
            expect(facadeOpts).toEqual({ userId: 'user-1', workId: 'auto-w' });
        });

        it('skips workId resolution when works array is empty', async () => {
            workRepository.findByUser.mockResolvedValue([] as any);
            aiFacade.createChatCompletion.mockResolvedValue({
                id: 'x',
                created: 0,
                model: 'm',
                choices: [],
            } as any);

            await service.handleCompletion(
                { messages: [] } as any,
                { userId: 'user-1' },
            );

            const [, facadeOpts] = aiFacade.createChatCompletion.mock.calls[0];
            expect(facadeOpts).toEqual({ userId: 'user-1' });
        });
    });

    describe('mapping: messages', () => {
        it('maps tool result message with tool_call_id', async () => {
            aiFacade.createChatCompletion.mockResolvedValue({
                id: 'x',
                created: 0,
                model: 'm',
                choices: [],
            } as any);

            await service.handleCompletion(
                {
                    messages: [
                        { role: 'tool', content: 'ok', tool_call_id: 'tc-1' },
                    ],
                } as any,
                { userId: 'u', workId: 'w' },
            );

            const [opts] = aiFacade.createChatCompletion.mock.calls[0];
            expect(opts.messages[0]).toEqual({
                role: 'tool',
                content: 'ok',
                toolCallId: 'tc-1',
            });
        });

        it('maps assistant tool_calls with toolCalls field', async () => {
            aiFacade.createChatCompletion.mockResolvedValue({
                id: 'x',
                created: 0,
                model: 'm',
                choices: [],
            } as any);

            await service.handleCompletion(
                {
                    messages: [
                        {
                            role: 'assistant',
                            content: '',
                            tool_calls: [
                                {
                                    id: 'c1',
                                    type: 'function',
                                    function: { name: 'fn', arguments: '{}' },
                                },
                            ],
                        },
                    ],
                } as any,
                { userId: 'u', workId: 'w' },
            );

            const [opts] = aiFacade.createChatCompletion.mock.calls[0];
            expect(opts.messages[0].toolCalls).toEqual([
                {
                    id: 'c1',
                    type: 'function',
                    function: { name: 'fn', arguments: '{}' },
                },
            ]);
        });

        it('passes through user message with optional name', async () => {
            aiFacade.createChatCompletion.mockResolvedValue({
                id: 'x',
                created: 0,
                model: 'm',
                choices: [],
            } as any);

            await service.handleCompletion(
                {
                    messages: [{ role: 'user', content: 'hi', name: 'Alice' }],
                } as any,
                { userId: 'u', workId: 'w' },
            );

            const [opts] = aiFacade.createChatCompletion.mock.calls[0];
            expect(opts.messages[0]).toEqual({ role: 'user', content: 'hi', name: 'Alice' });
        });

        it('coerces null content to empty string', async () => {
            aiFacade.createChatCompletion.mockResolvedValue({
                id: 'x',
                created: 0,
                model: 'm',
                choices: [],
            } as any);

            await service.handleCompletion(
                { messages: [{ role: 'user', content: null }] } as any,
                { userId: 'u', workId: 'w' },
            );

            const [opts] = aiFacade.createChatCompletion.mock.calls[0];
            expect(opts.messages[0].content).toBe('');
        });

        it('maps tools array', async () => {
            aiFacade.createChatCompletion.mockResolvedValue({
                id: 'x',
                created: 0,
                model: 'm',
                choices: [],
            } as any);

            await service.handleCompletion(
                {
                    messages: [],
                    tools: [
                        {
                            type: 'function',
                            function: {
                                name: 'lookup',
                                description: 'lookup info',
                                parameters: { type: 'object' },
                            },
                        },
                    ],
                } as any,
                { userId: 'u', workId: 'w' },
            );

            const [opts] = aiFacade.createChatCompletion.mock.calls[0];
            expect(opts.tools).toEqual([
                {
                    type: 'function',
                    function: {
                        name: 'lookup',
                        description: 'lookup info',
                        parameters: { type: 'object' },
                    },
                },
            ]);
        });
    });

    describe('handleStreamingCompletion', () => {
        it('streams chunks as SSE and ends with [DONE]', async () => {
            aiFacade.createStreamingChatCompletion.mockReturnValue(
                asyncIter([
                    {
                        id: 'c-1',
                        created: 1700000000000,
                        model: 'gpt-4o',
                        choices: [
                            { index: 0, delta: { role: 'assistant' }, finishReason: null },
                        ],
                    },
                    {
                        id: 'c-1',
                        created: 1700000000000,
                        model: 'gpt-4o',
                        choices: [
                            { index: 0, delta: { content: 'Hello' }, finishReason: null },
                        ],
                    },
                    {
                        id: 'c-1',
                        created: 1700000000000,
                        model: 'gpt-4o',
                        choices: [{ index: 0, delta: {}, finishReason: 'stop' }],
                    },
                ]) as any,
            );
            const res = makeRes();

            await service.handleStreamingCompletion(
                { stream: true, messages: [] } as any,
                { userId: 'u', workId: 'w' },
                res as any,
            );

            const writes = res.write.mock.calls.map((c) => c[0] as string);
            expect(writes.length).toBe(4); // 3 chunks + [DONE]
            expect(writes[0]).toMatch(/^data: /);
            expect(writes[3]).toBe('data: [DONE]\n\n');
            // Final chunk has finish_reason: stop
            const lastChunkLine = JSON.parse(writes[2].replace(/^data: /, '').trim());
            expect(lastChunkLine.choices[0].finish_reason).toBe('stop');
            expect(res.end).toHaveBeenCalled();
        });

        it('emits role only on first delta and content thereafter', async () => {
            aiFacade.createStreamingChatCompletion.mockReturnValue(
                asyncIter([
                    {
                        id: 'c-1',
                        created: 0,
                        model: 'm',
                        choices: [
                            { index: 0, delta: { role: 'assistant' }, finishReason: null },
                        ],
                    },
                    {
                        id: 'c-1',
                        created: 0,
                        model: 'm',
                        choices: [{ index: 0, delta: { content: 'hi' }, finishReason: null }],
                    },
                ]) as any,
            );
            const res = makeRes();

            await service.handleStreamingCompletion(
                { stream: true, messages: [] } as any,
                { userId: 'u', workId: 'w' },
                res as any,
            );

            const chunks = res.write.mock.calls
                .map((c) => c[0] as string)
                .filter((s) => s.startsWith('data: ') && !s.includes('[DONE]'))
                .map((s) => JSON.parse(s.replace(/^data: /, '').trim()));
            expect(chunks[0].choices[0].delta.role).toBe('assistant');
            expect(chunks[0].choices[0].delta.content).toBeUndefined();
            expect(chunks[1].choices[0].delta.role).toBeUndefined();
            expect(chunks[1].choices[0].delta.content).toBe('hi');
        });

        it('maps tool_call deltas — first chunk has id/type/name; continuations omit them', async () => {
            aiFacade.createStreamingChatCompletion.mockReturnValue(
                asyncIter([
                    {
                        id: 'c-1',
                        created: 0,
                        model: 'm',
                        choices: [
                            {
                                index: 0,
                                delta: {
                                    toolCalls: [
                                        {
                                            index: 0,
                                            id: 'tc-1',
                                            type: 'function',
                                            function: { name: 'fn', arguments: '{"' },
                                        },
                                    ],
                                },
                                finishReason: null,
                            },
                        ],
                    },
                    {
                        id: 'c-1',
                        created: 0,
                        model: 'm',
                        choices: [
                            {
                                index: 0,
                                delta: {
                                    toolCalls: [
                                        {
                                            index: 0,
                                            function: { arguments: 'a":1}' },
                                        },
                                    ],
                                },
                                finishReason: 'tool_calls',
                            },
                        ],
                    },
                ]) as any,
            );
            const res = makeRes();

            await service.handleStreamingCompletion(
                { stream: true, messages: [] } as any,
                { userId: 'u', workId: 'w' },
                res as any,
            );

            const chunks = res.write.mock.calls
                .map((c) => c[0] as string)
                .filter((s) => !s.includes('[DONE]'))
                .map((s) => JSON.parse(s.replace(/^data: /, '').trim()));
            expect(chunks[0].choices[0].delta.tool_calls[0]).toEqual({
                index: 0,
                id: 'tc-1',
                type: 'function',
                function: { name: 'fn', arguments: '{"' },
            });
            expect(chunks[1].choices[0].delta.tool_calls[0]).toEqual({
                index: 0,
                function: { arguments: 'a":1}' },
            });
        });

        it('writes 502 JSON error response when stream throws and headers not sent', async () => {
            aiFacade.createStreamingChatCompletion.mockReturnValue(
                asyncThrow([], new Error('upstream invalid sk-abcdefghijklmnop')) as any,
            );
            const res = makeRes();

            await service.handleStreamingCompletion(
                { stream: true, messages: [] } as any,
                { userId: 'u', workId: 'w' },
                res as any,
            );

            expect(res.status).toHaveBeenCalledWith(502);
            expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
            const endArg = res.end.mock.calls[0][0] as string;
            expect(endArg).toBeDefined();
            const body = JSON.parse(endArg);
            expect(body.error.type).toBe('provider_error');
            expect(body.error.code).toBe('ai_provider_error');
            // Sensitive sk- token is redacted
            expect(body.error.message).not.toContain('sk-abcdefghijklmnop');
            expect(body.error.message).toContain('[redacted]');
        });

        it('destroys the stream when error happens after headers are sent', async () => {
            aiFacade.createStreamingChatCompletion.mockReturnValue(
                asyncThrow(
                    [
                        {
                            id: 'c-1',
                            created: 0,
                            model: 'm',
                            choices: [{ index: 0, delta: { content: 'partial' }, finishReason: null }],
                        },
                    ],
                    new Error('mid-stream fail'),
                ) as any,
            );
            const res = makeRes({ headersSent: true });

            await service.handleStreamingCompletion(
                { stream: true, messages: [] } as any,
                { userId: 'u', workId: 'w' },
                res as any,
            );

            expect(res.destroy).toHaveBeenCalled();
            expect(res.status).not.toHaveBeenCalled();
        });

        it('does not call res.end again when writableEnded is already true', async () => {
            aiFacade.createStreamingChatCompletion.mockReturnValue(asyncIter([]) as any);
            const res = makeRes({ writableEnded: true });

            await service.handleStreamingCompletion(
                { stream: true, messages: [] } as any,
                { userId: 'u', workId: 'w' },
                res as any,
            );

            // Only the [DONE] write happened, end() should NOT fire in finally
            // because writableEnded is true.
            expect(res.end).not.toHaveBeenCalled();
        });

        it('handles non-Error thrown values with generic message', async () => {
            aiFacade.createStreamingChatCompletion.mockReturnValue(
                (async function* () {
                    throw 'not-an-error';
                })() as any,
            );
            const res = makeRes();

            await service.handleStreamingCompletion(
                { stream: true, messages: [] } as any,
                { userId: 'u', workId: 'w' },
                res as any,
            );

            const endArg = res.end.mock.calls[0][0] as string;
            const body = JSON.parse(endArg);
            expect(body.error.message).toBe('Something went wrong. Please try again.');
        });

        it('truncates very long error messages to ~300 chars', async () => {
            const longMsg = 'x'.repeat(500);
            aiFacade.createStreamingChatCompletion.mockReturnValue(
                asyncThrow([], new Error(longMsg)) as any,
            );
            const res = makeRes();

            await service.handleStreamingCompletion(
                { stream: true, messages: [] } as any,
                { userId: 'u', workId: 'w' },
                res as any,
            );

            const endArg = res.end.mock.calls[0][0] as string;
            const body = JSON.parse(endArg);
            expect(body.error.message.endsWith('...')).toBe(true);
            expect(body.error.message.length).toBeLessThanOrEqual(303);
        });

        it('redacts Bearer tokens from error messages', async () => {
            aiFacade.createStreamingChatCompletion.mockReturnValue(
                asyncThrow(
                    [],
                    new Error('Auth failed: Bearer abcdef1234567890ghijk'),
                ) as any,
            );
            const res = makeRes();

            await service.handleStreamingCompletion(
                { stream: true, messages: [] } as any,
                { userId: 'u', workId: 'w' },
                res as any,
            );

            const endArg = res.end.mock.calls[0][0] as string;
            const body = JSON.parse(endArg);
            expect(body.error.message).not.toContain('abcdef1234567890ghijk');
            expect(body.error.message).toContain('[redacted]');
        });
    });
});
