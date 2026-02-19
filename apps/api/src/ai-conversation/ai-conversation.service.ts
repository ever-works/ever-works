import { Injectable, Logger } from '@nestjs/common';
import { AiFacadeService, type FacadeOptions } from '@ever-works/agent/facades';
import { DirectoryRepository } from '@ever-works/agent/database';
import type { ChatMessage, ChatCompletionChunk } from '@ever-works/plugin';

export interface ChatRequestDto {
    messages: ChatMessage[];
    model?: string;
    temperature?: number;
    directoryId?: string;
}

export interface StreamChunk {
    content?: string;
    done?: boolean;
    error?: string;
}

@Injectable()
export class AiConversationService {
    private readonly logger = new Logger(AiConversationService.name);

    constructor(
        private readonly aiFacade: AiFacadeService,
        private readonly directoryRepository: DirectoryRepository,
    ) {}

    async *streamChat(
        dto: ChatRequestDto,
        facadeOptions: FacadeOptions,
    ): AsyncGenerator<StreamChunk> {
        try {
            const resolvedOptions = await this.resolveDirectoryContext(facadeOptions);

            const stream = this.aiFacade.createStreamingChatCompletion(
                {
                    messages: dto.messages,
                    model: dto.model,
                    temperature: dto.temperature ?? 0.7,
                    stream: true,
                },
                resolvedOptions,
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

    private async resolveDirectoryContext(options: FacadeOptions): Promise<FacadeOptions> {
        if (options.directoryId) return options;

        const directories = await this.directoryRepository.findByUser(options.userId);
        if (directories.length > 0) {
            return { ...options, directoryId: directories[0].id };
        }

        return options;
    }
}
