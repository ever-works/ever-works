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
});
