import { BadRequestException, UnauthorizedException } from '@nestjs/common';

jest.mock('@ever-works/agent/ingest', () => ({
    EventIngestService: class {},
    IngestInstallBindingRepository: class {},
}));
jest.mock('@ever-works/agent/pr-review', () => ({ PrReviewService: class {} }));
jest.mock('@ever-works/agent/plugins', () => ({
    PluginSettingsService: class {},
    UserPluginRepository: class {},
}));
jest.mock('@ever-works/agent/database', () => ({
    GitHubAppInstallationRepository: class {},
    GitHubAppUserLinkRepository: class {},
}));
jest.mock('../../integrations/github-app/github-app-sync.service', () => ({
    GitHubAppSyncService: class {},
}));
jest.mock('../../auth/decorators/public.decorator', () => ({
    Public: () => () => undefined,
}));

import { GitHubAppWebhookController } from './github-app-webhook.controller';
import { GitHubEventsController } from './github-events.controller';
import { GitHubWebhookDispatcherService } from './github-webhook-dispatcher.service';
import { computeGitHubSignature } from './github-signature.util';

const APP_SECRET = 'platform-app-webhook-secret';

/**
 * The LEGACY route still answers.
 *
 * `POST /api/github-app/webhooks` is baked into the GitHub App's settings
 * and into every existing installation, so it cannot move. After the
 * consolidation it is a thin forwarder onto the shared receiver — these
 * specs pin both halves of that: the behaviours it always had (401 on an
 * unverifiable delivery, 500 on an App-sync failure, `{ ok: true }` on
 * success) AND the behaviour it gained (the same delivery now also drives
 * the ingest spine and the AI review, with no second webhook).
 */
