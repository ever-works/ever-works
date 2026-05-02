import {
    BadRequestException,
    Controller,
    Headers,
    Post,
    Req,
    UnauthorizedException,
} from '@nestjs/common';
import { Public } from '@src/auth/decorators/public.decorator';
import { GitHubAppService } from './github-app.service';
import { GitHubAppSyncService } from './github-app-sync.service';

@Controller('api/github-app')
export class GitHubAppWebhookController {
    constructor(
        private readonly gitHubAppService: GitHubAppService,
        private readonly gitHubAppSyncService: GitHubAppSyncService,
    ) {}

    @Public()
    @Post('webhooks')
    async handleWebhook(
        @Req() req: { body: any; rawBody?: string },
        @Headers('x-hub-signature-256') signature: string | undefined,
        @Headers('x-github-event') eventName: string | undefined,
    ) {
        if (!eventName) {
            throw new BadRequestException('Missing GitHub event header');
        }

        if (!req.rawBody) {
            throw new BadRequestException('Missing raw webhook payload');
        }

        const isValid = this.gitHubAppService.verifyWebhookSignature(req.rawBody, signature);
        if (!isValid) {
            throw new UnauthorizedException('Invalid GitHub webhook signature');
        }

        await this.gitHubAppSyncService.handleWebhook(eventName, req.body);
        return { ok: true };
    }
}
