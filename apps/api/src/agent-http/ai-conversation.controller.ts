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
} from '@nestjs/common';
import { AiConversationService } from '@packages/agent/ai';
import { CurrentUser, JwtAuthGuard } from '../auth';
import { Observable } from 'rxjs';
import { AuthenticatedUser } from '../auth/types/jwt.types';
import { StartConversationDto } from './dto/conversation.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { Response } from 'express';

const LIMIT_MESSAGE = 20;

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
