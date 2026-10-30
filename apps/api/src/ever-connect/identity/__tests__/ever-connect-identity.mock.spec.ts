import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
    createEverPlatformClient,
    generateInstanceKeyPair,
    makeNodeSigner,
    type EverPlatformClient,
} from '@ever-co/connect-sdk';
import type { DataSource } from 'typeorm';
import type { ActivityLogService } from '@ever-works/agent/activity-log';
import { ExternalIdentity } from '@ever-works/agent/entities';
import { EverIdIdentityLinkedEvent, EverIdIdentityUnlinkedEvent } from '@ever-works/agent/events';
import { PluginPlatformSettingsService } from '@ever-works/agent/plugins';
import type { EverConnectPlatform } from '../ever-connect-identity.ports';
import { EverIdClientSettings, EVER_ID_SIGN_IN_PLUGIN_ID } from '../ever-id-client.settings';
import { EverIdLoginHandler } from '../ever-id-login.handler';
import { PersonLinkReporter } from '../person-link.reporter';
import { PersonRequestsHandler } from '../person-requests.handler';
import { createIdentityDataSource, insertIdentity } from './db.helper-spec';
import { FakeIntegration, FakeQueue } from './fakes.helper-spec';

/**
 * The Ever ID handlers of a connected installation against the MOCK PLATFORM of
 * the Ever Platform SDK (`ever-mock-platform` from the `@ever-co/connect-tools`
 * pinned in `tools/egress-audit`), through the SDK client the installation
 * uses — real HTTP, the mock's integration gate and its call record.
 *
 * The mock is started from the installed package for this suite (or reached at
 * `EVER_CONNECT_MOCK_URL`). The Ever Connect module's connection is stood in
 * for by a redeemed connect code; `ever_id_login` is consented as app.ever.co
 * would.
 *
 * - The client is asked for once, read until ready, and its secret, handed over
 *   once, is stored and offered to the sign-in plugin.
 * - A link is reported once, its unlink too; nothing is sent while
 *   `ever_id_login` is off.
 * - A deletion request is answered once (`failed`, `account_deletion_pending`,
 *   the connected identity removed), and an event delivered again sends nothing.
 * - Revoking `ever_id_login` makes the next read forget the client.
 */
const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..', '..');
const MOCK_BIN = join(
    REPO_ROOT,
    'tools/egress-audit/node_modules/@ever-co/connect-tools/dist/mock-platform/bin/ever-mock-platform.mjs',
);
const MOCK_ISSUER = 'https://mock-platform.test';
/** The person the mock's requests name by default (its `people[0]`). */
const MOCK_PERSON = { issuer: 'https://auth.ever.co', subject: '275396402232829475' };

const describeMock =
    process.env.EVER_CONNECT_MOCK_URL || existsSync(MOCK_BIN) ? describe : describe.skip;

interface CallRecord {
    method: string;
    path_template: string;
    row: number | null;
    status: number;
}

