import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { DataSource } from 'typeorm';
import type { ActivityLogService } from '@ever-works/agent/activity-log';
import {
    EverConnectConnection,
    EverConnectIntegration,
    EverConnectLease,
    EverConnectOutbox,
    EverInstance,
    ExternalIdentity,
} from '@ever-works/agent/entities';
import { EverIdIdentityLinkedEvent, EverIdIdentityUnlinkedEvent } from '@ever-works/agent/events';
import { EverInstanceService } from '@ever-works/agent/ever-instance';
import { PluginPlatformSettingsService } from '@ever-works/agent/plugins';
import { readEverConnectConfig } from '../ever-connect.config';
import {
    EverConnectConnectionChangedEvent,
    EverConnectIntegrationChangedEvent,
} from '../ever-connect.events';
import { EverConnectFeedService } from '../ever-connect-feed.service';
import { EverConnectIntegrationService } from '../ever-connect-integration.service';
import { EverConnectKeyService } from '../ever-connect-key.service';
import { EverConnectLeaseService } from '../ever-connect-lease.service';
import { EverConnectOutboxService, EverConnectOutboxWorker } from '../ever-connect-outbox.service';
import { EverConnectRunner } from '../ever-connect.runner';
import { EverConnectService } from '../ever-connect.service';
import {
    EverIdClientSettings,
    EVER_ID_SIGN_IN_PLUGIN_ID,
} from '../identity/ever-id-client.settings';
import { EverIdLoginHandler } from '../identity/ever-id-login.handler';
import { PersonLinkReporter } from '../identity/person-link.reporter';
import { PersonRequestsHandler } from '../identity/person-requests.handler';
import { createIdentityDataSource, insertIdentity } from '../identity/__tests__/db.helper-spec';

/**
 * Ever Connect end to end against the MOCK PLATFORM of the Ever Platform SDK
 * (`ever-mock-platform` from the `@ever-co/connect-tools` pinned in
 * `tools/egress-audit`): the module's own services on a real database, the
 * SDK client over real HTTP, the mock's integration gate and its call record.
 * The mock is started from the installed package (or reached at
 * `EVER_CONNECT_MOCK_URL`).
 *
 * 1. Connect with a connect code: redeem with a new connect key (stored
 *    wrapped), then the integration states are read.
 * 2. `ever_id_login` consented in app.ever.co reaches the installation through
 *    the feed: the Ever ID client is asked for, read until ready, its secret
 *    stored once and offered to the sign-in plugin.
 * 3. A link and an unlink are reported through the outbox, once each.
 * 4. A deletion request on the feed is answered once; the feed position moves.
 * 5. Revoking `ever_id_login` in app.ever.co forgets the client.
 * 6. Disconnecting tells Ever Platform, ends the connection here and discards
 *    the connect key; nothing is called after it.
 */
const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..');
const MOCK_BIN = join(
    REPO_ROOT,
    'tools/egress-audit/node_modules/@ever-co/connect-tools/dist/mock-platform/bin/ever-mock-platform.mjs',
);
const MOCK_ISSUER = 'https://mock-platform.test';
/**
 * The one Ever ID person the mock knows (its `people[0]`, which its deletion and
 * export requests name), under the issuer of the sign-in client it makes: a link
 * for any other subject answers `422 subject_unknown`, as on Ever Platform.
 */
