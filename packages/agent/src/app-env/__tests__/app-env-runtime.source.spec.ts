import { Logger } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import type { AppSpec, AppSpecEnvEntry } from '@ever-works/contracts';
import { WorkAppDependency } from '../../entities/work-app-dependency.entity';
import { WorkAppEnvValue } from '../../entities/work-app-env-value.entity';
import { ENTITIES } from '../../database/_entities-inventory';
import { WorkAppEnvValueRepository } from '../../database/repositories/work-app-env-value.repository';
import { PluginSecretEncService } from '../../plugins/services/plugin-secret-enc.service';
import { AppEnvCrypto } from '../app-env-crypto';
import { APP_ENV_SPEC_SOURCE, type AppEnvSpecSource } from '../app-env.service';
import { AppEnvResolver } from '../app-env.resolver';
import {
    APP_ENV_DEPLOY_READINESS,
    AppEnvRuntimeSource,
    notReadyKinds,
    type AppEnvDeployReadinessSource,
    type AppRuntimeEphemeralEnvContext,
} from '../app-env-runtime.source';

/**
 * APW-07 T14 — `AppEnvRuntimeSource`, APW-06's `AppRuntimeEnvSource`
 * (`ports.ts:182-205`) bound to `APP_RUNTIME_ENV_SOURCE`.
 *
 * Plan §4.6.1:424-449 is the contract of record: `resolve` returns
 * `{ values, fingerprints, secretNames, unsetRequired, notReadyDependencies,
 * egress }`, `resolveEphemeral` has its two targets, the `cluster` target reads
 * `ctx.dependencyOutputs` and the `runner` target returns a recipe and **no
 * value at all**. Spec: FR-21…FR-27, FR-62; ACC-07-06, -09, -13, -31, -33.
 *
 * The resolver is the REAL one over a real in-memory database and a real
 * `enc::v1::` envelope, so "nothing is stored" (ACC-07-31) is a row count and a
 * spy over T8's three write doors rather than a claim about a mock.
 */

const KEY = 'a'.repeat(64);
const WORK = '11111111-1111-4111-8111-111111111111';
const DOMAIN = 'https://app.example.test';
const DB_PASSWORD = 'pg-1n-cluster-p4ss';
const SMTP_PASSWORD_VALUE = 'smtp-1n-cluster-p4ss';
const S3_SECRET = 's3-1n-cluster-s3cr3t';

function fixtureEnv(): AppSpecEnvEntry[] {
    return [
        {
            name: 'NEXTAUTH_SECRET',
            secret: true,
            phase: 'both',
            generate: { kind: 'base64', bytes: 24, rotate: 'never' },
        },
        {
            name: 'VAPID_PRIVATE_KEY',
            secret: true,
            generate: {
                kind: 'keypair',
                keypair: { type: 'ed25519', format: 'pem' },
                rotate: 'never',
            },
        },
        { name: 'DATABASE_URL', secret: true, from: 'deps.postgres.url' },
        {
            name: 'DATABASE_HOST',
            phase: 'both',
            template: '{{deps.postgres.host}}:{{deps.postgres.port}}',
        },
        { name: 'NEXTAUTH_URL', template: '{{domains.primary.url}}/api/auth' },
        { name: 'MAIL_HOST', from: 'deps.smtp.host' },
        {
            name: 'S3_WEB_URL',
            template: 'https://cdn.example.test/{{deps.objectStorage.bucket.attachments}}',
        },
        {
            name: 'SMTP_PASSWORD',
            secret: true,
            prompt: { description: 'SMTP password', required: true },
        },
        {
            name: 'LICENSE_KEY',
            phase: 'both',
            prompt: { description: 'Your license key', required: true },
        },
        {
            name: 'SUPPORT_EMAIL',
            prompt: { description: 'Support email address', required: false },
        },
        { name: 'CALCOM_TELEMETRY_DISABLED', value: '1' },
    ];
}

function fixtureSpec(): AppSpec {
    return {
        kind: 'app',
        appSpecVersion: 1,
        dependencies: {
            postgres: {},
            objectStorage: { buckets: ['attachments'] },
            smtp: { required: false },
        },
        env: fixtureEnv(),
    };
}