async function startMock(): Promise<{ url: string; process: ChildProcess | null }> {
    if (process.env.EVER_CONNECT_MOCK_URL) {
        return { url: process.env.EVER_CONNECT_MOCK_URL.replace(/\/+$/, ''), process: null };
    }
    const child = spawn(process.execPath, [MOCK_BIN, '--host', '127.0.0.1', '--port', '0'], {
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const url = await new Promise<string>((resolve, reject) => {
        let out = '';
        const timer = setTimeout(() => reject(new Error(`mock platform did not start: ${out}`)), 20_000);
        child.stdout?.on('data', (chunk: Buffer) => {
            out += chunk.toString();
            const match = /listening on (http:\/\/[^\s]+)/.exec(out);
            if (match) {
                clearTimeout(timer);
                resolve(match[1].replace(/\/+$/, ''));
            }
        });
        child.once('exit', (code) => {
            clearTimeout(timer);
            reject(new Error(`mock platform exited (${code}): ${out}`));
        });
    });
    return { url, process: child };
}

describeMock('Ever ID for a connected installation — against the mock platform', () => {
    jest.setTimeout(60_000);

    let mock: { url: string; process: ChildProcess | null };
    let dataSource: DataSource;
    let client: EverPlatformClient;
    let platform: EverConnectPlatform;
    let integration: FakeIntegration;
    let queue: FakeQueue;
    let platformSettings: PluginPlatformSettingsService;
    let settings: EverIdClientSettings;
    let reporter: PersonLinkReporter;
    let login: EverIdLoginHandler;
    let requests: PersonRequestsHandler;
    const savedWebUrl = process.env.WEB_URL;

    const admin = async (path: string, body: unknown = {}) => {
        const res = await fetch(`${mock.url}/__mock/${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (res.status >= 300) throw new Error(`mock ${path}: ${res.status} ${await res.text()}`);
        return res.json();
    };
    const record = async (): Promise<CallRecord[]> =>
        (await fetch(`${mock.url}/__mock/requests`)).json() as Promise<CallRecord[]>;
    const rowCalls = async (row: number) => (await record()).filter((entry) => entry.row === row);

    beforeAll(async () => {
        process.env.WEB_URL = 'https://works.example.test';
        mock = await startMock();
        dataSource = await createIdentityDataSource();

        const pair = generateInstanceKeyPair();
        let registryId: string | null = null;
        client = createEverPlatformClient({
            baseUrl: mock.url,
            issuer: MOCK_ISSUER,
            userAgentProduct: { product: 'works', version: '1.0.0' },
            signer: makeNodeSigner(pair.privateKeyPkcs8Der),
            registryInstanceId: () => registryId,
            onWarning: () => undefined,
        });
        const redeemed = await client.connect.redeem(
            {
                code: 'EVC-TEST-0000-0004',
                product: 'works',
                version: '1.0.0',
                install_source: 'self-hosted',
                kind: 'self_hosted',
                public_jwk: pair.publicJwk,
            } as Parameters<EverPlatformClient['connect']['redeem']>[0],
            'works-identity-mock-redeem',
        );
        registryId = redeemed.instance_id;
        await admin('consent', { integration: 'ever_id_login' });

        platform = { client: async () => client };
        integration = new FakeIntegration();
        queue = new FakeQueue();
        platformSettings = new PluginPlatformSettingsService();
        settings = new EverIdClientSettings(integration, platformSettings);
        settings.onModuleInit();
        reporter = new PersonLinkReporter(platform, integration, queue, dataSource);
        login = new EverIdLoginHandler(platform, integration, settings, reporter);
        requests = new PersonRequestsHandler(platform, dataSource, {
            log: jest.fn().mockResolvedValue({}),
        } as unknown as ActivityLogService);
    });

    afterAll(async () => {
        login?.onModuleDestroy();
        settings?.onModuleDestroy();
        await dataSource?.destroy();
        mock?.process?.kill();
        process.env.WEB_URL = savedWebUrl;
    });

    it('makes, reads and stores the sign-in client; the secret comes once', async () => {
        expect(await login.start()).toBe('ready');
        const instanceId = (await client.instances.self()).instance.id;
        expect(integration.stored).toEqual({
            issuer: `${MOCK_ISSUER}/idp`,
            clientId: `inst-${instanceId}`,
            clientSecret: expect.stringMatching(/.+/),
        });
        const secret = integration.stored?.clientSecret;

        // A second read carries no secret; the stored one stays.
        expect(await login.refresh()).toBe('ready');
        expect(integration.stored?.clientSecret).toBe(secret);
        expect(integration.writes).toBe(1);

        const rows = await rowCalls(14);
        expect(rows.map((entry) => [entry.method, entry.status])).toEqual([
            ['POST', 202],
            ['GET', 200],
            ['GET', 200],
        ]);
        expect(await platformSettings.read(EVER_ID_SIGN_IN_PLUGIN_ID)).toEqual({
            issuerUrl: `${MOCK_ISSUER}/idp`,
            clientId: `inst-${instanceId}`,
            clientSecret: secret,
        });
    });

    it('reports a link once and its unlink; nothing while ever_id_login is off', async () => {
        const identity = await insertIdentity(dataSource, {
            issuer: `${MOCK_ISSUER}/idp`,
            subject: 'sub-ada',
        });
        await reporter.onIdentityLinked(
            new EverIdIdentityLinkedEvent({ identityId: identity.id, userId: identity.userId, linkedVia: 'settings' }),
        );
        const link = queue.reports.find((report) => report.op === 'link' && report.subject === 'sub-ada');
        expect(link).toBeDefined();
        expect(await reporter.send(link!)).toEqual({ outcome: 'sent' });

        await dataSource.getRepository(ExternalIdentity).delete({ id: identity.id });
        await reporter.onIdentityUnlinked(
            new EverIdIdentityUnlinkedEvent({ identityId: identity.id, userId: identity.userId }),
        );
        const unlink = queue.reports[queue.reports.length - 1];
        expect(unlink).toMatchObject({ op: 'unlink', userRef: identity.userId });
        expect(await reporter.send(unlink)).toEqual({ outcome: 'sent' });

        expect((await rowCalls(19)).map((entry) => [entry.method, entry.status])).toEqual([
            ['POST', 201],
            ['DELETE', 204],
        ]);

        integration.enabled = false;
        const before = queue.reports.length;
        await reporter.onIdentityLinked(
            new EverIdIdentityLinkedEvent({ identityId: identity.id, userId: identity.userId }),
        );
        expect(queue.reports).toHaveLength(before);
        expect(await reporter.send(link!)).toMatchObject({ outcome: 'dropped' });
        expect(await rowCalls(19)).toHaveLength(2);
        integration.enabled = true;
    });

    it('answers a deletion request once', async () => {
        const identity = await insertIdentity(dataSource, MOCK_PERSON);
        const { job_id: jobId } = (await admin('person-request', { kind: 'deletion' })) as {
            job_id: string;
        };
        const feed = await client.instances.events(null, { waitS: 0 });
        const event = feed.events.find(
            (envelope) =>
                envelope.type === 'ever.registry.person.deletion_requested' &&
                (envelope.data as { job_id?: string }).job_id === jobId,
        );
        expect(event).toBeDefined();

        expect(await requests.handle(event!)).toEqual({
            jobId,
            kind: 'deletion',
            result: 'failed',
            reasonCode: 'account_deletion_pending',
            recorded: true,
        });
        expect(await dataSource.getRepository(ExternalIdentity).findOne({ where: { id: identity.id } })).toBeNull();

        expect(await requests.handle(event!)).toMatchObject({ recorded: true });
        expect((await rowCalls(20)).map((entry) => entry.status)).toEqual([204]);
    });

    it('answers an export request for a person with no account here: no_account', async () => {
        const { job_id: jobId } = (await admin('person-request', { kind: 'export' })) as {
            job_id: string;
        };
        const feed = await client.instances.events(null, { waitS: 0 });
        const event = feed.events.find(
            (envelope) => (envelope.data as { job_id?: string }).job_id === jobId,
        );
        expect(await requests.handle(event!)).toMatchObject({ result: 'no_account', recorded: true });
    });

    it('revoking ever_id_login makes the next read forget the client', async () => {
        await admin('revoke', { integration: 'ever_id_login' });
        expect(await login.refresh()).toBe('off');
        expect(integration.stored).toBeNull();
        expect(await platformSettings.read(EVER_ID_SIGN_IN_PLUGIN_ID)).toEqual({});
    });
});
