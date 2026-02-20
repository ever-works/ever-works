import { Controller, Post, Body, Res, HttpCode } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { AiConversationService, ChatRequestDto } from './ai-conversation.service';
import { CurrentUser } from '../auth/decorators/user.decorator';
import { AuthenticatedUser } from '../auth/types/jwt.types';

@ApiTags('AI Conversations')
@ApiBearerAuth('JWT-auth')
@Controller('api/ai-conversations')
export class AiConversationController {
    constructor(private readonly aiConversationService: AiConversationService) {}

    @Post('chat/stream')
    @HttpCode(200)
    async chatStream(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: ChatRequestDto,
        @Res() res: Response,
    ): Promise<void> {
        res.setHeader('Content-Type', 'application/x-ndjson');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('X-Accel-Buffering', 'no');

        const stream = this.aiConversationService.streamChat(body, {
            userId: auth.userId,
            directoryId: body.directoryId,
            providerOverride: body.providerOverride,
        });

        for await (const chunk of stream) {
            res.write(JSON.stringify(chunk) + '\n');
        }

        res.end();
    }
}
