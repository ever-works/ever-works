import { Controller, Headers, Post, Req, UnauthorizedException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../auth/decorators/public.decorator';
import {
    GitHubWebhookDispatcherService,
    INVALID_GITHUB_SIGNATURE,
} from './github-webhook-dispatcher.service';

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
 * FAILURE CONTRACT: this route has always 500'd when the App sync leg
 * threw, and GitHub's redelivery is load-bearing for installation sync,
 * so a sync-leg error is rethrown. The AI review leg is best-effort —
 * its failures are logged, never thrown, exactly as when it was added.
 *
 * The INTAKE leg (`issues`, `dependabot_alert` → the ingest spine → the
 * triage Task) is rethrown as well, and that is deliberate: this URL is
 * the DEFAULT one for a GitHub App install, so it is the route the
 * founder's "file an issue and the fleet picks it up" path actually
 * arrives on. Swallowing a transient intake failure here answers GitHub
 * 200, GitHub never redelivers, and the issue silently never becomes
 * work — the precise defect this whole intake exists to close. Rethrowing
 * costs nothing on the retry: the App sync leg is idempotent and the
 * spine dedupes on `(source, sourceEventId)`, so a redelivered issue
 * event inserts zero rows the second time.
 *
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
    // The same flood posture as the canonical `/api/ingest/github/events`
    // route next door. Both URLs reach the SAME dispatcher and the same
    // downstream work, so leaving one of them uncapped meant a flood
    // simply chose the unthrottled door.
    @Throttle({ long: { limit: 300, ttl: 60_000 } })
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
            throw new UnauthorizedException(INVALID_GITHUB_SIGNATURE);
        }

        if (result.errors.sync) {
            throw result.errors.sync;
        }

        // See FAILURE CONTRACT above: a dropped intake failure on THIS
        // route is an issue that never becomes work, because GitHub only
        // redelivers on a non-2xx.
        if (result.errors.intake) {
            throw result.errors.intake;
        }

        return { ok: true };
    }
}
