import { Injectable, Logger } from '@nestjs/common';
import { AiFacadeService, type FacadeOptions } from '@ever-works/agent/facades';
import { ConversationRepository } from '@ever-works/agent/database';
import { WorkRepository } from '@ever-works/agent/database';

@Injectable()
export class ConversationTitleService {
    private readonly logger = new Logger(ConversationTitleService.name);

    constructor(
        private readonly conversationRepo: ConversationRepository,
        private readonly aiFacade: AiFacadeService,
        private readonly workRepository: WorkRepository,
    ) {}

    /**
     * Generate an AI title for a conversation if it has enough messages
     * and hasn't been titled by AI yet.
     */
    async maybeGenerateTitle(conversationId: string, userId: string): Promise<void> {
        const conversation = await this.conversationRepo.findById(conversationId, userId);
        if (!conversation) return;

        const messageCount = conversation.messages?.length ?? 0;
        if (messageCount < 4 || conversation.metadata?.aiTitle) return;

        try {
            const facadeOptions = await this.resolveFacadeOptions(userId);

            const summary = conversation.messages
                .filter((m) => m.role === 'user' || m.role === 'assistant')
                .slice(-4)
                .map((m) => {
                    const text = this.extractMessageText(m);
                    return `${m.role}: ${text.substring(0, 200)}`;
                })
                .join('\n');

            const response = await this.aiFacade.createChatCompletion(
                {
                    messages: [
                        {
                            role: 'system',
                            content:
                                'Generate a short title (max 50 chars) for this conversation. Return ONLY the title, no quotes, no explanation.',
                        },
                        { role: 'user', content: summary },
                    ],
                    temperature: 0.3,
                    maxTokens: 30,
                },
                facadeOptions,
            );

            const title = response.choices[0]?.message?.content;
            if (title && typeof title === 'string' && title.trim().length > 0) {
                await this.conversationRepo.updateTitle(
                    conversationId,
                    userId,
                    title.trim().substring(0, 100),
                    { aiTitle: true },
                );
            }
        } catch (err) {
            this.logger.debug('AI title generation failed', err);
        }
    }

    /**
     * Extract readable text from a message, falling back to parts if content is empty.
     */
    private extractMessageText(message: { content?: string | null; parts?: unknown }): string {
        if (message.content?.trim()) return message.content;

        // Fall back to parts — extract text parts
        if (Array.isArray(message.parts)) {
            return (message.parts as Array<{ type: string; text?: string }>)
                .filter((p) => p.type === 'text' && p.text)
                .map((p) => p.text!)
                .join(' ');
        }

        return '';
    }

    private async resolveFacadeOptions(userId: string): Promise<FacadeOptions> {
        try {
            const works = await this.workRepository.findByUser(userId);
            return {
                userId,
                workId: works[0]?.id,
            };
        } catch {
            return { userId };
        }
    }
}
