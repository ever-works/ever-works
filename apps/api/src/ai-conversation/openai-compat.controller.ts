import {
    Controller,
    Post,
    Body,
    Res,
    Headers,
    HttpCode,
    UsePipes,
    ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { Response } from 'express';
import { CurrentUser } from '../auth/decorators/user.decorator';
import { AuthenticatedUser } from '../auth/types/jwt.types';
import { OpenAiChatCompletionRequestDto } from './dto/openai-compat.dto';
import { OpenAiCompatService } from './openai-compat.service';

@ApiTags('AI - OpenAI Compatible')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1')
export class OpenAiCompatController {
    constructor(private readonly service: OpenAiCompatService) {}

    /**
     * OpenAI-compatible chat completions endpoint.
     *
     * Uses a permissive validation pipe (whitelist without forbidNonWhitelisted)
     * because AI SDK clients send many optional/extra fields (stream_options,
     * logprobs, etc.) that we don't need but shouldn't reject.
     */
    @Post('chat/completions')
    @HttpCode(200)
    @ApiOperation({ summary: 'Create a chat completion (OpenAI-compatible)' })
    @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
    async chatCompletions(
        @CurrentUser() auth: AuthenticatedUser,
        @Headers('x-provider-override') providerOverride: string | undefined,
        @Headers('x-directory-id') directoryId: string | undefined,
        @Headers('x-conversation-id') conversationId: string | undefined,
        @Body() body: OpenAiChatCompletionRequestDto,
        @Res() res: Response,
    ): Promise<void> {
        const facadeOptions = {
            userId: auth.userId,
            directoryId,
            providerOverride,
        };

        const persistenceContext = {
            userId: auth.userId,
            conversationId,
            providerId: providerOverride,
        };

        if (body.stream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');

            await this.service.handleStreamingCompletion(
                body,
                facadeOptions,
                res,
                persistenceContext,
            );
        } else {
            const result = await this.service.handleCompletion(body, facadeOptions);
            res.setHeader('Content-Type', 'application/json');
            res.json(result);
        }
    }
}
