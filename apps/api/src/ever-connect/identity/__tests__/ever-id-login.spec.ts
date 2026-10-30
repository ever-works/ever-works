import { PluginPlatformSettingsService } from '@ever-works/agent/plugins';
import { EverIdClientSettings, EVER_ID_SIGN_IN_PLUGIN_ID } from '../ever-id-client.settings';
import {
    CLIENT_READ_FIRST_MS,
    EVER_ID_WEB_BACKCHANNEL_LOGOUT_PATH,
    EverIdLoginHandler,
} from '../ever-id-login.handler';
import type { PersonLinkReporter } from '../person-link.reporter';
import { FakeIntegration, FakePlatform, problem } from './fakes.helper-spec';

/**
 * Sign in with Ever ID for a connected installation — the client hand-off.
 *
 * - Nothing is asked for while the installation is not connected or
 *   `ever_id_login` is off.
 * - The client is asked for with the web host's sign-in return and logout
 *   addresses (one origin), read until ready, and its secret — in the first
 *   ready answer only — is stored once and offered to the sign-in plugin
 *   below any value an operator set.
 * - A pending or ready client (`409`) is read instead; refused addresses end
 *   the attempt; a ready client whose secret was not stored is reported, never
 *   guessed; a revoked client and the end of `ever_id_login` forget it.
 */
