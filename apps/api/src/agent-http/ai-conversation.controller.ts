import {
    Controller,
    Post,
    Get,
    Delete,
    Body,
    Param,
    Query,
    Sse,
    UseGuards,
    Req,
    BadRequestException,
} from '@nestjs/common';
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

    /**
     * Get conversation history
     */
    @Get(':sessionId/history')
    async getHistory(
        @Param('sessionId') sessionId: string,
        @CurrentUser() auth: AuthenticatedUser,
        @Query('limit') limit?: string,
    ) {
        const history = await this.conversationService.getConversationHistory(
            sessionId,
            auth.userId,
            limit ? parseInt(limit) : undefined,
        );

        return {
            success: true,
            ...history,
            messages: history.messages.map((msg) => ({
                role: (msg as any).getType ? (msg as any).getType() : 'unknown',
                content: msg.content,
            })),
        };
    }

    /**
     * List all conversations for the authenticated user
     */
    @Get()
    async listConversations(
        @CurrentUser() auth: AuthenticatedUser,
        @Query('limit') limit?: string,
    ) {
        const conversations = await this.conversationService.listUserConversations(
            auth.userId,
            limit ? parseInt(limit) : 10,
        );

        return {
            success: true,
            conversations,
            total: conversations.length,
        };
    }

    /**
     * Get conversation statistics
     */
    @Get(':sessionId/stats')
    async getConversationStats(
        @Param('sessionId') sessionId: string,
        @CurrentUser() auth: AuthenticatedUser,
    ) {
        const stats = await this.conversationService.getConversationStats(sessionId);

        return {
            success: true,
            sessionId,
            ...stats,
        };
    }

    /**
     * Update conversation title
     */
    @Post(':sessionId/title')
    async updateTitle(
        @Param('sessionId') sessionId: string,
        @Body('title') title: string,
        @CurrentUser() auth: AuthenticatedUser,
    ) {
        if (!title) {
            throw new BadRequestException('Title is required');
        }

        await this.conversationService.setConversationTitle(sessionId, title);

        return {
            success: true,
            sessionId,
            message: 'Title updated successfully',
        };
    }

    /**
     * Update conversation context/metadata
     */
    @Post(':sessionId/context')
    async updateContext(
        @Param('sessionId') sessionId: string,
        @Body('context') context: Record<string, any>,
        @CurrentUser() auth: AuthenticatedUser,
    ) {
        if (!context) {
            throw new BadRequestException('Context is required');
        }

        await this.conversationService.updateConversationContext(sessionId, context);

        return {
            success: true,
            sessionId,
            message: 'Context updated successfully',
        };
    }

    /**
     * Prune old messages from a conversation
     */
    @Post(':sessionId/prune')
    async pruneMessages(
        @Param('sessionId') sessionId: string,
        @Body('keepLast') keepLast: number,
        @CurrentUser() auth: AuthenticatedUser,
    ) {
        if (!keepLast || keepLast < 1) {
            throw new BadRequestException('keepLast must be a positive number');
        }

        await this.conversationService.pruneConversationMessages(sessionId, keepLast);

        return {
            success: true,
            sessionId,
            message: `Conversation pruned to last ${keepLast} messages`,
        };
    }

    /**
     * Clear conversation history (keep session)
     */
    @Delete(':sessionId/clear')
    async clearConversation(
        @Param('sessionId') sessionId: string,
        @CurrentUser() auth: AuthenticatedUser,
    ) {
        await this.conversationService.clearConversation(sessionId);

        return {
            success: true,
            sessionId,
            message: 'Conversation history cleared',
        };
    }

    /**
     * Delete entire conversation
     */
    @Delete(':sessionId')
    async deleteConversation(
        @Param('sessionId') sessionId: string,
        @CurrentUser() auth: AuthenticatedUser,
    ) {
        const deleted = await this.conversationService.deleteConversation(sessionId);

        return {
            success: deleted,
            sessionId,
            message: deleted ? 'Conversation deleted' : 'Conversation not found',
        };
    }
}
