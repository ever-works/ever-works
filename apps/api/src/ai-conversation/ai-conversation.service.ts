import { Injectable, Logger } from '@nestjs/common';
import { AiFacadeService, type FacadeOptions } from '@packages/agent/facades';
import type { ChatMessage, ChatCompletionChunk } from '@ever-works/plugin';

export interface ChatRequestDto {
    messages: ChatMessage[];
    model?: string;
    temperature?: number;
}

export interface StreamChunk {
    content?: string;
    done?: boolean;
    error?: string;
}

@Injectable()
export class AiConversationService {
    private readonly logger = new Logger(AiConversationService.name);

    constructor(private readonly aiFacade: AiFacadeService) {}

    async *streamChat(
        dto: ChatRequestDto,
        facadeOptions?: FacadeOptions,
    ): AsyncGenerator<StreamChunk> {
        try {
            const stream = this.aiFacade.createStreamingChatCompletion(
                {
                    messages: dto.messages,
                    model: dto.model,
                    temperature: dto.temperature ?? 0.7,
                    stream: true,
                },
                facadeOptions,
            );

            for await (const chunk of stream) {
                const delta = chunk.choices[0]?.delta;
                if (delta?.content && typeof delta.content === 'string') {
                    yield { content: delta.content };
                }

                if (chunk.choices[0]?.finishReason === 'stop') {
                    yield { done: true };
                    return;
                }
            }

            yield { done: true };
        } catch (error) {
            this.logger.error('Stream chat error', error);
            yield {
                error: error instanceof Error ? error.message : 'Chat stream failed',
                done: true,
            };
        }
    }
}