const MOCK_PERSON = { issuer: `${MOCK_ISSUER}/idp`, subject: 'sub-ada' };
const MOCK_CONFIG = {
    people: [{ ...MOCK_PERSON, person_id: '01JMQCKPERS0N00000000000P1', org_role: 'owner' }],
};

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
        env: { ...process.env, EVER_MOCK_CONFIG_JSON: JSON.stringify(MOCK_CONFIG) },
    });
    const url = await new Promise<string>((resolve, reject) => {
        let out = '';
        const timer = setTimeout(
            () => reject(new Error(`mock platform did not start: ${out}`)),
            20_000,
        );
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

describeMock('Ever Connect — against the mock platform', () => {
    jest.setTimeout(90_000);

    let mock: { url: string; process: ChildProcess | null };
    let dataSource: DataSource;
    let events: EventEmitter2;
    let connection: EverConnectService;
    let keys: EverConnectKeyService;
    let integrations: EverConnectIntegrationService;
    let outbox: EverConnectOutboxService;
    let worker: EverConnectOutboxWorker;
    let feed: EverConnectFeedService;
    let platformSettings: PluginPlatformSettingsService;
    let settings: EverIdClientSettings;
    let reporter: PersonLinkReporter;
    let login: EverIdLoginHandler;
    let runner: EverConnectRunner;
    const savedEnv = { ...process.env };

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
    /** One worker round without the long-poll wait: the feed, then the outbox. */
    const round = async () => {
        await feed.pollOnce(0);
        await worker.drainOnce();
    };
    /** Wait for the async listeners of the in-process events to settle. */
    const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

    beforeAll(async () => {
        mock = await startMock();
        process.env.WEB_URL = 'https://works.example.test';
        delete process.env.EVER_ID_ISSUER_URL;
        delete process.env.EVER_ID_CLIENT_ID;
        delete process.env.EVER_ID_CLIENT_SECRET;
        dataSource = await createIdentityDataSource();
        events = new EventEmitter2();

        const config = readEverConnectConfig({
            EVER_PLATFORM_API_URL: mock.url,
            EVER_PLATFORM_ISSUER: MOCK_ISSUER,
        });
        const instances = dataSource.getRepository(EverInstance);
        keys = new EverConnectKeyService(instances, new EverInstanceService(instances));
        connection = new EverConnectService(
            dataSource.getRepository(EverConnectConnection),
            keys,
            config,
            events,
        );
        integrations = new EverConnectIntegrationService(
            dataSource.getRepository(EverConnectIntegration),
            connection,
            events,
        );
        outbox = new EverConnectOutboxService(dataSource.getRepository(EverConnectOutbox));
        reporter = new PersonLinkReporter(connection, integrations, outbox, dataSource);
        worker = new EverConnectOutboxWorker(dataSource.getRepository(EverConnectOutbox), reporter);
        platformSettings = new PluginPlatformSettingsService();
        settings = new EverIdClientSettings(integrations, platformSettings);
        settings.onModuleInit();
        login = new EverIdLoginHandler(connection, integrations, settings);
        const requests = new PersonRequestsHandler(connection, dataSource, {
            log: jest.fn().mockResolvedValue({}),
        } as unknown as ActivityLogService);
        feed = new EverConnectFeedService(connection, integrations, requests);
        runner = new EverConnectRunner(
            config,
            connection,
            integrations,
            login,
            new EverConnectLeaseService(dataSource.getRepository(EverConnectLease)),
            feed,
            worker,
        );

        // The module's in-process listeners, wired as Nest wires @OnEvent.
        events.on(EverConnectIntegrationChangedEvent.EVENT_NAME, (event) =>
            login.onIntegrationChanged(event),
        );
        events.on(EverConnectConnectionChangedEvent.EVENT_NAME, (event) =>
            Promise.all([
                integrations.onConnectionChanged(event),
                outbox.onConnectionChanged(event),
            ]),
        );
    });

    afterAll(async () => {
        login?.onModuleDestroy();
        settings?.onModuleDestroy();
        await runner?.onModuleDestroy();
        await dataSource?.destroy();
        mock?.process?.kill();
        process.env = { ...savedEnv };
    });

    it('connects with a connect code; the connect key is stored wrapped and never returned', async () => {
        expect(await connection.client()).toBeNull();
        const status = await connection.connect('evc-test-0000-0004');
        expect(status).toMatchObject({ status: 'active', lastError: null });
        expect(status.platformInstanceId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
        expect(JSON.stringify(status)).not.toMatch(/key|jwk/i);

        const [instance] = await dataSource.getRepository(EverInstance).find();
        expect(instance.connectKeyId).toBeTruthy();
        expect(instance.connectPrivateKeyEncrypted).toBeTruthy();
        expect((await rowCalls(3)).map((entry) => entry.status)).toEqual([201]);

        // A second connect is refused before any request.
        await expect(connection.connect('EVC-TEST-0000-0004')).rejects.toMatchObject({
            response: { code: 'already_connected' },
        });
        expect(await rowCalls(3)).toHaveLength(1);

        await round();
        expect(await integrations.isEnabled()).toBe(false);
    });

    it('ever_id_login consented in app.ever.co: the client is made, stored once, offered to sign-in', async () => {
        await admin('consent', { integration: 'ever_id_login' });
        await round();
        await settle();

        expect(await integrations.isEnabled()).toBe(true);
        const instanceId = (await connection.status()).platformInstanceId;
        const client = await integrations.readClient();
        expect(client).toEqual({
            issuer: `${MOCK_ISSUER}/idp`,
            clientId: `inst-${instanceId}`,
            clientSecret: expect.stringMatching(/.+/),
        });
        expect(login.getStatus()).toBe('ready');
        expect((await rowCalls(14)).map((entry) => [entry.method, entry.status])).toEqual([
            ['POST', 202],
            ['GET', 200],
        ]);
        // Stored sealed: the row never holds the secret in clear when a key is set,
        // and the plugin gets it through the settings level below operator values.
        expect(await platformSettings.read(EVER_ID_SIGN_IN_PLUGIN_ID)).toEqual({
            issuerUrl: `${MOCK_ISSUER}/idp`,
            clientId: `inst-${instanceId}`,
            clientSecret: client?.clientSecret,
        });

        // Another round asks for nothing new.
        await round();
        await settle();
        expect(await rowCalls(14)).toHaveLength(2);
    });

    it('reports a link and its unlink through the outbox, once each', async () => {
        const identity = await insertIdentity(dataSource, {
            issuer: `${MOCK_ISSUER}/idp`,
            subject: 'sub-ada',
        });
        await reporter.onIdentityLinked(
            new EverIdIdentityLinkedEvent({
                identityId: identity.id,
                userId: identity.userId,
                linkedVia: 'sign-up',
            }),
        );
        expect(await worker.drainOnce()).toBe(1);

        await dataSource.getRepository(ExternalIdentity).delete({ id: identity.id });
        await reporter.onIdentityUnlinked(
            new EverIdIdentityUnlinkedEvent({ identityId: identity.id, userId: identity.userId }),
        );
        expect(await worker.drainOnce()).toBe(1);
        expect(await worker.drainOnce()).toBe(0);

        expect((await rowCalls(19)).map((entry) => [entry.method, entry.status])).toEqual([
            ['POST', 201],
            ['DELETE', 204],
        ]);
        expect(await dataSource.getRepository(EverConnectOutbox).count()).toBe(0);
    });

    it('answers a deletion request from the feed once and moves the feed position', async () => {
        const identity = await insertIdentity(dataSource, MOCK_PERSON);
        const { job_id: jobId } = (await admin('person-request', { kind: 'deletion' })) as {
            job_id: string;
        };
        await round();

        expect(
            await dataSource
                .getRepository(ExternalIdentity)
                .findOne({ where: { id: identity.id } }),
        ).toBeNull();
        const acks = await rowCalls(20);
        expect(acks.map((entry) => entry.status)).toEqual([204]);
        const cursor = (await connection.connection()).lastFeedCursor;
        expect(cursor).toBeTruthy();

        // Nothing new on the next round: no second answer.
        await round();
        expect(await rowCalls(20)).toHaveLength(1);
        expect(jobId).toBeTruthy();
    });

    it('revoking ever_id_login in app.ever.co forgets the client', async () => {
        await admin('revoke', { integration: 'ever_id_login' });
        await round();
        await settle();
        expect(await integrations.isEnabled()).toBe(false);
        expect(await integrations.readClient()).toBeNull();
        expect(await platformSettings.read(EVER_ID_SIGN_IN_PLUGIN_ID)).toEqual({});
    });

    it('disconnect tells Ever Platform, ends the connection and discards the connect key', async () => {
        const before = (await record()).length;
        expect(await connection.disconnect()).toMatchObject({ status: 'disconnected' });
        await settle();
        const after = await record();
        expect(after.slice(before).map((entry) => entry.path_template)).toEqual([
            '/v1/instances/me/disconnect',
        ]);
        const [instance] = await dataSource.getRepository(EverInstance).find();
        expect(instance.connectPrivateKeyEncrypted).toBeNull();
        expect(await connection.client()).toBeNull();

        expect(await runner.round()).toBe(false);
        expect(await record()).toHaveLength(after.length);
    });
});