describe('EverIdLoginHandler — the Ever ID client hand-off', () => {
    const ISSUER = 'https://id.example.test';
    const WEB = 'https://works.example.test';
    let platform: FakePlatform;
    let integration: FakeIntegration;
    let platformSettings: PluginPlatformSettingsService;
    let settings: EverIdClientSettings;
    let reporter: { reportExistingLinks: jest.Mock };
    let handler: EverIdLoginHandler;
    const savedEnv = { ...process.env };

    const ready = (secret?: string) => ({
        status: 'ready',
        job_id: '01K6A7S2ABCDEFGHJKMNPQRSTV',
        issuer: ISSUER,
        client_id: 'inst-01K6A7S2ABCDEFGHJKMNPQRSTV',
        ...(secret ? { client_secret: secret } : {}),
    });

    beforeEach(() => {
        jest.useFakeTimers();
        process.env.WEB_URL = `${WEB}/`;
        for (const name of ['EVER_ID_ISSUER_URL', 'EVER_ID_CLIENT_ID', 'EVER_ID_CLIENT_SECRET']) {
            delete process.env[name];
        }
        platform = new FakePlatform();
        integration = new FakeIntegration();
        platformSettings = new PluginPlatformSettingsService();
        settings = new EverIdClientSettings(integration, platformSettings);
        settings.onModuleInit();
        reporter = { reportExistingLinks: jest.fn().mockResolvedValue(0) };
        handler = new EverIdLoginHandler(
            platform,
            integration,
            settings,
            reporter as unknown as PersonLinkReporter,
        );
    });

    afterEach(() => {
        handler.onModuleDestroy();
        settings.onModuleDestroy();
        jest.useRealTimers();
        process.env = { ...savedEnv };
    });

    it('asks for nothing while ever_id_login is off or the installation is not connected', async () => {
        integration.enabled = false;
        expect(await handler.start()).toBe('off');
        integration.enabled = true;
        platform.connected = false;
        expect(await handler.start()).toBe('off');
        expect(platform.calls).toEqual([]);
    });

    it('asks once, reads until ready, stores the secret once and offers it to the sign-in plugin', async () => {
        platform
            .answer('instanceRequestOidcClient', {
                status: 'pending',
                job_id: '01K6A7S2ABCDEFGHJKMNPQRSTV',
            })
            .answer('instanceGetOidcClient', { status: 'pending' }, ready('ics_secret'), ready());

        expect(await handler.start()).toBe('pending');
        const [request] = platform.callsOf('instanceRequestOidcClient');
        expect(request.input?.body).toEqual({
            redirect_uri: `${WEB}/api/auth/ever-id/callback`,
            logout_uri: `${WEB}${EVER_ID_WEB_BACKCHANNEL_LOGOUT_PATH}`,
        });
        expect(new URL(String(request.input?.body?.redirect_uri)).origin).toBe(
            new URL(String(request.input?.body?.logout_uri)).origin,
        );
        expect(request.input?.idempotencyKey).toMatch(/^oidc-client-/);

        // The pending client is read again on its schedule.
        await jest.advanceTimersByTimeAsync(CLIENT_READ_FIRST_MS);
        expect(handler.getStatus()).toBe('ready');
        expect(integration.stored).toEqual({
            issuer: ISSUER,
            clientId: 'inst-01K6A7S2ABCDEFGHJKMNPQRSTV',
            clientSecret: 'ics_secret',
        });
        expect(integration.writes).toBe(1);
        expect(reporter.reportExistingLinks).toHaveBeenCalledWith(ISSUER);

        // A later read carries no secret: the stored client stays.
        expect(await handler.refresh()).toBe('ready');
        expect(integration.writes).toBe(1);
        expect(integration.stored?.clientSecret).toBe('ics_secret');
        expect(platform.callsOf('instanceRequestOidcClient')).toHaveLength(1);

        expect(await platformSettings.read(EVER_ID_SIGN_IN_PLUGIN_ID)).toEqual({
            issuerUrl: ISSUER,
            clientId: 'inst-01K6A7S2ABCDEFGHJKMNPQRSTV',
            clientSecret: 'ics_secret',
        });
    });

    it('a stored client is not asked for again', async () => {
        integration.stored = { issuer: ISSUER, clientId: 'inst-x', clientSecret: 's' };
        expect(await handler.start()).toBe('ready');
        expect(platform.calls).toEqual([]);
    });

    it('a client pending or ready already (409) is read instead', async () => {
        platform
            .answer('instanceRequestOidcClient', problem(409, 'oidc_client_exists'))
            .answer('instanceGetOidcClient', ready('ics_again'));
        expect(await handler.start()).toBe('ready');
        expect(integration.stored?.clientSecret).toBe('ics_again');
    });

    it('refused addresses end the attempt without retrying', async () => {
        platform.answer('instanceRequestOidcClient', problem(422, 'redirect_uri_invalid'));
        expect(await handler.start()).toBe('failed');
        await jest.advanceTimersByTimeAsync(10 * 60_000);
        expect(platform.calls).toHaveLength(1);
        expect(integration.stored).toBeNull();
    });

    it('an outage is retried with the same idempotency key, a new request gets a new one', async () => {
        platform.answer(
            'instanceRequestOidcClient',
            problem(503, 'unavailable'),
            { status: 'pending' },
            { status: 'pending' },
        );
        platform.answer(
            'instanceGetOidcClient',
            ready('ics_1'),
            problem(403, 'integration_revoked'),
        );
        expect(await handler.start()).toBe('requesting');
        await jest.advanceTimersByTimeAsync(CLIENT_READ_FIRST_MS);
        expect(handler.getStatus()).toBe('ready');
        const [first, retry] = platform.callsOf('instanceRequestOidcClient');
        expect(retry.input?.idempotencyKey).toBe(first.input?.idempotencyKey);

        // Revoked at Ever Platform: the next read forgets the client.
        expect(await handler.refresh()).toBe('off');
        expect(integration.stored).toBeNull();

        platform.answer('instanceGetOidcClient', ready('ics_2'));
        expect(await handler.start()).toBe('ready');
        const third = platform.callsOf('instanceRequestOidcClient')[2];
        expect(third.input?.idempotencyKey).not.toBe(first.input?.idempotencyKey);
        expect(integration.stored?.clientSecret).toBe('ics_2');
    });

    it('a ready client whose secret was not stored here is reported, not guessed', async () => {
        platform
            .answer('instanceRequestOidcClient', problem(409, 'oidc_client_exists'))
            .answer('instanceGetOidcClient', ready());
        expect(await handler.start()).toBe('secret_lost');
        expect(integration.stored).toBeNull();
    });

    it('a secret that cannot be stored is reported as lost, never logged', async () => {
        const warn = jest.spyOn(
            (handler as unknown as { logger: { error: () => void } }).logger,
            'error',
        );
        integration.failWrites = true;
        platform
            .answer('instanceRequestOidcClient', { status: 'pending' })
            .answer('instanceGetOidcClient', ready('ics_do_not_log'));
        expect(await handler.start()).toBe('secret_lost');
        expect(JSON.stringify(warn.mock.calls)).not.toContain('ics_do_not_log');
    });

    it('ending while the client is being stored forgets it again', async () => {
        let finishWrite!: () => void;
        const write = integration.writeClient.bind(integration);
        integration.writeClient = async (client) => {
            await new Promise<void>((resolve) => (finishWrite = resolve));
            await write(client);
        };
        platform
            .answer('instanceRequestOidcClient', { status: 'pending' })
            .answer('instanceGetOidcClient', ready('ics_racing'));
        const started = handler.start();
        await jest.advanceTimersByTimeAsync(0);
        await handler.end();
        finishWrite();
        await started;
        expect(integration.stored).toBeNull();
        expect(handler.getStatus()).toBe('off');
        expect(reporter.reportExistingLinks).not.toHaveBeenCalled();
    });

    it('a revoked client is forgotten', async () => {
        integration.stored = null;
        platform
            .answer('instanceRequestOidcClient', problem(409, 'oidc_client_exists'))
            .answer('instanceGetOidcClient', { status: 'revoked' });
        expect(await handler.start()).toBe('revoked');
        expect(integration.stored).toBeNull();
    });

    it('end() forgets the client, and an answer arriving after it stores nothing', async () => {
        let release!: (value: unknown) => void;
        platform
            .answer('instanceRequestOidcClient', { status: 'pending' })
            .answer('instanceGetOidcClient', () => new Promise((resolve) => (release = resolve)));
        const started = handler.start();
        await jest.advanceTimersByTimeAsync(0);
        await handler.end();
        release(ready('ics_late'));
        await started;
        expect(integration.stored).toBeNull();
        expect(handler.getStatus()).toBe('off');
        expect(await platformSettings.read(EVER_ID_SIGN_IN_PLUGIN_ID)).toEqual({});
    });

    it('an installation configured by hand keeps its configuration (env wins)', async () => {
        integration.stored = { issuer: ISSUER, clientId: 'inst-x', clientSecret: 's' };
        process.env.EVER_ID_CLIENT_ID = 'hand-made-client';
        expect(await platformSettings.read(EVER_ID_SIGN_IN_PLUGIN_ID)).toEqual({});
        delete process.env.EVER_ID_CLIENT_ID;
        settings.invalidate();
        expect(await platformSettings.read(EVER_ID_SIGN_IN_PLUGIN_ID)).toMatchObject({
            clientId: 'inst-x',
        });
    });
});
