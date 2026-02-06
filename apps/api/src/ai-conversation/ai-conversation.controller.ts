import { Controller, Post, Body, Req, Res, HttpCode } from '@nestjs/common';
import { Request, Response } from 'express';
import { AiConversationService, ChatRequestDto } from './ai-conversation.service';

@Controller('ai-conversations')
export class AiConversationController {
    constructor(private readonly aiConversationService: AiConversationService) {}

    @Post('chat/stream')
    @HttpCode(200)
    async chatStream(
        @Body() body: ChatRequestDto,
        @Req() req: Request,
        @Res() res: Response,
    ): Promise<void> {
        res.setHeader('Content-Type', 'application/x-ndjson');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('X-Accel-Buffering', 'no');

        const userId = (req as any).user?.id;

        const stream = this.aiConversationService.streamChat(body, {
            userId,
        });

        for await (const chunk of stream) {
            res.write(JSON.stringify(chunk) + '\n');
        }

        res.end();
    }
}
