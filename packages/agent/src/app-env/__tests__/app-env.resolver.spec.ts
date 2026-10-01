import { Logger } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import {
    APP_ENV_TEMPLATE_MAX_DEPTH,
    computeBuildInputsHash,
    isAppDependencyOutputSecret,
    type AppEnvEntryView,
    type AppSpec,
    type AppSpecBuildService,
    type AppSpecEnvEntry,
} from '@ever-works/contracts';
import { WorkAppDependency } from '../../entities/work-app-dependency.entity';
import { WorkAppEnvValue } from '../../entities/work-app-env-value.entity';
import { ENTITIES } from '../../database/_entities-inventory';
import { WorkAppEnvValueRepository } from '../../database/repositories/work-app-env-value.repository';
import { PluginSecretEncService } from '../../plugins/services/plugin-secret-enc.service';
import {
    computeCurrentInputsHash,
    fingerprintsToValues,
} from '../../app-builds/deployable-verdict';
import { AppEnvCrypto } from '../app-env-crypto';
import { APP_ENV_SPEC_SOURCE, AppEnvService, type AppEnvSpecSource } from '../app-env.service';
import {
    APP_ENV_ENSURE_GENERATED,
    AppEnvResolver,
    appEnvSecretFingerprint,
    appEnvValueFingerprint,
    buildServiceOutputs,
    type AppEnvGeneratorPass,
    type AppEnvResolutionResult,
} from '../app-env.resolver';

/**
 * APW-07 T14 — `AppEnvResolver`, the §2.2 resolution table and the one
 * fingerprint rule.
 *
 * Plan §2.2 (`plan.md:110-150`) is the contract of record and this spec walks it
 * row by row, for BOTH phases, against a real database and a real `enc::v1::`
 * envelope (the same in-memory better-sqlite3 DataSource the T13 spec uses, so a
 * "stored value" here is a row that really exists):
 *
 * | §2.2 row                        | build                     | runtime                    |
 * | ------------------------------- | ------------------------- | -------------------------- |
 * | stored override                 | `BUILD_OVERRIDE`           | `DATABASE_URL` (override)  |
 * | `generate`                      | `SESSION_KEY`              | `NEXTAUTH_SECRET`          |
 * | `prompt`                        | — (runtime entries)        | `SMTP_PASSWORD`, `SUPPORT_EMAIL` |
 * | `value`                         | `BUILD_FLAG`               | `CALCOM_TELEMETRY_DISABLED` |
 * | `from: domains.primary.*`       | `NEXT_PUBLIC_WEBAPP_URL`   | `NEXTAUTH_URL`             |
 * | `from: deps.<kind>.<out>`       | `BUILD_DATABASE_URL`       | `DATABASE_URL`             |
 * | `from: platform.smtp.*`         | `BUILD_SMTP_HOST`          | `RELAY_HOST`               |
 * | `from: build.commitSha` / `components.*` | `BUILD_COMMIT`, `BUILD_INTERNAL_URL` | `APP_WEB_INTERNAL_URL` |
 * | `template`                      | `NEXTAUTH_URL`             | `DATABASE_HOST`, `SECRET_TEMPLATE` |
 *
 * Spec: FR-21…FR-27, FR-62; ACC-07-06, -09, -10, -13, -31, -33.
 */

const KEY = 'a'.repeat(64);
const WORK = '11111111-1111-4111-8111-111111111111';
const WORK_B = '22222222-2222-4222-8222-222222222222';
const DOMAIN_A = 'https://app-a.example.test';
const DOMAIN_B = 'https://app-b.example.test';
const COMMIT = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

/** Distinctive enough that "does it appear anywhere?" is a real question. */
const SECRET_VALUE = 's3cr3t-never-in-a-fingerprint';
const DB_PASSWORD = 'pg-1n-cluster-p4ss';
const SMTP_PASSWORD_VALUE = 'smtp-1n-cluster-p4ss';
const S3_SECRET = 's3-1n-cluster-s3cr3t';

/* -------------------------------------------------------------------------- *
 * The fixture — one entry per §2.2 row, in both phases
 * -------------------------------------------------------------------------- */

function fixtureEnv(): AppSpecEnvEntry[] {
    return [
        // ── generate ────────────────────────────────────────────────────────
        {
            name: 'NEXTAUTH_SECRET',
            secret: true,
            phase: 'both',
            description: 'Session encryption secret',
            generate: { kind: 'base64', bytes: 24, rotate: 'never' },
        },
        {
            name: 'SESSION_KEY',
            secret: true,
            phase: 'build',
            generate: { kind: 'base64', bytes: 32, rotate: 'never' },
        },
        { name: 'INSTANCE_ID', phase: 'both', generate: { kind: 'uuid', rotate: 'never' } },
        {
            name: 'VAPID_PRIVATE_KEY',
            secret: true,
            generate: {
                kind: 'keypair',
                keypair: { type: 'ed25519', format: 'pem' },
                rotate: 'never',
            },
        },
        // ── from: deps.<kind>.<out> ─────────────────────────────────────────
        { name: 'DATABASE_URL', secret: true, from: 'deps.postgres.url' },
        { name: 'BUILD_DATABASE_URL', secret: true, phase: 'build', from: 'deps.postgres.url' },
        { name: 'REDIS_URL', phase: 'build', from: 'deps.redis.url' },
        { name: 'S3_ENDPOINT', phase: 'build', from: 'deps.objectStorage.endpoint' },
        { name: 'S3_BUCKET', phase: 'build', from: 'deps.objectStorage.bucket.attachments' },
        {
            name: 'DATABASE_HOST',
            phase: 'both',
            template: '{{deps.postgres.host}}:{{deps.postgres.port}}',
        },
        // ── from: domains.primary.* / build.* / components.* ────────────────
        { name: 'NEXT_PUBLIC_WEBAPP_URL', phase: 'build', from: 'domains.primary.url' },
        { name: 'ARENA_HOST', from: 'domains.primary.host' },
        { name: 'NEXTAUTH_URL', phase: 'both', template: '{{domains.primary.url}}/api/auth' },
        { name: 'BUILD_COMMIT', phase: 'build', from: 'build.commitSha' },
        { name: 'BUILD_INTERNAL_URL', phase: 'build', from: 'components.web.internalUrl' },
        { name: 'APP_WEB_INTERNAL_URL', from: 'components.web.internalUrl' },
        // ── from: platform.smtp.* ───────────────────────────────────────────
        { name: 'BUILD_SMTP_HOST', phase: 'build', from: 'platform.smtp.host' },
        { name: 'RELAY_HOST', from: 'platform.smtp.host' },
        { name: 'MAIL_HOST', from: 'deps.smtp.host' },
        // ── prompt ──────────────────────────────────────────────────────────
        {
            name: 'SMTP_PASSWORD',
            secret: true,
            prompt: { description: 'SMTP password', required: true },
        },
        {
            name: 'SUPPORT_EMAIL',
            prompt: { description: 'Support email address', required: false },
        },
        // ── value ───────────────────────────────────────────────────────────
        { name: 'CALCOM_TELEMETRY_DISABLED', value: '1' },
        { name: 'BUILD_FLAG', phase: 'build', value: 'yes' },
        // ── template over env.<NAME> ────────────────────────────────────────
        {
            name: 'SECRET_TEMPLATE',
            secret: true,
            phase: 'both',
            template: 'v1-{{env.NEXTAUTH_SECRET}}',
        },
        { name: 'PUBLIC_LABEL', phase: 'both', template: 'id-{{env.INSTANCE_ID}}' },
        // ── a stored override of a derived entry ────────────────────────────
        { name: 'BUILD_OVERRIDE', phase: 'build', from: 'domains.primary.url' },
    ];
}

