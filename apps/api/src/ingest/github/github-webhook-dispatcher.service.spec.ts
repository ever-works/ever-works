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
// The App sync service is only a DI token here; importing it for real
// drags the whole import/generators graph (and `p-map`, ESM-only) into a
// unit spec.
jest.mock('../../integrations/github-app/github-app-sync.service', () => ({
    GitHubAppSyncService: class {},
}));

import { GitHubWebhookDispatcherService } from './github-webhook-dispatcher.service';
import { computeGitHubSignature } from './github-signature.util';

const INSTALL_SECRET = 'per-install-webhook-secret';
const APP_SECRET = 'platform-app-webhook-secret';
const INSTALL_BINDING = {
    userId: 'user-install',
    webhookSecret: INSTALL_SECRET,
    matchedBy: 'binding' as const,
};

/**
 * ONE consolidated GitHub receiver (audit 08(g)).
 *
 * These specs are the regression pin for the merge: the delivery is
 * verified ONCE against either configured credential, resolved through
 * the ONE `ingest_install_bindings` table, and fanned out to BOTH
 * consumers — the App installation sync and the ingest/PR-review bridge.
 */
describe('GitHubWebhookDispatcherService', () => {
    const originalAppSecret = process.env.GITHUB_APP_WEBHOOK_SECRET;

    afterEach(() => {
        if (originalAppSecret === undefined) {
            delete process.env.GITHUB_APP_WEBHOOK_SECRET;
        } else {
            process.env.GITHUB_APP_WEBHOOK_SECRET = originalAppSecret;
        }
    });

    function createDispatcher(
        overrides: {
            appSecret?: string;
            installation?: unknown;
            userLink?: unknown;
            boundUserId?: string | null;
        } = {},
    ) {
        if (overrides.appSecret === undefined) {
            delete process.env.GITHUB_APP_WEBHOOK_SECRET;
        } else {
            process.env.GITHUB_APP_WEBHOOK_SECRET = overrides.appSecret;
        }

        const bridge = {
            resolveBinding: jest
                .fn()
                .mockResolvedValue({ status: 'resolved', binding: INSTALL_BINDING }),
            recordBinding: jest.fn().mockResolvedValue(undefined),
            handleEvent: jest.fn().mockResolvedValue({ ingested: null }),
            installBindingFor: jest
                .fn()
                .mockResolvedValue(
                    overrides.boundUserId ? { userId: overrides.boundUserId } : null,
                ),
        };
        const appSync = { handleWebhook: jest.fn().mockResolvedValue(undefined) };
        const installations = {
            findByInstallationId: jest.fn().mockResolvedValue(overrides.installation ?? null),
        };
        const userLinks = {
            findByGithubUserId: jest.fn().mockResolvedValue(overrides.userLink ?? null),
        };

        const dispatcher = new GitHubWebhookDispatcherService(
            bridge as never,
            appSync as never,
            installations as never,
            userLinks as never,
        );
        return { dispatcher, bridge, appSync, installations, userLinks };
    }

    /** Build a delivery signed with `secret`. */
    function signed(bodyObj: unknown, secret: string, eventName = 'pull_request') {
        const rawBody = JSON.stringify(bodyObj);
        return {
            rawBody,
            signature: computeGitHubSignature(secret, rawBody),
            eventName,
            body: bodyObj,
        };
    }

    const PR_BODY = {
        action: 'opened',
        installation: { id: 4242 },
        repository: { full_name: 'octo/site', owner: { login: 'octo' } },
        pull_request: { number: 7, title: 'Add page', head: { sha: 'abc' } },
    };

    describe('malformed deliveries', () => {
        it('rejects a delivery with no event header before touching any consumer', async () => {
            const { dispatcher, bridge, appSync } = createDispatcher();
            await expect(
                dispatcher.dispatch({
                    rawBody: '{}',
                    signature: 'sig',
                    eventName: undefined,
                    body: {},
                }),
            ).rejects.toThrow(BadRequestException);
            expect(bridge.resolveBinding).not.toHaveBeenCalled();
            expect(appSync.handleWebhook).not.toHaveBeenCalled();
        });

        it('rejects a delivery with no raw body before touching any consumer', async () => {
            const { dispatcher, bridge, appSync } = createDispatcher();
            await expect(
                dispatcher.dispatch({
                    rawBody: undefined,
                    signature: 'sig',
                    eventName: 'pull_request',
                    body: {},
                }),
            ).rejects.toThrow(BadRequestException);
            expect(bridge.resolveBinding).not.toHaveBeenCalled();
            expect(appSync.handleWebhook).not.toHaveBeenCalled();
        });
    });

    describe('one signature verification, two accepted credentials', () => {
        it('verifies a per-install delivery and fans out to BOTH consumers', async () => {
            const { dispatcher, bridge, appSync } = createDispatcher();

            const result = await dispatcher.dispatch(signed(PR_BODY, INSTALL_SECRET));

            expect(result.credential).toBe('install-secret');
            expect(result.handled).toEqual({ sync: true, review: true });
            // The consumer the receiver already had...
            expect(bridge.handleEvent).toHaveBeenCalledWith(
                INSTALL_BINDING,
                'pull_request',
                PR_BODY,
            );
            // ...and the one that used to need a SECOND receiver.
            expect(appSync.handleWebhook).toHaveBeenCalledWith('pull_request', PR_BODY);
        });

        it('verifies a platform-App delivery and fans out to BOTH consumers', async () => {
            const { dispatcher, bridge, appSync } = createDispatcher({
                appSecret: APP_SECRET,
                installation: { createdByUserId: 'user-app' },
            });

            const result = await dispatcher.dispatch(signed(PR_BODY, APP_SECRET));

            expect(result.credential).toBe('app-secret');
            expect(result.handled).toEqual({ sync: true, review: true });
            expect(appSync.handleWebhook).toHaveBeenCalledWith('pull_request', PR_BODY);
            // Installing the GitHub App now turns the review loop on with
            // NO second webhook to configure — the whole point of 08(g).
            expect(bridge.handleEvent).toHaveBeenCalledWith(
                expect.objectContaining({ userId: 'user-app', matchedBy: 'app-install' }),
                'pull_request',
                PR_BODY,
            );
            // The per-install resolver is never consulted for an
            // app-secret delivery — one verification, not two.
            expect(bridge.resolveBinding).not.toHaveBeenCalled();
        });

        it('still accepts a per-install delivery when an App secret is also configured', async () => {
            const { dispatcher, bridge } = createDispatcher({ appSecret: APP_SECRET });

            const result = await dispatcher.dispatch(signed(PR_BODY, INSTALL_SECRET));

            expect(result.credential).toBe('install-secret');
            expect(bridge.handleEvent).toHaveBeenCalled();
        });

        it('rejects a delivery that matches NEITHER credential with 401', async () => {
            const { dispatcher, bridge, appSync } = createDispatcher({ appSecret: APP_SECRET });
            bridge.resolveBinding.mockResolvedValue({
                status: 'resolved',
                binding: INSTALL_BINDING,
            });

            const delivery = signed(PR_BODY, 'a-third-partys-secret');

            await expect(dispatcher.dispatch(delivery)).rejects.toThrow(UnauthorizedException);
            expect(bridge.handleEvent).not.toHaveBeenCalled();
            expect(appSync.handleWebhook).not.toHaveBeenCalled();
            expect(bridge.recordBinding).not.toHaveBeenCalled();
        });

        it('fails closed with 401 when nothing is configured — even for ping', async () => {
            const { dispatcher, appSync, bridge } = createDispatcher();
            bridge.resolveBinding.mockResolvedValue({ status: 'not-configured' });

            await expect(
                dispatcher.dispatch(
                    signed({ zen: 'Keep it logically awesome.' }, INSTALL_SECRET, 'ping'),
                ),
            ).rejects.toThrow(/not configured/);
            expect(appSync.handleWebhook).not.toHaveBeenCalled();
        });

        it('refuses an unattributable installation as a clean no-op — never a 500, never a guess', async () => {
            const { dispatcher, bridge, appSync } = createDispatcher();
            bridge.resolveBinding.mockResolvedValue({
                status: 'unresolved',
                reason: 'unknown-workspace',
            });

            const result = await dispatcher.dispatch(signed(PR_BODY, INSTALL_SECRET));

            expect(result).toEqual({
                ok: true,
                ignored: 'unknown-workspace',
                handled: { sync: false, review: false },
                errors: {},
            });
            expect(bridge.handleEvent).not.toHaveBeenCalled();
            expect(appSync.handleWebhook).not.toHaveBeenCalled();
            expect(bridge.recordBinding).not.toHaveBeenCalled();
        });

        it('acknowledges a verified ping without dispatching the review leg', async () => {
            const { dispatcher, bridge } = createDispatcher();
            const result = await dispatcher.dispatch(
                signed({ zen: 'Design for failure.' }, INSTALL_SECRET, 'ping'),
            );
            expect(result.ok).toBe(true);
            expect(bridge.handleEvent).not.toHaveBeenCalled();
        });
    });

    /**
     * Install-binding resolution is UNCHANGED for the per-install path,
     * and the App path writes into the SAME table rather than growing a
     * second binding store.
     */
    describe('one install binding', () => {
        it('passes the delivery installation + a signature probe to the resolver (unchanged)', async () => {
            const { dispatcher, bridge } = createDispatcher();

            await dispatcher.dispatch(signed(PR_BODY, INSTALL_SECRET));

            const lookup = bridge.resolveBinding.mock.calls[0][0];
            expect(lookup.workspace).toEqual({
                keys: ['installation:4242', 'owner:octo'],
                label: 'octo',
            });
            expect(lookup.verifySignature(INSTALL_SECRET)).toBe(true);
            expect(lookup.verifySignature('someone-elses-secret')).toBe(false);
        });

        it('records the per-install binding only after the signature verified (unchanged)', async () => {
            const { dispatcher, bridge } = createDispatcher();

            await expect(
                dispatcher.dispatch({
                    ...signed(PR_BODY, INSTALL_SECRET),
                    signature: 'sha256=deadbeef',
                }),
            ).rejects.toThrow(UnauthorizedException);
            expect(bridge.recordBinding).not.toHaveBeenCalled();

            await dispatcher.dispatch(signed(PR_BODY, INSTALL_SECRET));
            expect(bridge.recordBinding).toHaveBeenCalledWith(INSTALL_BINDING);
        });

        it('prefers an existing binding row over the App installation record', async () => {
            const { dispatcher, bridge, installations } = createDispatcher({
                appSecret: APP_SECRET,
                boundUserId: 'user-bound',
                installation: { createdByUserId: 'user-app' },
            });

            await dispatcher.dispatch(signed(PR_BODY, APP_SECRET));

            expect(bridge.installBindingFor).toHaveBeenCalledWith('installation:4242');
            expect(installations.findByInstallationId).not.toHaveBeenCalled();
            expect(bridge.handleEvent).toHaveBeenCalledWith(
                expect.objectContaining({ userId: 'user-bound', matchedBy: 'binding' }),
                'pull_request',
                PR_BODY,
            );
            // `matchedBy: 'binding'` means the row already exists — no
            // pointless rewrite.
            expect(bridge.recordBinding).toHaveBeenCalledWith(
                expect.objectContaining({ matchedBy: 'binding' }),
            );
        });

        it('falls back to the GitHub user link when the installation has no platform owner', async () => {
            const { dispatcher, bridge, userLinks } = createDispatcher({
                appSecret: APP_SECRET,
                installation: { createdByGithubUserId: '9001' },
                userLink: { userId: 'user-linked' },
            });

            await dispatcher.dispatch(signed(PR_BODY, APP_SECRET));

            expect(userLinks.findByGithubUserId).toHaveBeenCalledWith('9001');
            expect(bridge.handleEvent).toHaveBeenCalledWith(
                expect.objectContaining({ userId: 'user-linked' }),
                'pull_request',
                PR_BODY,
            );
        });

        it('records the App-resolved binding into the same table so later deliveries resolve exactly', async () => {
            const { dispatcher, bridge } = createDispatcher({
                appSecret: APP_SECRET,
                installation: { createdByUserId: 'user-app' },
            });

            await dispatcher.dispatch(signed(PR_BODY, APP_SECRET));

            expect(bridge.recordBinding).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 'user-app',
                    matchedBy: 'app-install',
                    workspace: expect.objectContaining({
                        keys: ['installation:4242', 'owner:octo'],
                    }),
                }),
            );
        });

        it('skips the review leg (but still syncs) when an App delivery has no resolvable owner', async () => {
            const { dispatcher, bridge, appSync } = createDispatcher({ appSecret: APP_SECRET });

            const result = await dispatcher.dispatch(signed(PR_BODY, APP_SECRET));

            expect(result.handled).toEqual({ sync: true, review: false });
            expect(appSync.handleWebhook).toHaveBeenCalled();
            expect(bridge.handleEvent).not.toHaveBeenCalled();
            expect(bridge.recordBinding).not.toHaveBeenCalled();
        });
    });

    /**
     * Fanning out to a second consumer must not invent a new way for
     * either route to fail: `dispatch` REPORTS both legs' errors instead
     * of throwing, and each controller rethrows only its own.
     */
    describe('consumer failures are isolated and reported', () => {
        it('still runs the review leg when the App sync leg throws', async () => {
            const { dispatcher, bridge, appSync } = createDispatcher();
            const boom = new Error('installation sync exploded');
            appSync.handleWebhook.mockRejectedValue(boom);

            const result = await dispatcher.dispatch(signed(PR_BODY, INSTALL_SECRET));

            expect(result.errors.sync).toBe(boom);
            expect(result.handled).toEqual({ sync: false, review: true });
            expect(bridge.handleEvent).toHaveBeenCalled();
        });

        it('still runs the App sync leg when the review leg throws', async () => {
            const { dispatcher, bridge, appSync } = createDispatcher();
            const boom = new Error('ingest exploded');
            bridge.handleEvent.mockRejectedValue(boom);

            const result = await dispatcher.dispatch(signed(PR_BODY, INSTALL_SECRET));

            expect(result.errors.review).toBe(boom);
            expect(result.handled).toEqual({ sync: true, review: false });
            expect(appSync.handleWebhook).toHaveBeenCalled();
        });
    });

    /**
     * Issue / Dependabot intake (self-build §6, R2): feature services
     * register as consumers at boot instead of being injected, so the
     * dispatcher's constructor and the PR-review bridge stay untouched.
     * A consumer sees ONLY verified, owner-attributed deliveries.
     */
    describe('registered intake consumers', () => {
        const ISSUE_BODY = {
            action: 'opened',
            installation: { id: 4242 },
            repository: { full_name: 'octo/site', owner: { login: 'octo' } },
            issue: { number: 42, title: 'Login broken' },
        };

        function consumer(events: string[]) {
            return { events, handle: jest.fn().mockResolvedValue(undefined) };
        }

        it('hands a verified delivery to a consumer registered for its event name', async () => {
            const { dispatcher } = createDispatcher();
            const issues = consumer(['issues', 'dependabot_alert']);
            dispatcher.registerConsumer(issues);

            const result = await dispatcher.dispatch(signed(ISSUE_BODY, INSTALL_SECRET, 'issues'));

            expect(issues.handle).toHaveBeenCalledWith(INSTALL_BINDING, 'issues', ISSUE_BODY);
            expect(result.errors.intake).toBeUndefined();
            // The pre-existing legs and their result shape are untouched.
            expect(result.handled).toEqual({ sync: true, review: true });
        });

        it('never calls a consumer for ping, for events it did not register, or before verification', async () => {
            const { dispatcher, bridge } = createDispatcher();
            const issues = consumer(['issues']);
            dispatcher.registerConsumer(issues);

            await dispatcher.dispatch(signed({ zen: 'Keep it simple.' }, INSTALL_SECRET, 'ping'));
            await dispatcher.dispatch(signed(PR_BODY, INSTALL_SECRET, 'pull_request'));
            expect(issues.handle).not.toHaveBeenCalled();

            await expect(
                dispatcher.dispatch({
                    ...signed(ISSUE_BODY, INSTALL_SECRET, 'issues'),
                    signature: 'sha256=deadbeef',
                }),
            ).rejects.toThrow(UnauthorizedException);
            expect(issues.handle).not.toHaveBeenCalled();

            bridge.resolveBinding.mockResolvedValue({
                status: 'unresolved',
                reason: 'unknown-workspace',
            });
            await dispatcher.dispatch(signed(ISSUE_BODY, INSTALL_SECRET, 'issues'));
            expect(issues.handle).not.toHaveBeenCalled();
        });

        it('skips consumers (like the review leg) when an App delivery has no resolvable owner', async () => {
            const { dispatcher } = createDispatcher({ appSecret: APP_SECRET });
            const issues = consumer(['issues']);
            dispatcher.registerConsumer(issues);

            const result = await dispatcher.dispatch(signed(ISSUE_BODY, APP_SECRET, 'issues'));

            expect(result.handled).toEqual({ sync: true, review: false });
            expect(issues.handle).not.toHaveBeenCalled();
        });

        it('isolates a consumer failure into errors.intake without touching the other legs', async () => {
            const { dispatcher, bridge, appSync } = createDispatcher();
            const boom = new Error('intake exploded');
            const failing = { events: ['issues'], handle: jest.fn().mockRejectedValue(boom) };
            const healthy = consumer(['issues']);
            dispatcher.registerConsumer(failing);
            dispatcher.registerConsumer(healthy);

            const result = await dispatcher.dispatch(signed(ISSUE_BODY, INSTALL_SECRET, 'issues'));

            expect(result.errors.intake).toBe(boom);
            expect(result.errors.review).toBeUndefined();
            expect(result.errors.sync).toBeUndefined();
            expect(result.handled).toEqual({ sync: true, review: true });
            expect(bridge.handleEvent).toHaveBeenCalled();
            expect(appSync.handleWebhook).toHaveBeenCalled();
            // One consumer blowing up does not starve the next.
            expect(healthy.handle).toHaveBeenCalled();
        });
    });

    /**
     * The App-sync leg writes PLATFORM state off identifiers taken
     * straight out of the body: `installation` upserts / soft-deletes a
     * `github_app_installations` row (and can overwrite the
     * `createdByGithubUserId` that decides who owns an installation's
     * deliveries), `installation_repositories` re-pulls that
     * installation's private repository list, and `push` stamps
     * `pendingSyncRequestedAt` on whichever Work claims the named repo.
     *
     * None of that has any relation to the verified sender. An ordinary
     * tenant with an enabled `github` plugin picks their OWN
     * `webhookSecret`, so they could sign
     * `{"action":"deleted","installation":{"id":<victim>}}` with it, pass
     * verification as themselves, and soft-delete a stranger's App
     * installation — killing that account's issue intake, PR review and
     * repo sync. Installation ids are small non-secret integers, so the
     * whole deployment was enumerable.
     *
     * Only GitHub, signing with the PLATFORM App webhook secret, is an
     * authority on platform App state.
     */
    describe('the App-sync leg requires the platform App credential', () => {
        const INSTALL_EVENT_BODY = {
            action: 'deleted',
            installation: { id: 4242 },
        };

        it.each(['installation', 'installation_repositories', 'push'])(
            'refuses to run App sync for a %s delivery verified with a per-install secret',
            async (eventName) => {
                const { dispatcher, appSync } = createDispatcher();

                const result = await dispatcher.dispatch(
                    signed(INSTALL_EVENT_BODY, INSTALL_SECRET, eventName),
                );

                expect(appSync.handleWebhook).not.toHaveBeenCalled();
                expect(result.handled.sync).toBe(false);
                // The delivery is still verified and still 200s — only the
                // privileged leg is withheld.
                expect(result.credential).toBe('install-secret');
            },
        );

        it('runs App sync for the SAME delivery when GitHub signed it with the app secret', async () => {
            const { dispatcher, appSync } = createDispatcher({
                appSecret: APP_SECRET,
                installation: { createdByUserId: 'user-app' },
            });

            const result = await dispatcher.dispatch(
                signed(INSTALL_EVENT_BODY, APP_SECRET, 'installation'),
            );

            expect(appSync.handleWebhook).toHaveBeenCalledWith('installation', INSTALL_EVENT_BODY);
            expect(result.handled.sync).toBe(true);
        });

        it('leaves every non-state-writing event flowing to the sync leg as before', async () => {
            const { dispatcher, appSync } = createDispatcher();

            await dispatcher.dispatch(signed(PR_BODY, INSTALL_SECRET, 'pull_request'));

            expect(appSync.handleWebhook).toHaveBeenCalledWith('pull_request', PR_BODY);
        });

        // A string id was the way to make the ownership check blind to the
        // id the sync leg was about to act on (`extractGitHubWorkspaceRef`
        // normalizes both forms now — pinned in the bridge's own spec).
        // The gate holds for that shape too.
        it('blocks a STRING-id installation delivery on the same gate', async () => {
            const { dispatcher, appSync } = createDispatcher();

            await dispatcher.dispatch(
                signed(
                    { action: 'deleted', installation: { id: '4242' } },
                    INSTALL_SECRET,
                    'installation',
                ),
            );

            expect(appSync.handleWebhook).not.toHaveBeenCalled();
        });
    });

    /**
     * `ingest_install_bindings` rows on the install-secret path are
     * written from an UNVERIFIED body, so a tenant can squat
     * `owner:<somebody-else>` by signing a body naming it with their own
     * webhook secret. Consulting that row BEFORE
     * `github_app_installations` meant the squatted row outranked
     * platform state, and every genuinely app-signed delivery for the
     * victim's installation — their issues included — was attributed to
     * the squatter.
     */
    describe('app-secret ownership comes from platform state first', () => {
        it('prefers github_app_installations over a squatted binding row', async () => {
            const { dispatcher, bridge } = createDispatcher({
                appSecret: APP_SECRET,
                installation: { createdByUserId: 'victim' },
                boundUserId: 'squatter',
            });

            await dispatcher.dispatch(signed(PR_BODY, APP_SECRET));

            expect(bridge.handleEvent).toHaveBeenCalledWith(
                expect.objectContaining({ userId: 'victim', matchedBy: 'app-install' }),
                'pull_request',
                PR_BODY,
            );
        });

        it('falls back to the binding row only when platform state does not answer', async () => {
            const { dispatcher, bridge } = createDispatcher({
                appSecret: APP_SECRET,
                installation: null,
                boundUserId: 'bound-user',
            });

            await dispatcher.dispatch(signed(PR_BODY, APP_SECRET));

            expect(bridge.handleEvent).toHaveBeenCalledWith(
                expect.objectContaining({ userId: 'bound-user', matchedBy: 'binding' }),
                'pull_request',
                PR_BODY,
            );
        });

        it('resolves through the GitHub user link when only createdByGithubUserId is known', async () => {
            const { dispatcher, bridge } = createDispatcher({
                appSecret: APP_SECRET,
                installation: { createdByGithubUserId: '987' },
                userLink: { userId: 'linked-user' },
            });

            await dispatcher.dispatch(signed(PR_BODY, APP_SECRET));

            expect(bridge.handleEvent).toHaveBeenCalledWith(
                expect.objectContaining({ userId: 'linked-user', matchedBy: 'app-install' }),
                'pull_request',
                PR_BODY,
            );
        });
    });

    /**
     * Two textually distinct 401s told an unauthenticated prober whether
     * ANY account on the deployment has an enabled `github` install with
     * a webhook secret — a per-deployment tenant oracle, free, before
     * they hold any credential.
     */
    it('answers "nothing configured" and "bad signature" with the SAME 401 body', async () => {
        const notConfigured = createDispatcher();
        notConfigured.bridge.resolveBinding.mockResolvedValue({ status: 'not-configured' });
        const unconfiguredMessage = await notConfigured.dispatcher
            .dispatch(signed(PR_BODY, INSTALL_SECRET))
            .catch((error: Error) => error.message);

        const badSignature = createDispatcher();
        const badSignatureMessage = await badSignature.dispatcher
            .dispatch(signed(PR_BODY, 'someone-elses-secret'))
            .catch((error: Error) => error.message);

        expect(unconfiguredMessage).toBe(badSignatureMessage);
    });
});
