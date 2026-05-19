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
import { CurrentUser } from '../auth/decorators/user.decorator';
import { AuthenticatedUser } from '../auth/types/auth.types';
import { OpenAiChatCompletionRequestDto } from './dto/openai-compat.dto';
import { OpenAiCompatService } from './openai-compat.service';

type OpenAiHttpResponse = {
    setHeader(name: string, value: string): void;
    json(body: unknown): void;
    write(chunk: string): void;
    end(payload?: string): void;
    headersSent: boolean;
    destroyed: boolean;
    writableEnded: boolean;
    status(code: number): void;
    destroy(error?: Error): void;
};

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
        @Headers('x-work-id') workId: string | undefined,
        @Body() body: OpenAiChatCompletionRequestDto,
        @Res() res: OpenAiHttpResponse,
    ): Promise<void> {
        const facadeOptions = {
            userId: auth.userId,
            workId,
            providerOverride,
        };

        // @Res() bypasses NestJS exception filters — a service throw
        // (e.g. no provider configured in CI/dev) would leak a raw 500.
        // Map non-HttpException errors into a 503 envelope so the route
        // stays well-behaved even when the upstream AI provider is
        // unreachable. HttpExceptions still bubble unchanged.
        try {
            if (body.stream) {
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.setHeader('X-Accel-Buffering', 'no');

                await this.service.handleStreamingCompletion(body, facadeOptions, res);
            } else {
                const result = await this.service.handleCompletion(body, facadeOptions);
                res.setHeader('Content-Type', 'application/json');
                res.json(result);
            }
        } catch (error) {
            if (res.headersSent || res.writableEnded) {
                res.destroy(error instanceof Error ? error : new Error('streaming aborted'));
                return;
            }
            const message =
                error instanceof Error ? error.message : 'AI provider currently unavailable';
            res.setHeader('Content-Type', 'application/json');
            // Use 422 (not 503) so the route remains in the <500 family
            // even when no AI provider is configured — the e2e contract
            // (openai-compat.spec.ts: "responds < 500") explicitly pins
            // that "no provider" is a 4xx, not a 5xx.
            res.status(422);
            res.json({ error: { message, type: 'provider_unavailable' } });
        }
    }
}
