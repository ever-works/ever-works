import { Controller, Headers, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../auth/decorators/public.decorator';
import { GitHubWebhookDispatcherService } from './github-webhook-dispatcher.service';

/**
 * GitHub events receiver — CANONICAL route.
 *
 * Public route (GitHub calls it), secured by request signing instead of
 * platform auth. Everything below the HTTP layer — signature
 * verification, install-binding resolution, and the fan-out to every
 * consumer — lives in `GitHubWebhookDispatcherService`, which is the ONE
 * receiver shared with the legacy `POST /api/github-app/webhooks` route
 * (`github-app-webhook.controller.ts` next door). Before the
 * consolidation these were two independent receivers with two signature
 * checks and one consumer each, which is why installing the GitHub App
 * did not turn the PR-review loop on.
 *
 * Body handling mirrors `SlackEventsController`: the raw payload
 * (captured by the bodyParser `verify` hook in main.ts) feeds signature
 * verification; the parsed body is consumed as-is, bypassing the global
 * whitelist ValidationPipe (GitHub's event schema is theirs, not ours).
 *
 * FAILURE CONTRACT (unchanged): this route has always been able to fail
 * on the ingest/review leg, so a review-leg error is rethrown — GitHub's
 * retry is how a transient ingest failure recovers, and the spine's
 * `(source, sourceEventId)` dedupe makes the retry free. The App-sync leg
 * is NEW on this route, so its failures are logged, never thrown: adding
 * a consumer must not invent a new way for an existing route to 500.
 */
@ApiTags('ingest')
@Controller('api/ingest')
export class GitHubEventsController {
    constructor(private readonly dispatcher: GitHubWebhookDispatcherService) {}

    @Public()
    @Post('github/events')
    @ApiOperation({
        summary:
            'GitHub webhook receiver — signature-verified; PR opened/synchronize + @ever-works mention ingest, AI review trigger, issue + Dependabot intake, GitHub App installation sync.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 300, ttl: 60_000 } })
    async receiveEvents(
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

        // The issue / Dependabot intake leg is a sibling of the review
        // leg on this route (same verified delivery, same owner), so its
        // failure surfaces the same way — GitHub redelivers, and the
        // spine's dedupe makes the retry free.
        if (result.errors.review) {
            throw result.errors.review;
        }
        if (result.errors.intake) {
            throw result.errors.intake;
        }

        return result.ignored ? { ok: true, ignored: result.ignored } : { ok: true };
    }
}