function fixtureSpec(): AppSpec {
    return {
        kind: 'app',
        appSpecVersion: 1,
        dependencies: {
            postgres: {},
            redis: {},
            objectStorage: { buckets: ['attachments'] },
            smtp: { required: false },
        },
        env: fixtureEnv(),
    };
}

/** Eleven `template` entries reading each other: the deepest one is past the bound. */
function depthSpec(): AppSpec {
    const env: AppSpecEnvEntry[] = [{ name: 'D01', value: 'x' }];
    for (let index = 2; index <= APP_ENV_TEMPLATE_MAX_DEPTH + 1; index += 1) {
        const previous = `D${String(index - 1).padStart(2, '0')}`;
        env.push({ name: `D${String(index).padStart(2, '0')}`, template: `{{env.${previous}}}-x` });
    }
    return { kind: 'app', appSpecVersion: 1, env };
}

/** A spec whose only entry is a `generate` one — the ensure-pass cases. */
function generateSpec(): AppSpec {
    return {
        kind: 'app',
        appSpecVersion: 1,
        env: [
            {
                name: 'NEXTAUTH_SECRET',
                secret: true,
                phase: 'both',
                generate: { kind: 'base64', bytes: 24, rotate: 'never' },
            },
        ],
    };
}

const BUILD_SERVICES: AppSpecBuildService[] = [
    { name: 'postgres', image: 'postgres:16' },
    { name: 'redis', image: 'redis:7' },
    { name: 'object-storage', image: 'minio/minio' },
    { name: 'smtp', image: 'mailhog/mailhog' },
];

/* -------------------------------------------------------------------------- *
 * The spec
 * -------------------------------------------------------------------------- */

