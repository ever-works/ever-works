import {
    Controller,
    Post,
    Body,
    Param,
    Sse,
    UseGuards,
    BadRequestException,
    Res,
    Header,
    Get,
    Query,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { AiConversationService } from '@packages/agent/ai';
import { CurrentUser, JwtAuthGuard } from '../auth';
import { Observable } from 'rxjs';
import { AuthenticatedUser } from '../auth/types/jwt.types';
import { StartConversationDto } from './dto/conversation.dto';
import { SendMessageDto } from './dto/send-message.dto';
import type { Response } from 'express';

const LIMIT_MESSAGE = 20;

@ApiTags('AI Conversation')
@ApiBearerAuth('JWT-auth')
@Controller('api/ai-conversations')
@UseGuards(JwtAuthGuard)
export class AiConversationController {
    constructor(private readonly conversationService: AiConversationService) {}

    /**
     * Start a new conversation session
     */
    @Post('start')
    @ApiOperation({
        summary: 'Start conversation',
        description: 'Start a new AI conversation session',
    })
    @ApiResponse({ status: 201, description: 'Conversation started successfully' })
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
     * List recent conversations for the authenticated user
     */
    @Get('recent')
    @ApiOperation({
        summary: 'List recent conversations',
        description: 'Get a list of recent conversations for the authenticated user',
    })
    @ApiResponse({ status: 200, description: 'List of recent conversations' })
    async listRecentConversations(
        @CurrentUser() auth: AuthenticatedUser,
        @Query('limit') limit?: string,
    ) {
        const parsedLimit = limit ? parseInt(limit, 10) : undefined;

        if (parsedLimit !== undefined && (Number.isNaN(parsedLimit) || parsedLimit <= 0)) {
            throw new BadRequestException(
                'The "limit" query parameter must be a positive integer.',
            );
        }

        return this.conversationService.listUserConversations(auth.userId, parsedLimit);
    }

    /**
     * Get conversation history
     */
    @Get(':sessionId/history')
    @ApiOperation({
        summary: 'Get conversation history',
        description: 'Retrieve the message history for a conversation',
    })
    @ApiParam({ name: 'sessionId', description: 'The conversation session ID' })
    @ApiResponse({ status: 200, description: 'Conversation history' })
    async getConversationHistory(
        @Param('sessionId') sessionId: string,
        @CurrentUser() auth: AuthenticatedUser,
    ) {
        return this.conversationService.getConversationHistory(
            sessionId,
            auth.userId,
            LIMIT_MESSAGE * 2,
        );
    }

    /**
     * Send a message and get a response (non-streaming)
     */
    @Post(':sessionId/send')
    @ApiOperation({
        summary: 'Send message',
        description: 'Send a message to the conversation and get a response',
    })
    @ApiParam({ name: 'sessionId', description: 'The conversation session ID' })
    @ApiResponse({ status: 200, description: 'AI response to the message' })
    @ApiResponse({ status: 400, description: 'Invalid message or session' })
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
    @Sse(':sessionId/sse')
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
     * Ask a question without starting a conversation (or history)
     */
    @Post('ask')
    @ApiOperation({
        summary: 'Ask a question',
        description: 'Ask a one-off question without starting a conversation session',
    })
    @ApiResponse({ status: 200, description: 'AI response' })
    @ApiResponse({ status: 400, description: 'Invalid question' })
    async askQuestion(@Body() dto: SendMessageDto) {
        const result = await this.conversationService.ask(dto.message, dto.options);

        if (!result.success) {
            throw new BadRequestException(result.error);
        }

        return result;
    }

    /**
     * Stream a response to a question without starting a conversation (or history)
     */
    @Sse('ask/sse')
    async streamAsk(@Body() dto: SendMessageDto): Promise<Observable<MessageEvent>> {
        const stream = this.conversationService.streamAsk(dto.message, dto.options);

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
     * Stream a message response using fetch-compatible streaming (NDJSON)
     */
    @Post(':sessionId/stream')
    @ApiOperation({
        summary: 'Stream message response',
        description: 'Send a message and stream the AI response as NDJSON',
    })
    @ApiParam({ name: 'sessionId', description: 'The conversation session ID' })
    @ApiResponse({ status: 200, description: 'Streamed AI response' })
    @Header('Content-Type', 'application/x-ndjson')
    @Header('Cache-Control', 'no-cache')
    @Header('X-Accel-Buffering', 'no')
    async streamMessageFetch(
        @Param('sessionId') sessionId: string,
        @Body() dto: SendMessageDto,
        @CurrentUser() auth: AuthenticatedUser,
        @Res() res: Response,
    ) {
        const stream = this.conversationService.streamMessage(sessionId, dto.message, {
            ...dto.options,
            messageLimit: LIMIT_MESSAGE,
            userId: auth.userId,
        });

        // Set response headers for streaming
        res.setHeader('Content-Type', 'application/x-ndjson');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('X-Accel-Buffering', 'no');

        try {
            for await (const chunk of stream) {
                // Write each chunk as newline-delimited JSON
                res.write(JSON.stringify(chunk) + '\n');
            }
            res.end();
        } catch (error) {
            // Send error as final chunk
            res.write(JSON.stringify({ error: error.message, done: true }) + '\n');
            res.end();
        }
    }

    /**
     * Stream a response without conversation using fetch-compatible streaming (NDJSON)
     */
    @Post('ask/stream')
    @Header('Content-Type', 'application/x-ndjson')
    @Header('Cache-Control', 'no-cache')
    @Header('X-Accel-Buffering', 'no')
    async streamAskFetch(@Body() dto: SendMessageDto, @Res() res: Response) {
        const stream = this.conversationService.streamAsk(dto.message, dto.options);

        // Set response headers for streaming
        res.setHeader('Content-Type', 'application/x-ndjson');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('X-Accel-Buffering', 'no');

        try {
            for await (const chunk of stream) {
                // Write each chunk as newline-delimited JSON
                res.write(JSON.stringify(chunk) + '\n');
            }
            res.end();
        } catch (error) {
            // Send error as final chunk
            res.write(JSON.stringify({ error: error.message, done: true }) + '\n');
            res.end();
        }
    }
}