describe('GitHubAppWebhookController (POST /api/github-app/webhooks — legacy route)', () => {
    const originalAppSecret = process.env.GITHUB_APP_WEBHOOK_SECRET;

    beforeEach(() => {
        process.env.GITHUB_APP_WEBHOOK_SECRET = APP_SECRET;
    });

    afterEach(() => {
        if (originalAppSecret === undefined) {
            delete process.env.GITHUB_APP_WEBHOOK_SECRET;
        } else {
            process.env.GITHUB_APP_WEBHOOK_SECRET = originalAppSecret;
        }
    });

    function createController(installation: unknown = { createdByUserId: 'user-app' }) {
        const bridge = {
            resolveBinding: jest.fn().mockResolvedValue({ status: 'not-configured' }),
            recordBinding: jest.fn().mockResolvedValue(undefined),
            handleEvent: jest.fn().mockResolvedValue({ ingested: null }),
            installBindingFor: jest.fn().mockResolvedValue(null),
        };
        const appSync = { handleWebhook: jest.fn().mockResolvedValue(undefined) };
        const dispatcher = new GitHubWebhookDispatcherService(
            bridge as never,
            appSync as never,
            { findByInstallationId: jest.fn().mockResolvedValue(installation) } as never,
            { findByGithubUserId: jest.fn().mockResolvedValue(null) } as never,
        );
        return {
            controller: new GitHubAppWebhookController(dispatcher),
            dispatcher,
            bridge,
            appSync,
        };
    }

    function signedRequest(bodyObj: unknown, secret = APP_SECRET) {
        const rawBody = JSON.stringify(bodyObj);
        return {
            req: { body: bodyObj, rawBody },
            signature: computeGitHubSignature(secret, rawBody),
        };
    }

    const INSTALL_BODY = {
        action: 'created',
        installation: { id: 4242 },
        repository: { full_name: 'octo/site', owner: { login: 'octo' } },
    };

    it('throws BadRequestException when the event header is missing (unchanged)', async () => {
        const { controller } = createController();
        await expect(
            controller.handleWebhook({ body: {}, rawBody: '{}' } as never, 'sig', undefined),
        ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when the raw body is missing (unchanged)', async () => {
        const { controller } = createController();
        await expect(
            controller.handleWebhook(
                { body: {}, rawBody: undefined } as never,
                'sig',
                'installation',
            ),
        ).rejects.toThrow(BadRequestException);
    });

    it('rejects an unverifiable delivery with 401 (unchanged)', async () => {
        const { controller, appSync } = createController();
        const { req } = signedRequest(INSTALL_BODY);
        await expect(
            controller.handleWebhook(req as never, 'sha256=deadbeef', 'installation'),
        ).rejects.toThrow(UnauthorizedException);
        expect(appSync.handleWebhook).not.toHaveBeenCalled();
    });

    it('verifies with the app secret and returns { ok: true } (unchanged)', async () => {
        const { controller, appSync } = createController();
        const { req, signature } = signedRequest(INSTALL_BODY);

        await expect(
            controller.handleWebhook(req as never, signature, 'installation'),
        ).resolves.toEqual({ ok: true });
        expect(appSync.handleWebhook).toHaveBeenCalledWith('installation', INSTALL_BODY);
    });

    it('rethrows an App-sync failure, as it always did (GitHub retry is load-bearing)', async () => {
        const { controller, appSync } = createController();
        appSync.handleWebhook.mockRejectedValue(new Error('installation sync exploded'));
        const { req, signature } = signedRequest(INSTALL_BODY);

        await expect(
            controller.handleWebhook(req as never, signature, 'installation'),
        ).rejects.toThrow('installation sync exploded');
    });

    it('NOW also drives the review loop — installing the App needs no second webhook', async () => {
        const { controller, bridge } = createController();
        const prBody = {
            action: 'opened',
            installation: { id: 4242 },
            repository: { full_name: 'octo/site', owner: { login: 'octo' } },
            pull_request: { number: 7, head: { sha: 'abc' } },
        };
        const { req, signature } = signedRequest(prBody);

        await controller.handleWebhook(req as never, signature, 'pull_request');

        expect(bridge.handleEvent).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'user-app', matchedBy: 'app-install' }),
            'pull_request',
            prBody,
        );
    });

    it('never 500s this route for an AI-review failure (best-effort leg, logged not thrown)', async () => {
        const { controller, bridge } = createController();
        bridge.handleEvent.mockRejectedValue(new Error('review exploded'));
        const { req, signature } = signedRequest(INSTALL_BODY);

        await expect(
            controller.handleWebhook(req as never, signature, 'installation'),
        ).resolves.toEqual({ ok: true });
    });

    /**
     * This URL is the DEFAULT one a GitHub App install delivers to, so it
     * is the route the founder's "file an issue, the fleet picks it up"
     * path actually arrives on. A swallowed intake failure here answers
     * GitHub 200, GitHub never redelivers, and the issue silently never
     * becomes work.
     */
    describe('the issue-intake leg', () => {
        const ISSUE_BODY = {
            action: 'opened',
            installation: { id: 4242 },
            repository: { full_name: 'octo/site', owner: { login: 'octo' } },
            issue: { number: 42, title: 'Login button does nothing', updated_at: '2026-09-05' },
        };

        it('reaches a registered intake consumer with the app-install binding', async () => {
            const { controller, dispatcher } = createController();
            const consumer = {
                events: ['issues'],
                handle: jest.fn().mockResolvedValue({ ingested: null }),
            };
            dispatcher.registerConsumer(consumer);
            const { req, signature } = signedRequest(ISSUE_BODY);

            await expect(
                controller.handleWebhook(req as never, signature, 'issues'),
            ).resolves.toEqual({ ok: true });
            expect(consumer.handle).toHaveBeenCalledWith(
                expect.objectContaining({ userId: 'user-app', matchedBy: 'app-install' }),
                'issues',
                ISSUE_BODY,
            );
        });

        it('rethrows an intake failure so GitHub redelivers the issue', async () => {
            const { controller, dispatcher } = createController();
            dispatcher.registerConsumer({
                events: ['issues'],
                handle: jest.fn().mockRejectedValue(new Error('ingest exploded')),
            });
            const { req, signature } = signedRequest(ISSUE_BODY);

            await expect(
                controller.handleWebhook(req as never, signature, 'issues'),
            ).rejects.toThrow('ingest exploded');
        });
    });

    /**
     * Both public GitHub URLs reach the SAME dispatcher and the same
     * downstream work, so an uncapped one is simply the door a flood
     * chooses. This route carried no `@Throttle` at all while the
     * canonical `/api/ingest/github/events` was capped at 300/minute.
     */
    it('carries the same throttle as the canonical receiver', () => {
        // @nestjs/throttler v6 stamps `THROTTLER:<FIELD><name>` per named tier.
        const limitOf = (handler: unknown) =>
            Reflect.getMetadata('THROTTLER:LIMITlong', handler as object);
        const ttlOf = (handler: unknown) =>
            Reflect.getMetadata('THROTTLER:TTLlong', handler as object);

        const legacy = GitHubAppWebhookController.prototype.handleWebhook;
        const canonical = GitHubEventsController.prototype.receiveEvents;

        expect(limitOf(legacy)).toBeDefined();
        expect(limitOf(legacy)).toBe(limitOf(canonical));
        expect(ttlOf(legacy)).toBe(ttlOf(canonical));
    });
});
