import { Controller, Post, Body, Param, Sse, UseGuards, BadRequestException } from '@nestjs/common';
import { AiConversationService } from '@packages/agent/ai';
import { CurrentUser, JwtAuthGuard } from '../auth';
import { Observable } from 'rxjs';
import { AuthenticatedUser } from '../auth/types/jwt.types';
import { StartConversationDto } from './dto/conversation.dto';
import { SendMessageDto } from './dto/send-message.dto';

const LIMIT_MESSAGE = 50;

@Controller('api/ai-conversations')
@UseGuards(JwtAuthGuard)
export class AiConversationController {
    constructor(private readonly conversationService: AiConversationService) {}

    /**
     * Start a new conversation session
     */
    @Post('start')
    async startConversation(
        @Body() dto: StartConversationDto,
        @CurrentUser() auth: AuthenticatedUser,
    ) {
        const sessionId = await this.conversationService.startConversation(
            auth.userId,
            dto.metadata,
        );

        if (dto.title) {
            await this.conversationService.setConversationTitle(sessionId, dto.title);
        }

        return {
            success: true,
            sessionId,
            message: 'Conversation started successfully',
        };
    }

    /**
     * Send a message and get a response (non-streaming)
     */
    @Post(':sessionId/send')
    async sendMessage(
        @Param('sessionId') sessionId: string,
        @Body() dto: SendMessageDto,
        @CurrentUser() auth: AuthenticatedUser,
    ) {
        const result = await this.conversationService.sendMessage(sessionId, dto.message, {
            ...dto.options,
            messageLimit: LIMIT_MESSAGE,
            userId: auth.userId,
        });

        if (!result.success) {
            throw new BadRequestException(result.error);
        }

        return result;
    }

    /**
     * Stream a message response using Server-Sent Events (SSE)
     */
    @Sse(':sessionId/stream')
    async streamMessage(
        @Param('sessionId') sessionId: string,
        @Body() dto: SendMessageDto,
        @CurrentUser() auth: AuthenticatedUser,
    ): Promise<Observable<MessageEvent>> {
        const stream = this.conversationService.streamMessage(sessionId, dto.message, {
            ...dto.options,
            messageLimit: LIMIT_MESSAGE,
            userId: auth.userId,
        });

        // Convert async generator to Observable for SSE
        return new Observable((subscriber) => {
            (async () => {
                try {
                    for await (const chunk of stream) {
                        subscriber.next({
                            data: JSON.stringify(chunk),
                        } as MessageEvent);
                    }

                    subscriber.complete();
                } catch (error) {
                    subscriber.error(error);
                }
            })();
        });
    }
}