function postgresOutputs(): Record<string, string> {
    return {
        url: `postgresql://ever_works:pw-${DB_PASSWORD}@pg.internal:5432/app`,
        host: 'pg.internal',
        port: '5432',
        database: 'app',
        user: 'ever_works',
        password: DB_PASSWORD,
    };
}

function objectStorageOutputs(): Record<string, string> {
    return {
        endpoint: 'https://s3.example.test',
        region: 'eu-central-1',
        accessKeyId: 'AKIA-TEST',
        secretAccessKey: S3_SECRET,
        'bucket.attachments': 'attachments',
    };
}

const RUNTIME_CTX = {
    target: 'your-cluster' as const,
    primaryUrl: DOMAIN,
    primaryHost: 'app.example.test',
    buildCommitSha: null,
    internalUrls: { web: 'http://web.app.svc:3000' },
};

describe('AppEnvRuntimeSource (T14, plan §4.6.1:424-449)', () => {
    let dataSource: DataSource;
    let valueRepository: WorkAppEnvValueRepository;
    let rows: Repository<WorkAppEnvValue>;
    let dependencyRows: Repository<WorkAppDependency>;
    let crypto: AppEnvCrypto;
    let savedKey: string | undefined;

    beforeAll(async () => {
        savedKey = process.env.PLUGIN_SECRET_ENCRYPTION_KEY;
        process.env.PLUGIN_SECRET_ENCRYPTION_KEY = KEY;

        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        await dataSource.query('PRAGMA foreign_keys = OFF');

        valueRepository = new WorkAppEnvValueRepository(dataSource.getRepository(WorkAppEnvValue));
        rows = dataSource.getRepository(WorkAppEnvValue);
        dependencyRows = dataSource.getRepository(WorkAppDependency);
        crypto = new AppEnvCrypto(new PluginSecretEncService());
    });

    afterAll(async () => {
        await dataSource.destroy();
        if (savedKey === undefined) {
            delete process.env.PLUGIN_SECRET_ENCRYPTION_KEY;
        } else {
            process.env.PLUGIN_SECRET_ENCRYPTION_KEY = savedKey;
        }
    });

    beforeEach(async () => {
        await rows.clear();
        await dependencyRows.clear();
        ensureReadyForDeploy.mockClear();
        jest.restoreAllMocks();
        jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    /* ---------------------------------------------------------------------- *
     * Seeding and factories
     * ---------------------------------------------------------------------- */

    async function store(name: string, value: string, version = 1): Promise<void> {
        await rows.insert({
            workId: WORK,
            name,
            origin: 'user',
            valueEncrypted: crypto.encrypt(value),
            valueBytes: Buffer.byteLength(value, 'utf8'),
            version,
        });
    }

    async function storeDependency(
        kind: string,
        options: { status?: string; providerId?: string; outputs?: Record<string, string> } = {},
    ): Promise<void> {
        await dependencyRows.insert({
            workId: WORK,
            kind: kind as never,
            deployTarget: 'your-cluster' as never,
            providerPluginId: 'k8s',
            providerId: options.providerId ?? `k8s-inline-${kind}`,
            status: (options.status ?? 'ready') as never,
            declared: {},
            backupPolicy: 'none',
            outputsEncrypted: options.outputs
                ? crypto.encrypt(JSON.stringify(options.outputs))
                : null,
            outputsVersion: 1,
        });
    }

    function specSource(spec: AppSpec = fixtureSpec()): AppEnvSpecSource {
        return { read: async () => ({ spec, specHash: 'hash-1', commitSha: 'commit-1' }) };
    }

    /** A source over the REAL resolver, with the readiness port bound. */
    function makeSource(
        options: {
            readiness?: AppEnvDeployReadinessSource | null;
            resolver?: AppEnvResolver | null;
            spec?: AppSpec;
        } = {},
    ): AppEnvRuntimeSource {
        const resolver =
            options.resolver === null
                ? undefined
                : (options.resolver ??
                  new AppEnvResolver(
                      specSource(options.spec),
                      valueRepository,
                      rows,
                      crypto,
                      dependencyRows,
                  ));
        const readiness =
            options.readiness === null
                ? undefined
                : (options.readiness ?? { ensureReadyForDeploy });
        return new AppEnvRuntimeSource(resolver, readiness);
    }

    /** What `AppDependenciesService.ensureReadyForDeploy` answers for this fixture. */
    const ensureReadyForDeploy = jest.fn(async () => ({
        ready: false,
        notReady: [{ kind: 'postgres' as const, status: 'pending', reason: null }],
        optional: ['smtp' as const],
    }));

    /** Every external destination a ready fixture carries, plus the in-cluster postgres. */
    async function seedReadyWorld(): Promise<void> {
        await storeDependency('postgres', { outputs: postgresOutputs() });
        await storeDependency('smtp', {
            providerId: 'smtp-external',
            outputs: {
                host: 'smtp.mail.test',
                port: '587',
                user: 'relay-user',
                password: SMTP_PASSWORD_VALUE,
                from: 'no-reply@mail.test',
                secure: 'false',
            },
        });
        await storeDependency('objectStorage', {
            providerId: 's3-external',
            outputs: objectStorageOutputs(),
        });
        await store('NEXTAUTH_SECRET', 'generated-secret', 3);
        await store('VAPID_PRIVATE_KEY', 'PRIVATE-PEM', 5);
        await store('VAPID_PRIVATE_KEY_PUBLIC', 'PUBLIC-PEM', 6);
    }

    /* ---------------------------------------------------------------------- *
     * resolve — the port shape (plan §4.6.1:429-437)
     * ---------------------------------------------------------------------- */

    it('answers the port shape: values, fingerprints, secretNames, unsetRequired, notReadyDependencies, egress', async () => {
        await seedReadyWorld();

        const source = makeSource();
        const result = await source.resolve(WORK, 'commit-1', RUNTIME_CTX);

        // values + fingerprints, with the map keyed exactly like the values.
        expect(result.values.DATABASE_URL).toBe(
            `postgresql://ever_works:pw-${DB_PASSWORD}@pg.internal:5432/app`,
        );
        expect(result.values.DATABASE_HOST).toBe('pg.internal:5432');
        expect(result.values.NEXTAUTH_URL).toBe(`${DOMAIN}/api/auth`);
        expect(result.values.S3_WEB_URL).toBe('https://cdn.example.test/attachments');
        expect(Object.keys(result.fingerprints).sort()).toEqual(Object.keys(result.values).sort());
        expect(result.fingerprints.NEXTAUTH_SECRET).toBe('v3');
        expect(result.fingerprints.DATABASE_URL).toBe('d1');

        // secretNames is the secret subset only. `SMTP_PASSWORD` is required and
        // unstored, so it has no value yet and is reported by `unsetRequired`
        // instead; a bucket NAME resolves as non-secret (§11:236).
        expect(result.secretNames.sort()).toEqual(
            ['DATABASE_URL', 'NEXTAUTH_SECRET', 'VAPID_PRIVATE_KEY'].sort(),
        );
        expect(result.secretNames).not.toContain('VAPID_PRIVATE_KEY_PUBLIC');
        expect(result.secretNames).not.toContain('CALCOM_TELEMETRY_DISABLED');
        expect(result.secretNames).not.toContain('S3_WEB_URL');
        expect(result.values.S3_WEB_URL).toBe('https://cdn.example.test/attachments');

        // unsetRequired names BOTH unset required values (ACC-07-09).
        expect(result.unsetRequired.sort()).toEqual(['LICENSE_KEY', 'SMTP_PASSWORD']);

        // The readiness answer, and exactly one question asked.
        expect(result.notReadyDependencies).toEqual(['postgres']);
        expect(ensureReadyForDeploy).toHaveBeenCalledTimes(1);
        expect(ensureReadyForDeploy).toHaveBeenCalledWith(WORK);

        // egress: the external providers only (§4.6.1:434-435).
        expect(result.egress).toEqual([
            { host: 's3.example.test', ports: [443] },
            { host: 'smtp.mail.test', ports: [587] },
        ]);
    });

    it('asks ensureReadyForDeploy exactly once per resolve, and never from an ephemeral path (§4.6.1:432-434, GAP-05)', async () => {
        await seedReadyWorld();
        const source = makeSource();

        await source.resolve(WORK, 'commit-1', RUNTIME_CTX);
        expect(ensureReadyForDeploy).toHaveBeenCalledTimes(1);

        await source.resolveEphemeral(WORK, 'commit-1', {
            target: 'cluster',
            primaryUrl: DOMAIN,
            primaryHost: 'app.example.test',
            buildCommitSha: null,
            internalUrls: {},
        });
        await source.resolveEphemeral(WORK, 'commit-1', {
            target: 'runner',
            primaryUrl: DOMAIN,
            primaryHost: 'app.example.test',
            buildCommitSha: null,
            internalUrls: {},
        });
        expect(ensureReadyForDeploy).toHaveBeenCalledTimes(1);
    });

    it('exposes the keypair public half and keeps the private half out of every public list (ACC-07-06)', async () => {
        await seedReadyWorld();

        const result = await makeSource().resolve(WORK, 'commit-1', RUNTIME_CTX);

        expect(result.values.VAPID_PRIVATE_KEY_PUBLIC).toBe('PUBLIC-PEM');
        expect(result.secretNames).not.toContain('VAPID_PRIVATE_KEY_PUBLIC');
        expect(result.values.VAPID_PRIVATE_KEY).toBe('PRIVATE-PEM');
        expect(result.secretNames).toContain('VAPID_PRIVATE_KEY');
        expect(result.fingerprints.VAPID_PRIVATE_KEY).toBe('v5');
    });

    it('leaves an optional, unconfigured smtp dependency unset with the warning instead of blocking (ACC-07-33, FR-62)', async () => {
        await storeDependency('postgres', { outputs: postgresOutputs() });

        const result = await makeSource().resolve(WORK, 'commit-1', RUNTIME_CTX);

        expect(result.values.MAIL_HOST).toBeUndefined();
        expect(result.unresolved.map((entry) => entry.name)).not.toContain('MAIL_HOST');
        expect(result.warnings).toEqual([
            { code: 'smtpNotConfigured', name: 'MAIL_HOST', ref: 'deps.smtp.host' },
        ]);
    });

    it('reports a referenced dependency that is not ready, and how (FR-23)', async () => {
        await storeDependency('postgres', { status: 'failed' });

        const result = await makeSource().resolve(WORK, 'commit-1', RUNTIME_CTX);

        expect(result.notReadyDependencies).toEqual(['postgres']);
        expect(result.unresolved.find((entry) => entry.name === 'DATABASE_URL')).toEqual({
            name: 'DATABASE_URL',
            reason: 'dependencyNotReady',
            ref: 'deps.postgres.url',
        });
        expect(JSON.stringify(result)).not.toContain('value":');
    });

    /* ---------------------------------------------------------------------- *
     * resolve — the managed tier (plan §4.6.1:436-437, §4.11:689-696)
     * ---------------------------------------------------------------------- */

    it('emits ew-dep:// placeholders on the managed tier and never an output value', async () => {
        await seedReadyWorld();

        const result = await makeSource().resolve(WORK, 'commit-1', {
            ...RUNTIME_CTX,
            target: 'ever-works-apps',
        });

        expect(result.values.DATABASE_URL).toBe('ew-dep://postgres/url');
        expect(result.values.DATABASE_HOST).toBe('ew-dep://postgres/host:ew-dep://postgres/port');
        expect(result.values.S3_WEB_URL).toBe(
            'https://cdn.example.test/ew-dep://objectStorage/bucket.attachments',
        );
        expect(result.secretNames).toContain('DATABASE_URL');

        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain(DB_PASSWORD);
        expect(serialized).not.toContain(S3_SECRET);
        // The platform holds no managed outputs, so nothing is there to open.
        expect(result.egress).toEqual([]);
    });

    /* ---------------------------------------------------------------------- *
     * resolveEphemeral — cluster (R-10, ACC-07-31)
     * ---------------------------------------------------------------------- */

    it('resolves a derived reference from ctx.dependencyOutputs and stores nothing (ACC-07-31)', async () => {
        const insertSpy = jest.spyOn(valueRepository, 'insertIfAbsent');
        const upsertSpy = jest.spyOn(valueRepository, 'upsertValue');
        const deleteSpy = jest.spyOn(valueRepository, 'deleteNames');

        const ctx: AppRuntimeEphemeralEnvContext = {
            target: 'cluster',
            primaryUrl: DOMAIN,
            primaryHost: 'app.example.test',
            buildCommitSha: null,
            internalUrls: { web: 'http://web.verify.svc:3000' },
            dependencyOutputs: {
                postgres: postgresOutputs(),
                objectStorage: objectStorageOutputs(),
            },
        };

        const first = await makeSource().resolveEphemeral(WORK, 'commit-1', ctx);
        const second = await makeSource().resolveEphemeral(WORK, 'commit-1', ctx);

        expect(first.values?.DATABASE_URL).toBe(
            `postgresql://ever_works:pw-${DB_PASSWORD}@pg.internal:5432/app`,
        );
        expect(first.values?.DATABASE_HOST).toBe('pg.internal:5432');
        expect(first.values?.S3_WEB_URL).toBe('https://cdn.example.test/attachments');
        expect(first.values?.VAPID_PRIVATE_KEY_PUBLIC).toMatch(/BEGIN PUBLIC KEY/);
        expect(first.secretNames).toContain('VAPID_PRIVATE_KEY');
        expect(first.unsetRequired.sort()).toEqual(['LICENSE_KEY', 'SMTP_PASSWORD']);

        // Fresh values on every call, and no value at all in the answer of the
        // runner target.
        expect(first.values?.NEXTAUTH_SECRET).toBeTruthy();
        expect(second.values?.NEXTAUTH_SECRET).not.toBe(first.values?.NEXTAUTH_SECRET);
        expect(first.recipe).toBeUndefined();

        // Zero writes, to the database and through T8's write doors.
        expect(await rows.count()).toBe(0);
        expect(await dependencyRows.count()).toBe(0);
        expect(insertSpy).not.toHaveBeenCalled();
        expect(upsertSpy).not.toHaveBeenCalled();
        expect(deleteSpy).not.toHaveBeenCalled();
    });

    it('uses an already-set prompted value and names the ones that are missing (ACC-07-31)', async () => {
        await store('SMTP_PASSWORD', 'owner-supplied', 2);

        const result = await makeSource().resolveEphemeral(WORK, 'commit-1', {
            target: 'cluster',
            primaryUrl: DOMAIN,
            primaryHost: null,
            buildCommitSha: null,
            internalUrls: {},
        });

        expect(result.values?.SMTP_PASSWORD).toBe('owner-supplied');
        expect(result.unsetRequired).toEqual(['LICENSE_KEY']);
        expect(result.values?.VAPID_PRIVATE_KEY).toBeTruthy();
    });

    it('reports a dependency output the verification did not get, without writing anything (ACC-07-31)', async () => {
        const result = await makeSource().resolveEphemeral(WORK, 'commit-1', {
            target: 'cluster',
            primaryUrl: DOMAIN,
            primaryHost: null,
            buildCommitSha: null,
            internalUrls: {},
            dependencyOutputs: {},
        });

        expect(result.unresolved.find((entry) => entry.name === 'DATABASE_URL')?.reason).toBe(
            'dependencyNotReady',
        );
        expect(await dependencyRows.count()).toBe(0);
    });

    /* ---------------------------------------------------------------------- *
     * resolveEphemeral — runner (plan §4.6.1:447)
     * ---------------------------------------------------------------------- */

    it('returns a value-free recipe for the runner target, and no values at all', async () => {
        await store('NEXTAUTH_SECRET', 'generated-secret', 3);
        await store('SMTP_PASSWORD', SMTP_PASSWORD_VALUE, 2);

        const result = await makeSource().resolveEphemeral(WORK, 'commit-1', {
            target: 'runner',
            primaryUrl: DOMAIN,
            primaryHost: 'app.example.test',
            buildCommitSha: 'commit-1',
            internalUrls: { web: 'http://web.app.svc:3000' },
        });

        expect(result.values).toBeUndefined();
        expect(result.recipe).toBeDefined();
        expect(result.recipe?.length).toBeGreaterThan(0);

        const byName = new Map((result.recipe ?? []).map((entry) => [entry.name, entry]));
        expect(byName.get('DATABASE_URL')).toEqual({
            name: 'DATABASE_URL',
            secret: true,
            source: 'template',
            spec: {
                text: 'postgresql://ever-works-build:{{gen:DEP_POSTGRES_PASSWORD}}@postgres:5432/app',
                tokens: [
                    {
                        kind: 'gen',
                        name: 'DEP_POSTGRES_PASSWORD',
                        placeholder: '{{gen:DEP_POSTGRES_PASSWORD}}',
                    },
                ],
            },
        });
        expect(byName.get('SMTP_PASSWORD')).toEqual({
            name: 'SMTP_PASSWORD',
            secret: true,
            source: 'prompted',
            spec: { required: true },
        });
        expect(byName.get('CALCOM_TELEMETRY_DISABLED')).toEqual({
            name: 'CALCOM_TELEMETRY_DISABLED',
            secret: false,
            source: 'literal',
            spec: { value: '1' },
        });

        // A recipe carries no value of any kind: not a stored secret, not a
        // generated one, and not an envelope.
        const serialized = JSON.stringify(result.recipe);
        expect(serialized).not.toContain('generated-secret');
        expect(serialized).not.toContain(SMTP_PASSWORD_VALUE);
        expect(serialized).not.toContain('enc::v1::');
        expect(result.unsetRequired.sort()).toEqual(['LICENSE_KEY', 'SMTP_PASSWORD']);
    });

    /* ---------------------------------------------------------------------- *
     * Fail-closed wiring
     * ---------------------------------------------------------------------- */

    it('answers "nothing known" when the resolver or the readiness source is unbound', async () => {
        const noResolver = makeSource({ resolver: null, readiness: null });
        const empty = await noResolver.resolve(WORK, 'commit-1', RUNTIME_CTX);

        expect(empty.values).toEqual({});
        expect(empty.fingerprints).toEqual({});
        expect(empty.secretNames).toEqual([]);
        expect(empty.unsetRequired).toEqual([]);
        expect(empty.notReadyDependencies).toEqual([]);
        expect(empty.egress).toEqual([]);

        const noReadiness = makeSource({ readiness: null });
        const resolved = await noReadiness.resolve(WORK, 'commit-1', RUNTIME_CTX);
        expect(resolved.notReadyDependencies).toEqual([]);
        expect(resolved.values.NEXTAUTH_URL).toBe(`${DOMAIN}/api/auth`);
    });

    it('does not invent a readiness answer when ensureReadyForDeploy throws', async () => {
        const failing: AppEnvDeployReadinessSource = {
            ensureReadyForDeploy: jest.fn(async () => {
                throw new Error('cluster unreachable');
            }),
        };

        const result = await makeSource({ readiness: failing }).resolve(
            WORK,
            'commit-1',
            RUNTIME_CTX,
        );

        expect(result.notReadyDependencies).toEqual([]);
        expect(failing.ensureReadyForDeploy).toHaveBeenCalledTimes(1);
    });

    it('hands back the readiness answer it obtained, so a caller never has to ask a second time (GAP-05)', async () => {
        // §5.1 step 9 reads this instead of calling `ensureReadyForDeploy` again: every call
        // runs `reconcile`, which re-dispatches each `pending` kind, so step 8 + step 9 asking
        // separately dispatched every pending provision twice per Deploy preflight.
        const answered = await makeSource().resolve(WORK, 'commit-1', RUNTIME_CTX);
        expect(answered.dependencyReadiness).toEqual(
            await ensureReadyForDeploy.mock.results[0].value,
        );
        expect(ensureReadyForDeploy).toHaveBeenCalledTimes(1);

        // No answer is `null` — "not asked / could not ask", never a fabricated one.
        const unbound = await makeSource({ readiness: null }).resolve(
            WORK,
            'commit-1',
            RUNTIME_CTX,
        );
        expect(unbound.dependencyReadiness).toBeNull();

        const throwing = await makeSource({
            readiness: {
                ensureReadyForDeploy: jest.fn(async () => {
                    throw new Error('cluster unreachable');
                }),
            },
        }).resolve(WORK, 'commit-1', RUNTIME_CTX);
        expect(throwing.dependencyReadiness).toBeNull();
    });

    it('deduplicates and sorts the not-ready kinds (pure)', () => {
        expect(
            notReadyKinds({
                ready: false,
                notReady: [
                    { kind: 'smtp', status: 'pending', reason: null },
                    { kind: 'postgres', status: 'failed', reason: 'clusterUnreachable' },
                    { kind: 'smtp', status: 'pending', reason: null },
                ],
                optional: [],
            }),
        ).toEqual(['postgres', 'smtp']);
        expect(notReadyKinds(null)).toEqual([]);
    });

    it('exposes the readiness token so a binder can alias the dependency service', () => {
        expect(typeof APP_ENV_DEPLOY_READINESS).toBe('symbol');
        expect(typeof APP_ENV_SPEC_SOURCE).toBe('symbol');
    });
});
