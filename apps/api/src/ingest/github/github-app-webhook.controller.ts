import { Controller, Headers, Post, Req, UnauthorizedException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../auth/decorators/public.decorator';
import { GitHubWebhookDispatcherService } from './github-webhook-dispatcher.service';

/**
 * `POST /api/github-app/webhooks` — the platform GitHub App webhook URL,
 * kept alive as a THIN FORWARDER onto the consolidated receiver.
 *
 * This route is baked into the GitHub App's settings on github.com and
 * into every existing installation, so it cannot move; but it is no
 * longer a second receiver. It used to own its own signature check
 * (app-level `GITHUB_APP_WEBHOOK_SECRET`) and fan out to
 * `GitHubAppSyncService` alone — which is exactly why installing the App
 * never turned the PR-review loop on. It now hands the delivery to
 * `GitHubWebhookDispatcherService`, the same code the canonical
 * `POST /api/ingest/github/events` route runs, so an App installation
 * drives installation sync AND the ingest spine AND the AI review with
 * no second webhook to configure.
 *
 * The class moved here from `integrations/github-app/` so that the
 * receiver files all sit together and the module graph stays acyclic
 * (`IngestModule` → `GitHubAppModule`, never back).
 *
 * FAILURE CONTRACT (unchanged): this route has always 500'd when the App
 * sync leg threw, and GitHub's redelivery is load-bearing for
 * installation sync, so a sync-leg error is rethrown. The ingest/review
 * leg is NEW on this route, so its failures are logged, never thrown.
 * Response shape is unchanged: `{ ok: true }` with the framework's
 * default 201, as before.
 *
 * The canonical route answers an UNATTRIBUTABLE delivery with a 200
 * no-op (so GitHub stops retrying something that can never be routed);
 * this route keeps answering it 401, because on this URL "no credential
 * verified it" is precisely the case that has always been a 401 here.
 * Same receiver, same checks — each route keeps the status codes its
 * callers were built against.
 */
@ApiTags('github-app')
@Controller('api/github-app')
export class GitHubAppWebhookController {
    constructor(private readonly dispatcher: GitHubWebhookDispatcherService) {}

    @Public()
    @Post('webhooks')
    @ApiOperation({
        summary:
            'GitHub App webhook receiver (legacy route) — forwards to the consolidated GitHub receiver: installation sync, event ingest and AI PR review.',
    })
    async handleWebhook(
        @Req() req: { body: unknown; rawBody?: string },
        @Headers('x-hub-signature-256') signature: string | undefined,
        @Headers('x-github-event') eventName: string | undefined,
    ) {
        const result = await this.dispatcher.dispatch({
            rawBody: req.rawBody,
            signature,
            eventName,
            body: req.body,
        });

        if (result.ignored) {
            throw new UnauthorizedException('Invalid GitHub webhook signature');
        }

        if (result.errors.sync) {
            throw result.errors.sync;
        }

        return { ok: true };
    }
}