describe('AppEnvResolver (T14, plan §2.2:110-150, §4.6:422-464)', () => {
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

    /** One stored `work_app_env_values` row, encrypted the production way. */
    async function store(
        name: string,
        value: string,
        options: {
            version?: number;
            origin?: 'user' | 'prompted' | 'generated' | 'derived';
            workId?: string;
        } = {},
    ): Promise<void> {
        await rows.insert({
            workId: options.workId ?? WORK,
            name,
            origin: options.origin ?? 'user',
            valueEncrypted: crypto.encrypt(value),
            valueBytes: Buffer.byteLength(value, 'utf8'),
            version: options.version ?? 1,
        });
    }

    /** One active `work_app_dependencies` row, its outputs encrypted the same way. */
    async function storeDependency(
        kind: string,
        options: {
            status?: string;
            providerId?: string;
            outputs?: Record<string, string>;
            outputsVersion?: number;
            deployTarget?: string;
        } = {},
    ): Promise<void> {
        await dependencyRows.insert({
            workId: WORK,
            kind: kind as never,
            deployTarget: (options.deployTarget ?? 'your-cluster') as never,
            providerPluginId: 'k8s',
            providerId: options.providerId ?? `k8s-inline-${kind}`,
            status: (options.status ?? 'ready') as never,
            declared: {},
            backupPolicy: 'none',
            outputsEncrypted: options.outputs
                ? crypto.encrypt(JSON.stringify(options.outputs))
                : null,
            outputsVersion: options.outputsVersion ?? 1,
        });
    }

    /**
     * The generated rows an App Work has by the time a Build or Deploy runs
     * (ACC-07-01: T15's listener generated them on `app.spec.applied`).
     */
    async function seedGenerated(): Promise<void> {
        await store('NEXTAUTH_SECRET', SECRET_VALUE, { origin: 'generated' });
        await store('SESSION_KEY', 'build-only-secret', { origin: 'generated' });
        await store('INSTANCE_ID', '11111111-2222-4333-8444-555555555555', { origin: 'generated' });
        await store('VAPID_PRIVATE_KEY', 'PRIVATE-PEM', { origin: 'generated' });
        await store('VAPID_PRIVATE_KEY_PUBLIC', 'PUBLIC-PEM', { origin: 'derived' });
    }

    /** The dependency outputs every "ready" fixture row carries. */
    function outputsFor(kind: string): Record<string, string> {
        if (kind === 'postgres') {
            return {
                url: `postgresql://ever_works:pw-${DB_PASSWORD}@pg.internal:5432/app`,
                directUrl: 'postgresql://pg.internal:5432/app',
                host: 'pg.internal',
                port: '5432',
                database: 'app',
                user: 'ever_works',
                password: DB_PASSWORD,
            };
        }
        if (kind === 'smtp') {
            return {
                host: 'smtp.mail.test',
                port: '587',
                user: 'relay-user',
                password: SMTP_PASSWORD_VALUE,
                from: 'no-reply@mail.test',
                secure: 'false',
            };
        }
        if (kind === 'objectStorage') {
            return {
                endpoint: 'https://s3.example.test',
                region: 'eu-central-1',
                accessKeyId: 'AKIA-TEST',
                secretAccessKey: S3_SECRET,
                'bucket.attachments': 'attachments',
            };
        }
        return {};
    }

    function specSource(spec: AppSpec = fixtureSpec()): AppEnvSpecSource & { read: jest.Mock } {
        const read = jest.fn(async () => ({ spec, specHash: 'hash-1', commitSha: COMMIT }));
        return { read };
    }

    function makeResolver(
        options: {
            spec?: AppEnvSpecSource | null;
            values?: WorkAppEnvValueRepository | null;
            rowsRepo?: Repository<WorkAppEnvValue> | null;
            crypto?: AppEnvCrypto | null;
            dependencyRowsRepo?: Repository<WorkAppDependency> | null;
            generatorPass?: AppEnvGeneratorPass | null;
        } = {},
    ): AppEnvResolver {
        const pick = <T>(value: T | null | undefined, fallback: T): T | undefined =>
            value === null ? undefined : (value ?? fallback);
        return new AppEnvResolver(
            pick(options.spec, specSource()),
            pick(options.values, valueRepository),
            pick(options.rowsRepo, rows),
            pick(options.crypto, crypto),
            pick(options.dependencyRowsRepo, dependencyRows),
            pick(options.generatorPass, undefined as never),
        );
    }

    /** A resolver wired to a spec, with nothing else changed. */
    function resolverFor(spec: AppSpec): AppEnvResolver {
        return makeResolver({ spec: specSource(spec) });
    }

    function value(result: AppEnvResolutionResult, name: string) {
        const found = result.values.find((entry) => entry.name === name);
        if (!found) {
            throw new Error(
                `no value ${name}; have ${result.values.map((entry) => entry.name).join(', ')}`,
            );
        }
        return found;
    }

    function unresolved(result: AppEnvResolutionResult, name: string) {
        const found = result.unresolved.find((entry) => entry.name === name);
        if (!found) {
            throw new Error(
                `no unresolved ${name}; have ${result.unresolved.map((entry) => entry.name).join(', ')}`,
            );
        }
        return found;
    }

    function names(result: AppEnvResolutionResult): string[] {
        return result.values.map((entry) => entry.name);
    }

    /* ---------------------------------------------------------------------- *
     * The sections
     * ---------------------------------------------------------------------- */

    describe('the build phase (plan §2.2:115-125, §4.6.2; ACC-07-10)', () => {
        it('resolves only build/both entries, and a build-phase deps.postgres.url to the build service (ACC-07-10)', async () => {
            const resolver = makeResolver();
            await seedGenerated();
            await store('BUILD_DATABASE_URL', 'postgresql://override@127.0.0.1:5432/app');

            const result = await resolver.resolveForBuild(WORK, BUILD_SERVICES, {
                primaryUrl: DOMAIN_A,
                commitSha: COMMIT,
            });

            // Only build-phase values reach a Build: every runtime-only entry is absent.
            expect(names(result).sort()).toEqual(
                [
                    'BUILD_COMMIT',
                    'BUILD_DATABASE_URL',
                    'BUILD_FLAG',
                    'BUILD_OVERRIDE',
                    'DATABASE_HOST',
                    'INSTANCE_ID',
                    'NEXTAUTH_SECRET',
                    'NEXTAUTH_URL',
                    'NEXT_PUBLIC_WEBAPP_URL',
                    'PUBLIC_LABEL',
                    'REDIS_URL',
                    'S3_BUCKET',
                    'S3_ENDPOINT',
                    'SECRET_TEMPLATE',
                    'SESSION_KEY',
                ].sort(),
            );
            expect(names(result)).not.toContain('DATABASE_URL');
            expect(names(result)).not.toContain('SMTP_PASSWORD');
            expect(names(result)).not.toContain('VAPID_PRIVATE_KEY');
            expect(names(result)).not.toContain('CALCOM_TELEMETRY_DISABLED');
            expect(unresolved(result, 'BUILD_SMTP_HOST').reason).toBe('notAvailableAtBuild');
            expect(unresolved(result, 'BUILD_INTERNAL_URL').reason).toBe('notAvailableAtBuild');
            // A stored override wins in the build phase too (§2.2:117).
            expect(value(result, 'BUILD_DATABASE_URL').value).toBe(
                'postgresql://override@127.0.0.1:5432/app',
            );
        });

        it('emits the §4.6.2 build-service outputs, with APW-05’s defaults and the service env (ACC-07-10)', async () => {
            const resolver = makeResolver();
            await seedGenerated();
            const defaults = await resolver.resolveForBuild(WORK, BUILD_SERVICES, {
                primaryUrl: DOMAIN_A,
                commitSha: COMMIT,
            });

            expect(value(defaults, 'BUILD_DATABASE_URL').value).toBe(
                'postgresql://ever-works-build:ever-works-build@127.0.0.1:5432/app?sslmode=disable',
            );
            expect(value(defaults, 'BUILD_DATABASE_URL').value).toMatch(
                /^postgresql:\/\/ever-works-build:.+@127\.0\.0\.1:5432\/app/,
            );
            expect(value(defaults, 'REDIS_URL').value).toBe('redis://127.0.0.1:6379/0');
            expect(value(defaults, 'S3_ENDPOINT').value).toBe('http://127.0.0.1:9000');
            expect(value(defaults, 'S3_BUCKET').value).toBe('attachments');
            // A template over deps resolves against the same build service.
            expect(value(defaults, 'DATABASE_HOST').value).toBe('127.0.0.1:5432');

            const withEnv = await makeResolver().resolveForBuild(
                WORK,
                [
                    {
                        name: 'postgres',
                        image: 'postgres:16',
                        port: 5433,
                        env: [
                            { name: 'POSTGRES_USER', value: 'build-user' },
                            { name: 'POSTGRES_PASSWORD', value: 'build-pw' },
                            { name: 'POSTGRES_DB', value: 'appdb' },
                        ],
                    },
                    {
                        name: 'object-storage',
                        image: 'minio/minio',
                        env: [
                            { name: 'MINIO_ROOT_USER', value: 'root-user' },
                            { name: 'MINIO_ROOT_PASSWORD', value: 'root-pw' },
                        ],
                    },
                ],
                { primaryUrl: DOMAIN_A, commitSha: COMMIT },
            );

            expect(value(withEnv, 'BUILD_DATABASE_URL').value).toBe(
                'postgresql://build-user:build-pw@127.0.0.1:5433/appdb?sslmode=disable',
            );
            // The entry is declared secret, so it is masked as one — but its VALUE
            // is a build artifact, and plan §2.2:141 gives a build-service value
            // its own fingerprint: sha256(value).
            expect(value(withEnv, 'BUILD_DATABASE_URL').secret).toBe(true);
            expect(value(withEnv, 'BUILD_DATABASE_URL').fingerprint).toBe(
                appEnvValueFingerprint(value(withEnv, 'BUILD_DATABASE_URL').value),
            );
        });

        it('reports noBuildService, noPrimaryDomain and notAvailableAtBuild for what a Build cannot see (FR-22)', async () => {
            const result = await makeResolver().resolveForBuild(WORK, [], { primaryUrl: null });

            expect(unresolved(result, 'BUILD_DATABASE_URL').reason).toBe('noBuildService');
            expect(unresolved(result, 'BUILD_DATABASE_URL').ref).toBe('deps.postgres.url');
            expect(unresolved(result, 'NEXT_PUBLIC_WEBAPP_URL').reason).toBe('noPrimaryDomain');
            expect(unresolved(result, 'BUILD_COMMIT').reason).toBe('notAvailableAtBuild');
            expect(unresolved(result, 'BUILD_SMTP_HOST').reason).toBe('notAvailableAtBuild');
            expect(unresolved(result, 'BUILD_INTERNAL_URL').reason).toBe('notAvailableAtBuild');
        });

        it('lets a stored override win over a build-phase derived value, in both phases (§2.2:117)', async () => {
            await store('BUILD_OVERRIDE', 'https://override.example.test');

            const result = await makeResolver().resolveForBuild(WORK, BUILD_SERVICES, {
                primaryUrl: DOMAIN_A,
                commitSha: COMMIT,
            });

            expect(value(result, 'BUILD_OVERRIDE').value).toBe('https://override.example.test');
            expect(value(result, 'BUILD_OVERRIDE').fingerprint).toBe('v1');
        });

        it('flips changedSinceBuild when the primary domain changes (ACC-07-13)', async () => {
            const resolver = makeResolver();
            const ctxA = { primaryUrl: DOMAIN_A, commitSha: COMMIT };
            const ctxB = { primaryUrl: DOMAIN_B, commitSha: COMMIT };

            const before = await resolver.resolveForBuild(WORK, BUILD_SERVICES, ctxA);
            const after = await resolver.resolveForBuild(WORK, BUILD_SERVICES, ctxB);

            // The derived build-phase entry's fingerprint is a hash of what it
            // resolved, so a new primary domain is a new fingerprint …
            expect(value(before, 'NEXT_PUBLIC_WEBAPP_URL').fingerprint).toBe(
                appEnvValueFingerprint(DOMAIN_A),
            );
            expect(value(after, 'NEXT_PUBLIC_WEBAPP_URL').fingerprint).toBe(
                appEnvValueFingerprint(DOMAIN_B),
            );
            expect(value(after, 'NEXT_PUBLIC_WEBAPP_URL').fingerprint).not.toBe(
                value(before, 'NEXT_PUBLIC_WEBAPP_URL').fingerprint,
            );

            // … and T13's own comparison rule turns that into the flag: `list`
            // marks an entry changed when its current fingerprint differs from
            // `WorkBuild.buildValueFingerprints` (app-env.service.ts:1804-1815).
            const recorded: Record<string, string> = {};
            for (const entry of before.values) recorded[entry.name] = entry.fingerprint;

            const fingerprintSource = {
                read: async (_workId: string, phase: 'build' | 'runtime') =>
                    phase === 'build'
                        ? (await resolver.resolveForBuild(WORK, BUILD_SERVICES, ctxB)).fingerprints
                        : {},
            };
            const service = new AppEnvService(
                valueRepository,
                rows,
                crypto,
                specSource(),
                undefined as never,
                { read: async () => recorded },
                undefined as never,
                fingerprintSource,
                undefined as never,
            );

            const unchanged = listEntry(
                await new AppEnvService(
                    valueRepository,
                    rows,
                    crypto,
                    specSource(),
                    undefined as never,
                    { read: async () => recorded },
                    undefined as never,
                    {
                        read: async () =>
                            (await resolver.resolveForBuild(WORK, BUILD_SERVICES, ctxA))
                                .fingerprints,
                    },
                    undefined as never,
                ).list(WORK),
                'NEXT_PUBLIC_WEBAPP_URL',
            );
            expect(unchanged.changedSinceBuild).toBe(false);

            const changed = listEntry(await service.list(WORK), 'NEXT_PUBLIC_WEBAPP_URL');
            expect(changed.changedSinceBuild).toBe(true);
        });
    });

    describe('the runtime phase — every §2.2 row', () => {
        it('resolves a stored override, a generated row and an undeclared-less prompt (§2.2:117-119)', async () => {
            await store('DATABASE_URL', 'postgresql://override-from-owner@pg.internal:5432/app');
            await store('NEXTAUTH_SECRET', SECRET_VALUE, { origin: 'generated', version: 7 });
            await store('SMTP_PASSWORD', SMTP_PASSWORD_VALUE, { origin: 'prompted', version: 3 });

            const result = await makeResolver().resolveRuntime(WORK, {
                target: 'your-cluster',
                primaryUrl: DOMAIN_A,
                internalUrls: { web: 'http://web.app.svc:3000' },
            });

            expect(value(result, 'DATABASE_URL').value).toBe(
                'postgresql://override-from-owner@pg.internal:5432/app',
            );
            expect(value(result, 'DATABASE_URL').fingerprint).toBe('v1');
            expect(value(result, 'DATABASE_URL').secret).toBe(true);
            expect(value(result, 'NEXTAUTH_SECRET').fingerprint).toBe('v7');
            expect(value(result, 'SMTP_PASSWORD').fingerprint).toBe('v3');
            expect(names(result)).not.toContain('SESSION_KEY');
        });

        it('omits an optional prompt and names a required one, with its description (ACC-07-09)', async () => {
            const result = await makeResolver().resolveRuntime(WORK, {
                target: 'your-cluster',
                primaryUrl: DOMAIN_A,
                internalUrls: { web: 'http://web.app.svc:3000' },
            });

            expect(unresolved(result, 'SMTP_PASSWORD').reason).toBe('missingRequired');
            expect(unresolved(result, 'SMTP_PASSWORD').ref).toBeNull();
            expect(result.missingRequired).toEqual([
                { name: 'SMTP_PASSWORD', description: 'SMTP password' },
            ]);
            // An optional prompt is simply absent: no value and no blockage.
            expect(names(result)).not.toContain('SUPPORT_EMAIL');
            expect(result.unresolved.map((entry) => entry.name)).not.toContain('SUPPORT_EMAIL');
        });

        it('reads a live dependency output with a d<outputsVersion> fingerprint (§2.2:122, :139)', async () => {
            await storeDependency('postgres', {
                outputs: outputsFor('postgres'),
                outputsVersion: 4,
            });

            const result = await makeResolver().resolveRuntime(WORK, { target: 'your-cluster' });

            expect(value(result, 'DATABASE_URL').value).toBe(
                `postgresql://ever_works:pw-${DB_PASSWORD}@pg.internal:5432/app`,
            );
            expect(value(result, 'DATABASE_URL').fingerprint).toBe('d4');
            expect(value(result, 'DATABASE_URL').secret).toBe(true);
            expect(value(result, 'DATABASE_HOST').value).toBe('pg.internal:5432');
        });

        it('blocks a reference to a dependency that is not ready (§2.2:122, FR-23)', async () => {
            await storeDependency('postgres', { status: 'provisioning', outputsVersion: 0 });

            const result = await makeResolver().resolveRuntime(WORK, { target: 'your-cluster' });

            expect(unresolved(result, 'DATABASE_URL').reason).toBe('dependencyNotReady');
            expect(unresolved(result, 'DATABASE_URL').ref).toBe('deps.postgres.url');
            expect(names(result)).not.toContain('DATABASE_URL');
        });

        it('resolves platform.smtp.* only when the relay provider serves smtp (§2.2:123)', async () => {
            await storeDependency('smtp', {
                providerId: 'platform-smtp-relay',
                outputs: outputsFor('smtp'),
                outputsVersion: 2,
            });

            const result = await makeResolver().resolveRuntime(WORK, { target: 'your-cluster' });

            expect(value(result, 'RELAY_HOST').value).toBe('smtp.mail.test');
            expect(value(result, 'RELAY_HOST').fingerprint).toBe('d2');
            expect(value(result, 'MAIL_HOST').value).toBe('smtp.mail.test');
        });

        it('resolves domains.primary.host, components.<n>.internalUrl and a template over env.<NAME> (§2.2:121, :124-125)', async () => {
            await seedGenerated();

            const result = await makeResolver().resolveRuntime(WORK, {
                target: 'your-cluster',
                primaryUrl: DOMAIN_A,
                primaryHost: 'app-a.example.test',
                internalUrls: { web: 'http://web.app.svc:3000' },
            });

            expect(value(result, 'ARENA_HOST').value).toBe('app-a.example.test');
            expect(value(result, 'NEXTAUTH_URL').value).toBe(`${DOMAIN_A}/api/auth`);
            expect(value(result, 'APP_WEB_INTERNAL_URL').value).toBe('http://web.app.svc:3000');
            expect(value(result, 'SECRET_TEMPLATE').value).toBe(`v1-${SECRET_VALUE}`);
            expect(value(result, 'PUBLIC_LABEL').value).toMatch(/^id-[0-9a-f-]{36}$/);
        });

        it('reports a missing component address and a missing primary domain instead of guessing (§2.2:121)', async () => {
            const result = await makeResolver().resolveRuntime(WORK, { target: 'your-cluster' });

            expect(unresolved(result, 'APP_WEB_INTERNAL_URL').reason).toBe('templateUnresolvable');
            expect(unresolved(result, 'ARENA_HOST').reason).toBe('noPrimaryDomain');
            expect(unresolved(result, 'RELAY_HOST').reason).toBe('relayNotSelected');
        });

        it('keeps an optional, unconfigured smtp dependency out of the resolved set with the smtpNotConfigured warning (ACC-07-33, FR-62)', async () => {
            await seedGenerated();
            await storeDependency('postgres', { outputs: outputsFor('postgres') });

            const result = await makeResolver().resolveRuntime(
                WORK,
                {
                    target: 'your-cluster',
                    primaryUrl: DOMAIN_A,
                    primaryHost: 'app-a.example.test',
                    internalUrls: { web: 'http://web.app.svc:3000' },
                },
                // What `ensureReadyForDeploy` answers for `smtp: { required: false }`
                // with no SMTP provider at all (`app-dependencies.service.ts:533-536`).
                { ready: true, notReady: [], optional: ['smtp'] },
            );

            expect(names(result)).not.toContain('MAIL_HOST');
            expect(names(result)).not.toContain('RELAY_HOST');
            expect(result.unresolved.map((entry) => entry.name)).not.toContain('MAIL_HOST');
            expect(result.warnings).toEqual(
                expect.arrayContaining([
                    { code: 'smtpNotConfigured', name: 'MAIL_HOST', ref: 'deps.smtp.host' },
                    { code: 'smtpNotConfigured', name: 'RELAY_HOST', ref: 'platform.smtp.host' },
                ]),
            );
            expect(result.missingRequired.map((entry) => entry.name)).toEqual(['SMTP_PASSWORD']);
        });

        it('still blocks when the App Work makes smtp required (FR-62, ACC-07-33)', async () => {
            const spec = fixtureSpec();
            spec.dependencies = { ...spec.dependencies, smtp: { required: true } };

            const result = await resolverFor(spec).resolveRuntime(WORK, {
                target: 'your-cluster',
                primaryUrl: DOMAIN_A,
            });

            expect(unresolved(result, 'MAIL_HOST').reason).toBe('dependencyNotReady');
            expect(unresolved(result, 'RELAY_HOST').reason).toBe('relayNotSelected');
            expect(result.warnings).toEqual([]);
        });

        it('fails closed with templateUnresolvable past depth 10 (§4.6.1:449)', async () => {
            const result = await resolverFor(depthSpec()).resolveRuntime(WORK, {
                target: 'your-cluster',
            });

            // Depth 10 is inside the bound and resolves …
            expect(
                value(result, `D${String(APP_ENV_TEMPLATE_MAX_DEPTH).padStart(2, '0')}`).value,
            ).toBe(
                `x-${Array.from({ length: APP_ENV_TEMPLATE_MAX_DEPTH - 1 }, () => 'x').join('-')}`,
            );
            // … and depth 11 is past it: the entry is unresolved, not resolved.
            expect(result.unresolved.map((entry) => entry.name)).toContain(
                `D${String(APP_ENV_TEMPLATE_MAX_DEPTH + 1).padStart(2, '0')}`,
            );
            expect(
                unresolved(result, `D${String(APP_ENV_TEMPLATE_MAX_DEPTH + 1).padStart(2, '0')}`)
                    .reason,
            ).toBe('templateUnresolvable');
        });

        it('fails a template cycle closed instead of hanging (§21:448)', async () => {
            const result = await resolverFor({
                kind: 'app',
                appSpecVersion: 1,
                env: [
                    { name: 'LOOP_A', template: 'a{{env.LOOP_B}}' },
                    { name: 'LOOP_B', template: 'b{{env.LOOP_A}}' },
                ],
            }).resolveRuntime(WORK, { target: 'your-cluster' });

            expect(unresolved(result, 'LOOP_A').reason).toBe('templateUnresolvable');
            expect(unresolved(result, 'LOOP_B').reason).toBe('templateUnresolvable');
        });

        it('carries the public half of a keypair as <NAME>_PUBLIC and never a private value (ACC-07-06)', async () => {
            await store('VAPID_PRIVATE_KEY', 'PRIVATE-PEM', { origin: 'generated', version: 5 });
            await store('VAPID_PRIVATE_KEY_PUBLIC', 'PUBLIC-PEM', {
                origin: 'derived',
                version: 6,
            });

            const result = await makeResolver().resolveRuntime(WORK, {
                target: 'your-cluster',
                primaryUrl: DOMAIN_A,
                internalUrls: { web: 'http://web.app.svc:3000' },
            });

            expect(value(result, 'VAPID_PRIVATE_KEY_PUBLIC').value).toBe('PUBLIC-PEM');
            expect(value(result, 'VAPID_PRIVATE_KEY_PUBLIC').secret).toBe(false);
            expect(value(result, 'VAPID_PRIVATE_KEY_PUBLIC').fingerprint).toBe('v6');
            expect(value(result, 'VAPID_PRIVATE_KEY').secret).toBe(true);
            expect(value(result, 'VAPID_PRIVATE_KEY').fingerprint).toBe('v5');
        });

        it('reports a keypair whose public half is missing, rather than shipping half a pair', async () => {
            await store('VAPID_PRIVATE_KEY', 'PRIVATE-PEM', { origin: 'generated', version: 5 });

            const result = await makeResolver().resolveRuntime(WORK, { target: 'your-cluster' });

            expect(unresolved(result, 'VAPID_PRIVATE_KEY_PUBLIC').reason).toBe('missingRequired');
        });
    });

    describe('fingerprints — the §2.2 rule (ACC-07-13)', () => {
        it('keys the map exactly like values, and never gives a value to an unresolved item (§2.2:129, :143)', async () => {
            await store('SMTP_PASSWORD', SMTP_PASSWORD_VALUE, { origin: 'prompted' });
            await storeDependency('postgres', { status: 'failed' });

            const result = await makeResolver().resolveRuntime(WORK, {
                target: 'your-cluster',
                primaryUrl: DOMAIN_A,
            });

            expect(Object.keys(result.fingerprints).sort()).toEqual(
                result.values.map((entry) => entry.name).sort(),
            );
            for (const item of result.unresolved) {
                expect(Object.keys(item).sort()).toEqual(['name', 'reason', 'ref']);
                expect(item).not.toHaveProperty('value');
            }
            expect(JSON.stringify(result.unresolved)).not.toContain(DOMAIN_A);
            expect(result.unresolved.length).toBeGreaterThan(0);
        });

        it('gives v<version> to a stored value, d<outputsVersion> to a live output and sha256 to a non-secret one', async () => {
            await store('NEXTAUTH_SECRET', SECRET_VALUE, { origin: 'generated', version: 3 });
            await storeDependency('postgres', {
                outputs: outputsFor('postgres'),
                outputsVersion: 9,
            });

            const result = await makeResolver().resolveRuntime(WORK, {
                target: 'your-cluster',
                primaryUrl: DOMAIN_A,
            });

            expect(value(result, 'NEXTAUTH_SECRET').fingerprint).toBe('v3');
            expect(value(result, 'DATABASE_URL').fingerprint).toBe('d9');
            expect(value(result, 'CALCOM_TELEMETRY_DISABLED').fingerprint).toBe(
                appEnvValueFingerprint('1'),
            );
        });

        it('uses t<sha256(…)> for a secret template, follows its inputs, and never hashes a secret value', async () => {
            await store('NEXTAUTH_SECRET', SECRET_VALUE, { origin: 'generated', version: 3 });

            const result = await makeResolver().resolveRuntime(WORK, { target: 'your-cluster' });
            const secretTemplate = value(result, 'SECRET_TEMPLATE');

            expect(secretTemplate.fingerprint).toMatch(/^t[0-9a-f]{64}$/);
            expect(secretTemplate.fingerprint).toBe(
                appEnvSecretFingerprint('v1-{{env.NEXTAUTH_SECRET}}', [
                    { placeholder: '{{env.NEXTAUTH_SECRET}}', fingerprint: 'v3' },
                ]),
            );

            // A new input fingerprint is a new template fingerprint (FR-24).
            await rows.update({ workId: WORK, name: 'NEXTAUTH_SECRET' }, { version: 4 });
            const after = await makeResolver().resolveRuntime(WORK, { target: 'your-cluster' });
            expect(value(after, 'SECRET_TEMPLATE').fingerprint).not.toBe(
                secretTemplate.fingerprint,
            );

            // No sha256 of a secret value exists anywhere in the map (FR-5, §2.2:143).
            const secretHash = appEnvValueFingerprint(SECRET_VALUE);
            expect(Object.values(after.fingerprints)).not.toContain(secretHash);
            expect(JSON.stringify(after.fingerprints)).not.toContain(SECRET_VALUE);
        });

        it('never reduces a secret entry to a bare sha256 of its value (§2.2:140-141)', async () => {
            await storeDependency('smtp', {
                providerId: 'platform-smtp-relay',
                outputs: outputsFor('smtp'),
            });
            await store('SECRET_FROM_RELAY', 'derived-secret', { origin: 'user' });

            const result = await makeResolver().resolveRuntime(WORK, { target: 'your-cluster' });
            const secretHash = appEnvValueFingerprint(SECRET_VALUE);

            for (const entry of result.values) {
                if (!entry.secret) continue;
                expect(entry.fingerprint).not.toBe(secretHash);
                expect(entry.fingerprint).toMatch(/^(v\d+|d\d+|t[0-9a-f]{64})$/);
            }
        });
    });

    describe('the deploy target decides the placeholder (plan §4.6.1:436-437, §4.11:694-696)', () => {
        it('emits ew-dep:// tokens and reads no output on the managed tier', async () => {
            await storeDependency('postgres', {
                outputs: outputsFor('postgres'),
                outputsVersion: 3,
            });

            const result = await makeResolver().resolveRuntime(WORK, {
                target: 'ever-works-apps',
            });

            expect(value(result, 'DATABASE_URL').value).toBe('ew-dep://postgres/url');
            expect(value(result, 'DATABASE_HOST').value).toBe(
                'ew-dep://postgres/host:ew-dep://postgres/port',
            );
            expect(value(result, 'RELAY_HOST').value).toBe('ew-dep://smtp/host');
            expect(JSON.stringify(result.values)).not.toContain(DB_PASSWORD);
            expect(JSON.stringify(result.values)).not.toContain(SMTP_PASSWORD_VALUE);
            expect(value(result, 'DATABASE_URL').secret).toBe(true);
            expect(result.egress).toEqual([]);
        });

        it('decides from ctx.target, never from the stored row (APW06-G08)', async () => {
            await storeDependency('postgres', {
                outputs: outputsFor('postgres'),
                deployTarget: 'ever-works-apps',
            });

            const local = await makeResolver().resolveRuntime(WORK, { target: 'your-cluster' });
            expect(value(local, 'DATABASE_URL').value).toContain('pg.internal');
            expect(value(local, 'DATABASE_URL').value).not.toContain('ew-dep://');

            await dependencyRows.update(
                { workId: WORK, kind: 'postgres' },
                { deployTarget: 'your-cluster' },
            );
            const managed = await makeResolver().resolveRuntime(WORK, {
                target: 'ever-works-apps',
            });
            expect(value(managed, 'DATABASE_URL').value).toBe('ew-dep://postgres/url');
        });
    });

    describe('egress — the destinations APW-06 opens (§4.6.1:434-435)', () => {
        it('lists the external providers’ hosts and ports, and nothing in-cluster', async () => {
            await storeDependency('postgres', {
                providerId: 'k8s-inline-postgres',
                outputs: outputsFor('postgres'),
            });
            await storeDependency('smtp', {
                providerId: 'smtp-external',
                outputs: outputsFor('smtp'),
            });
            await storeDependency('objectStorage', {
                providerId: 's3-external',
                outputs: outputsFor('objectStorage'),
            });

            const result = await makeResolver().resolveRuntime(WORK, { target: 'your-cluster' });

            expect(result.egress).toEqual([
                { host: 's3.example.test', ports: [443] },
                { host: 'smtp.mail.test', ports: [587] },
            ]);
        });

        it('ignores a dependency that is not ready', async () => {
            await storeDependency('smtp', {
                providerId: 'smtp-external',
                status: 'failed',
                outputs: outputsFor('smtp'),
            });

            const result = await makeResolver().resolveRuntime(WORK, { target: 'your-cluster' });

            expect(result.egress).toEqual([]);
        });
    });

    describe('the generate pass and stored-read failures (plan §4.2:366, §9.2:949-950)', () => {
        it('runs ensureGenerated once at the start of a resolve and then reads the row it wrote', async () => {
            const ensureGenerated = jest.fn(async () => {
                await store('NEXTAUTH_SECRET', SECRET_VALUE, { origin: 'generated' });
                return { created: [{ name: 'NEXTAUTH_SECRET' }] };
            });
            const resolver = makeResolver({
                spec: specSource(generateSpec()),
                generatorPass: { ensureGenerated },
            });

            const result = await resolver.resolveForBuild(WORK, [], { primaryUrl: DOMAIN_A });

            expect(ensureGenerated).toHaveBeenCalledTimes(1);
            expect(ensureGenerated).toHaveBeenCalledWith(WORK);
            expect(value(result, 'NEXTAUTH_SECRET').value).toBe(SECRET_VALUE);
            expect(value(result, 'NEXTAUTH_SECRET').fingerprint).toBe('v1');
        });

        it('fails closed when a generated value has no row and no pass is bound', async () => {
            const result = await resolverFor(generateSpec()).resolveForBuild(WORK, [], {
                primaryUrl: DOMAIN_A,
            });

            expect(unresolved(result, 'NEXTAUTH_SECRET').reason).toBe('missingRequired');
            expect(result.missingRequired).toEqual([]);
        });

        it('refuses the whole resolution when a stored value cannot be decrypted (plan §9.2:950)', async () => {
            await rows.insert({
                workId: WORK,
                name: 'NEXTAUTH_SECRET',
                origin: 'generated',
                // Another installation's envelope: no key of ours opens it.
                valueEncrypted: 'enc::v1::not-our-envelope',
                valueBytes: 12,
                version: 1,
            });

            await expect(
                makeResolver().resolveRuntime(WORK, { target: 'your-cluster' }),
            ).rejects.toMatchObject({ code: 'secureStorageUnavailable', status: 503 });
        });
    });

    describe('ephemeral mode (R-10, ACC-07-31)', () => {
        it('generates fresh values from ctx.dependencyOutputs and stores nothing', async () => {
            const resolver = makeResolver();
            const ctx = {
                target: 'cluster' as const,
                primaryUrl: DOMAIN_A,
                internalUrls: { web: 'http://web.app.svc:3000' },
                dependencyOutputs: { postgres: outputsFor('postgres') },
            };

            const first = await resolver.resolveEphemeralForCluster(WORK, ctx);
            const second = await resolver.resolveEphemeralForCluster(WORK, ctx);

            expect(first.values.DATABASE_URL).toBe(
                `postgresql://ever_works:pw-${DB_PASSWORD}@pg.internal:5432/app`,
            );
            expect(first.values.NEXTAUTH_SECRET).toBeTruthy();
            expect(second.values.NEXTAUTH_SECRET).not.toBe(first.values.NEXTAUTH_SECRET);
            expect(first.values.VAPID_PRIVATE_KEY_PUBLIC).toMatch(/BEGIN PUBLIC KEY/);
            // Nothing was written, and no stored generated value was read.
            expect(await rows.count()).toBe(0);
            expect(await dependencyRows.count()).toBe(0);
        });

        it('reports a required prompted entry with no stored value and blocks a missing output (ACC-07-31)', async () => {
            const result = await makeResolver().resolveEphemeralForCluster(WORK, {
                target: 'cluster',
                dependencyOutputs: {},
            });

            expect(result.unsetRequired).toEqual(['SMTP_PASSWORD']);
            expect(result.unresolved.find((entry) => entry.name === 'DATABASE_URL')?.reason).toBe(
                'dependencyNotReady',
            );
        });

        it('builds a value-free runner recipe on the container grammar of §4.6.1:447', async () => {
            const recipe = await makeResolver().buildRunnerRecipe(WORK, { target: 'runner' });
            const byName = new Map(recipe.recipe.map((entry) => [entry.name, entry]));

            expect(byName.get('NEXTAUTH_SECRET')).toMatchObject({
                source: 'generate',
                secret: true,
                spec: { kind: 'base64', bytes: 24 },
            });
            expect(byName.get('CALCOM_TELEMETRY_DISABLED')).toMatchObject({
                source: 'literal',
                secret: false,
                spec: { value: '1' },
            });
            expect(byName.get('SMTP_PASSWORD')).toMatchObject({
                source: 'prompted',
                spec: { required: true },
            });
            expect(byName.get('DATABASE_URL')).toMatchObject({
                source: 'template',
                secret: true,
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
            expect(byName.get('REDIS_URL')).toMatchObject({
                source: 'template',
                spec: { text: 'redis://redis:6379/0', tokens: [] },
            });
            expect(byName.get('S3_ENDPOINT')).toMatchObject({
                spec: { text: 'http://object-storage:9000', tokens: [] },
            });
            expect(byName.get('S3_BUCKET')).toMatchObject({ spec: { text: 'attachments' } });
            expect(byName.get('DATABASE_HOST')).toMatchObject({
                // A template over two container outputs the grammar knows: both
                // placeholders are substituted, and no token is left to resolve.
                spec: { text: 'postgres:5432', tokens: [] },
            });
            expect(byName.get('SECRET_TEMPLATE')).toMatchObject({
                spec: {
                    text: 'v1-{{gen:NEXTAUTH_SECRET}}',
                    tokens: [
                        {
                            kind: 'gen',
                            name: 'NEXTAUTH_SECRET',
                            placeholder: '{{gen:NEXTAUTH_SECRET}}',
                        },
                    ],
                },
            });
            expect(recipe.unsetRequired).toEqual(['SMTP_PASSWORD']);
        });

        it('never puts a generated or stored secret into the recipe', async () => {
            await store('NEXTAUTH_SECRET', SECRET_VALUE, { origin: 'generated' });
            await store('SMTP_PASSWORD', SMTP_PASSWORD_VALUE, { origin: 'prompted' });

            const recipe = await makeResolver().buildRunnerRecipe(WORK, { target: 'runner' });
            const serialized = JSON.stringify(recipe.recipe);

            expect(serialized).not.toContain(SECRET_VALUE);
            expect(serialized).not.toContain(SMTP_PASSWORD_VALUE);
            expect(serialized).not.toContain('enc::v1::');
        });
    });

    describe('read — T13’s change-flag input (FR-24)', () => {
        it('answers the phase’s fingerprint map, and null when the spec cannot be read', async () => {
            await store('NEXTAUTH_SECRET', SECRET_VALUE, { origin: 'generated', version: 2 });
            await storeDependency('postgres', {
                outputs: outputsFor('postgres'),
                outputsVersion: 2,
            });

            const resolver = makeResolver();
            const runtime = await resolver.read(WORK, 'runtime');
            const build = await resolver.read(WORK, 'build');

            expect(runtime?.NEXTAUTH_SECRET).toBe('v2');
            expect(runtime?.DATABASE_URL).toBe('d2');
            expect(build?.NEXTAUTH_SECRET).toBe('v2');
            expect(build?.DATABASE_URL).toBeUndefined();

            const unreadable = makeResolver({
                spec: { read: jest.fn(async () => null) },
            });
            expect(await unreadable.read(WORK, 'runtime')).toEqual({});
        });

        it('fingerprints the build phase against the spec’s own build.services, so the verdict hash can equal the prepare hash (FR-24)', async () => {
            // The two terms of §5.1's `staleInputs` clause for a Work whose build
            // env references a build service:
            //  - the prepare runner resolves with `spec.build.services`
            //    (`app-build-prepare.runner.ts` `resolveBuildValues`) and the plugin
            //    hashes EVERY value it is handed (`secret-sync.ts`
            //    `computeBuildInputsHash`), build-service ones included;
            //  - the verdict reads `read(workId, 'build')` through
            //    `AppBuildsService.readCurrentInputs` and hashes that map.
            // Resolved against an empty service list, the build-service references
            // were `noBuildService` and left the map, so the two hashes could never
            // match and every such Build was `staleInputs`.
            const spec: AppSpec = {
                ...fixtureSpec(),
                build: { strategy: 'dockerfile', services: BUILD_SERVICES },
            };
            await seedGenerated();
            const resolver = resolverFor(spec);

            const prepared = await resolver.resolveForBuild(WORK, spec.build?.services ?? []);
            const current = await resolver.read(WORK, 'build');

            expect(current).not.toBeNull();
            expect(current?.BUILD_DATABASE_URL).toBe(
                value(prepared, 'BUILD_DATABASE_URL').fingerprint,
            );
            expect(current?.REDIS_URL).toBe(value(prepared, 'REDIS_URL').fingerprint);
            expect(current?.S3_ENDPOINT).toBe(value(prepared, 'S3_ENDPOINT').fingerprint);
            expect(computeCurrentInputsHash(fingerprintsToValues(current ?? {}))).toBe(
                computeBuildInputsHash(
                    prepared.values.map((entry) => ({
                        name: entry.name,
                        fingerprint: entry.fingerprint,
                    })),
                ),
            );
        });

        it('answers another App Work’s names as unset, never as this Work’s values', async () => {
            await store('NEXTAUTH_SECRET', SECRET_VALUE, {
                origin: 'generated',
                version: 2,
                workId: WORK_B,
            });

            const result = await makeResolver().resolveRuntime(WORK, { target: 'your-cluster' });

            expect(names(result)).not.toContain('NEXTAUTH_SECRET');
            expect(unresolved(result, 'NEXTAUTH_SECRET').reason).toBe('missingRequired');
        });

        it('still reads the stored values when T8’s metadata repository is unbound', async () => {
            await store('NEXTAUTH_SECRET', SECRET_VALUE, { origin: 'generated', version: 4 });

            const result = await makeResolver({ values: null }).resolveRuntime(WORK, {
                target: 'your-cluster',
            });

            expect(value(result, 'NEXTAUTH_SECRET').value).toBe(SECRET_VALUE);
            expect(value(result, 'NEXTAUTH_SECRET').fingerprint).toBe('v4');
        });
    });

    describe('the build-service output table (pure, plan §4.6.2:455-462)', () => {
        it('emits every declared bucket and the RFC 2606 smtp placeholder', () => {
            const outputs = buildServiceOutputs({ buckets: ['a', 'b'] }, 'objectStorage', {
                name: 'object-storage',
                image: 'minio/minio',
            });
            expect(outputs['bucket.a']).toBe('a');
            expect(outputs['bucket.b']).toBe('b');
            expect(outputs.region).toBe('us-east-1');
            expect(outputs.accessKeyId).toBe('ever-works-build');

            const smtp = buildServiceOutputs({ buckets: [] }, 'smtp', {
                name: 'smtp',
                image: 'mailhog/mailhog',
            });
            expect(smtp).toMatchObject({
                host: '127.0.0.1',
                port: '1025',
                from: 'build@example.invalid',
                secure: 'false',
            });
        });

        it('derives the secrecy of a relay output from the contract’s own table (FR-40)', () => {
            expect(isAppDependencyOutputSecret('smtp', 'password')).toBe(true);
            expect(isAppDependencyOutputSecret('smtp', 'host')).toBe(false);
        });
    });
});

/** One entry of `AppEnvService.list`, by name. */
function listEntry(entries: readonly AppEnvEntryView[], name: string): AppEnvEntryView {
    const found = entries.find((entry) => entry.name === name);
    if (!found) {
        throw new Error(`no entry ${name}; have ${entries.map((entry) => entry.name).join(', ')}`);
    }
    return found;
}
