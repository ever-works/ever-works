import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import {
    APP_ENV_TOTAL_MAX_BYTES,
    APP_ENV_VALUE_MAX_BYTES,
    appEnvPublicHalfName,
    type AppEnvEntryView,
    type AppSpec,
    type AppSpecEnvEntry,
} from '@ever-works/contracts';
import { WorkAppEnvValue } from '../../entities/work-app-env-value.entity';
import { ENTITIES } from '../../database/_entities-inventory';
import { WorkAppEnvValueRepository } from '../../database/repositories/work-app-env-value.repository';
import { PluginSecretEncService } from '../../plugins/services/plugin-secret-enc.service';
import { AppEnvCrypto } from '../app-env-crypto';
import { parseAppEnvDotenv } from '../dotenv-parser.js';
import {
    APP_ENV_SPEC_SOURCE,
    AppEnvService,
    isAppEnvRefusalError,
    summarizeAppEnvEntries,
    type AppEnvActivity,
    type AppEnvActorNames,
    type AppEnvApplyResult,
    type AppEnvApplyResultItem,
    type AppEnvSpecSource,
} from '../app-env.service';

/**
 * APW-07 T13 — `AppEnvService`, the Environment table's own service.
 *
 * Plan §4.2 (`plan.md:361-375`) is the contract of record and this spec walks
 * its every row: `list`, `ensureGenerated`, `apply` (set / unset / reset /
 * import with per-item results), `rotate`, `missingRequired`, `buildRedactor`.
 * Spec: FR-1…FR-31, S1 (`spec.md:90-94`), S5 (`spec.md:104-107`), S15, S17,
 * S21; ACC-07-01, -03, -07, -08, -09, -11, -12, -13.
 *
 * ## Why a real database and a real envelope
 *
 * The idempotence proof of ACC-07-03 is a claim about what is **stored**, so
 * this spec runs the production path: an in-memory better-sqlite3 DataSource
 * (the default `DATABASE_TYPE`, the CI driver and the whole e2e stack — the
 * same choice `database/repositories/__tests__/work-app-env-value.repository.spec.ts`
 * makes), T8's own repository and T9's own `AppEnvCrypto` over a real
 * `enc::v1::` envelope. "Nothing changed" is then asserted twice:
 *
 *   1. every generated row's `version` **and** stored envelope (plus its
 *      `updatedAt`, `valueBytes` and `generatorFingerprint`) are compared
 *      before and after four more generation passes; and
 *   2. the two write doors of T8's repository are spies over the REAL methods,
 *      so a write that happened is a call count that moved — the strongest form
 *      §4.2's "insert-or-ignore, re-read" contract allows.
 *
 * ## What is faked, and why
 *
 * APW-03's `AppSpecService`, APW-05's `WorkBuild.buildValueFingerprints`,
 * APW-06's `appRender.envFingerprints`, T14's resolver fingerprints, T26's
 * activity writer and APW-01's member directory do not exist in this tree, so
 * each is one of the `@Optional()` seams `app-env.service.ts` declares — this
 * spec binds them as fakes and asserts the fail-closed answer of every one that
 * is left unbound. T12's `.env` parser IS landed and is exercised through its
 * own frozen API (`parseAppEnvDotenv`).
 *
 * The one thing this spec does NOT prove is dependency-injection wiring —
 * `app-env.module.ts` exists for that and is covered by T24's controller spec.
 */

const KEY = 'a'.repeat(64);
const WORK = '11111111-1111-4111-8111-111111111111';
const WORK_B = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const OTHER_USER = '44444444-4444-4444-8444-444444444444';

/** Distinctive enough that "does it appear anywhere?" is a real question. */
const SECRET_A = 's3cr3t-A-value-that-must-never-render';
const SECRET_B = 's3cr3t-B-value-that-must-never-render-either';
const SHORT_VALUE = 'AAAAA';

/** The 12-line import fixture of ACC-07-11 — read as the spec's own data. */
const IMPORT_FIXTURE = readFileSync(join(__dirname, 'fixtures', 'import-12-lines.env'), 'utf8');

/* -------------------------------------------------------------------------- *
 * The S1 fixture — 18 entries: 6 generated, 5 derived, 3 prompted (2 required),
 * 4 defaults (`spec.md:90-94`).
 * -------------------------------------------------------------------------- */

function fixtureEnv(): AppSpecEnvEntry[] {
    return [
        // ── 6 generated ─────────────────────────────────────────────────────
        {
            name: 'NEXTAUTH_SECRET',
            secret: true,
            phase: 'both',
            description: 'Session encryption secret',
            generate: { kind: 'base64', bytes: 24, rotate: 'never' },
        },
        {
            name: 'CRON_SECRET',
            secret: true,
            generate: { kind: 'hex', bytes: 32, rotate: 'never' },
        },
        {
            name: 'CALENDSO_ENCRYPTION_KEY',
            secret: true,
            phase: 'both',
            generate: { kind: 'chars', length: 40, rotate: 'never' },
            validate: { length: 40, pattern: '[A-Za-z0-9]{40}' },
        },
        { name: 'INSTANCE_ID', generate: { kind: 'uuid', rotate: 'never' } },
        {
            name: 'VAPID_PRIVATE_KEY',
            secret: true,
            description: 'Web-push private key',
            generate: {
                kind: 'keypair',
                keypair: { type: 'ed25519', format: 'pem' },
                rotate: 'never',
            },
        },
        {
            name: 'SESSION_KEY',
            secret: true,
            phase: 'build',
            generate: { kind: 'base64', bytes: 32, rotate: 'never' },
            validate: { length: 44 },
        },
        // ── 5 derived ───────────────────────────────────────────────────────
        { name: 'DATABASE_URL', secret: true, from: 'deps.postgres.url' },
        { name: 'DATABASE_HOST', template: '{{deps.postgres.host}}:{{deps.postgres.port}}' },
        { name: 'NEXT_PUBLIC_WEBAPP_URL', phase: 'build', from: 'domains.primary.url' },
        { name: 'NEXTAUTH_URL', template: '{{domains.primary.url}}/api/auth' },
        { name: 'APP_WEB_INTERNAL_URL', from: 'components.web.internalUrl' },
        // ── 3 prompted, 2 of them required ──────────────────────────────────
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
        // ── 4 defaults ──────────────────────────────────────────────────────
        { name: 'CALCOM_TELEMETRY_DISABLED', value: '1' },
        { name: 'TURBO_TELEMETRY_DISABLED', value: '1' },
        { name: 'TZ', value: 'UTC' },
        { name: 'GOOGLE_LOGIN_ENABLED', value: 'false' },
    ];
}

/** The S1 App spec, with only the field under test changed. */
function fixtureSpec(options: { base64Bytes?: number; extra?: AppSpecEnvEntry[] } = {}): AppSpec {
    const env = fixtureEnv();
    if (options.base64Bytes !== undefined) {
        env[0] = {
            ...env[0],
            generate: { kind: 'base64', bytes: options.base64Bytes, rotate: 'never' },
        };
    }
    return { kind: 'app', appSpecVersion: 1, env: [...env, ...(options.extra ?? [])] };
}

/** One-entry App specs for the cases that need no fixture. */
function specWithEnv(...entries: AppSpecEnvEntry[]): AppSpec {
    return { kind: 'app', appSpecVersion: 1, env: entries };
}

/** A spec source that answers one spec until a test replaces it. */
function specSource(
    spec: AppSpec = fixtureSpec(),
    specHash = 'hash-1',
): AppEnvSpecSource & { read: jest.Mock } {
    const read = jest.fn(async () => ({ spec, specHash, commitSha: 'commit-1' }));
    return { read };
}

describe('AppEnvService (T13, plan §4.2:361-370)', () => {
    let dataSource: DataSource;
    let repository: WorkAppEnvValueRepository;
    let rows: Repository<WorkAppEnvValue>;
    let crypto: AppEnvCrypto;
    let activity: AppEnvActivity & { emit: jest.Mock };
    let insertSpy: jest.SpyInstance;
    let upsertSpy: jest.SpyInstance;
    let deleteSpy: jest.SpyInstance;
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
        // The owning Work row is not what is under test; the FK itself is
        // asserted in `apps/api/.../CreateAppEnvAndDependencies.spec.ts`.
        await dataSource.query('PRAGMA foreign_keys = OFF');

        repository = new WorkAppEnvValueRepository(dataSource.getRepository(WorkAppEnvValue));
        rows = dataSource.getRepository(WorkAppEnvValue);
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
        jest.restoreAllMocks();
        // The warn/error lines of the fail-closed cases are the service doing its
        // job; they carry names and codes only, and are silenced for readability.
        jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        // Spies over the REAL write doors: the original implementation still
        // runs, so a call count is a write that actually happened.
        insertSpy = jest.spyOn(repository, 'insertIfAbsent');
        upsertSpy = jest.spyOn(repository, 'upsertValue');
        deleteSpy = jest.spyOn(repository, 'deleteNames');
        activity = { emit: jest.fn(async () => undefined) };
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    /** One service, with every seam bound unless a case says otherwise. */
    function makeService(
        options: {
            values?: WorkAppEnvValueRepository | null;
            rows?: Repository<WorkAppEnvValue> | null;
            crypto?: AppEnvCrypto | null;
            spec?: AppEnvSpecSource | null;
            activity?: AppEnvActivity | null;
            builds?: { read: (workId: string) => Promise<Record<string, string> | null> } | null;
            deployments?: {
                read: (workId: string) => Promise<Record<string, string> | null>;
            } | null;
            resolved?: {
                read: (
                    workId: string,
                    phase: 'build' | 'runtime',
                ) => Promise<Record<string, string> | null>;
            } | null;
            actorNames?: AppEnvActorNames | null;
        } = {},
    ): AppEnvService {
        const pick = <T>(value: T | null | undefined, fallback: T): T | undefined =>
            value === null ? undefined : (value ?? fallback);
        return new AppEnvService(
            pick(options.values, repository),
            pick(options.rows, rows),
            pick(options.crypto, crypto),
            pick(options.spec, specSource()),
            pick(options.activity, activity),
            pick(options.builds, undefined as never),
            pick(options.deployments, undefined as never),
            pick(options.resolved, undefined as never),
            pick(options.actorNames, undefined as never),
        );
    }

    const actor = (userId: string = USER, name = 'Maya') => ({ userId, name });

    function entry(entries: readonly AppEnvEntryView[], name: string): AppEnvEntryView {
        const found = entries.find((candidate) => candidate.name === name);
        if (!found) {
            throw new Error(`no entry ${name} in ${entries.map((e) => e.name).join(', ')}`);
        }
        return found;
    }

    function item(result: AppEnvApplyResult, name: string): AppEnvApplyResultItem {
        const found = result.results.find((candidate) => candidate.name === name);
        if (!found) {
            throw new Error(`no result for ${name}: ${JSON.stringify(result.results)}`);
        }
        return found;
    }

    function stored(name: string, workId: string = WORK): Promise<WorkAppEnvValue | null> {
        return rows.findOne({ where: { workId, name } });
    }

    /** What a stored row must not change for ACC-07-03 to hold. */
    async function snapshot(workId: string = WORK) {
        const all = await rows.find({ where: { workId }, order: { name: 'ASC' } });
        return all.map((row) => ({
            name: row.name,
            origin: row.origin,
            version: row.version,
            valueEncrypted: row.valueEncrypted,
            valueBytes: row.valueBytes,
            generatorFingerprint: row.generatorFingerprint ?? null,
            derivedFromName: row.derivedFromName ?? null,
            generatedAt: row.generatedAt ? row.generatedAt.getTime() : null,
            updatedAt: row.updatedAt ? row.updatedAt.getTime() : null,
        }));
    }

    /** Seed `count` undeclared rows straight into the table (the FR-31 ceilings). */
    async function seedRows(count: number, valueBytes: number, prefix = 'PAD_'): Promise<void> {
        await rows.insert(
            Array.from({ length: count }, (_, index) => ({
                workId: WORK,
                name: `${prefix}${String(index).padStart(3, '0')}`,
                origin: 'user' as const,
                valueEncrypted: `enc::v1::${'x'.repeat(48)}`,
                valueBytes,
                version: 1,
                setByUserId: USER,
            })),
        );
    }

    /** Is the table empty? — ACC-07-12's "zero rows written". */
    async function empty(): Promise<boolean> {
        return (await rows.count()) === 0;
    }

    /* ---------------------------------------------------------------------- *
     * S1 — the Environment table after the App spec lands
     * ---------------------------------------------------------------------- */

    describe('S1 — the Environment table after the App spec lands', () => {
        it('generates the six generated values and lists all 18 entries (ACC-07-01)', async () => {
            const service = makeService();

            const generated = await service.ensureGenerated(WORK);
            expect(generated.reason).toBeUndefined();
            expect(generated.created.map((created) => created.name).sort()).toEqual([
                'CALENDSO_ENCRYPTION_KEY',
                'CRON_SECRET',
                'INSTANCE_ID',
                'NEXTAUTH_SECRET',
                'SESSION_KEY',
                'VAPID_PRIVATE_KEY',
            ]);

            const entries = await service.list(WORK, actor());
            expect(entries).toHaveLength(18);
            for (const created of generated.created) {
                expect(entry(entries, created.name)).toMatchObject({
                    declared: true,
                    origin: 'generated',
                    set: true,
                });
            }
            expect(summarizeAppEnvEntries(entries)).toMatchObject({
                total: 18,
                set: 6 + 4, // the six generated rows and the four App spec literals
                missingRequired: 2,
                missingRequiredBuild: 1, // only LICENSE_KEY is a build-phase entry
            });
        });

        it('stores each generated value at the length its generator declares (ACC-07-01)', async () => {
            const service = makeService();
            await service.ensureGenerated(WORK);

            const lengths: Record<string, number> = {
                NEXTAUTH_SECRET: 32, // base64 of 24 bytes
                CRON_SECRET: 64, // hex of 32 bytes
                CALENDSO_ENCRYPTION_KEY: 40, // chars 40
                INSTANCE_ID: 36, // uuid
                SESSION_KEY: 44, // base64 of 32 bytes
            };
            for (const [name, expected] of Object.entries(lengths)) {
                const row = await stored(name);
                expect(row).not.toBeNull();
                expect(crypto.decrypt(row!.valueEncrypted)).toHaveLength(expected);
                expect(row!.valueBytes).toBe(
                    Buffer.byteLength(crypto.decrypt(row!.valueEncrypted)),
                );
            }

            const keypair = await stored('VAPID_PRIVATE_KEY');
            expect(crypto.decrypt(keypair!.valueEncrypted)).toMatch(/^-----BEGIN PRIVATE KEY-----/);
        });

        it('stores the keypair public half as a derived row and folds it into the keypair entry (FR-15)', async () => {
            const service = makeService();
            await service.ensureGenerated(WORK);

            const publicRow = await stored(appEnvPublicHalfName('VAPID_PRIVATE_KEY'));
            expect(publicRow).toMatchObject({
                origin: 'derived',
                derivedFromName: 'VAPID_PRIVATE_KEY',
            });
            expect(crypto.decrypt(publicRow!.valueEncrypted)).toMatch(
                /^-----BEGIN PUBLIC KEY-----/,
            );

            const entries = await service.list(WORK, actor());
            expect(entries.map((candidate) => candidate.name)).not.toContain(
                appEnvPublicHalfName('VAPID_PRIVATE_KEY'),
            );
            expect(entry(entries, 'VAPID_PRIVATE_KEY').publicValue).toMatch(
                /^-----BEGIN PUBLIC KEY-----/,
            );
            expect(entries).toHaveLength(18);
        });

        it('reports the two required prompted entries with their descriptions (ACC-07-09)', async () => {
            const service = makeService();

            const missing = await service.missingRequired(WORK, 'runtime');
            expect(missing).toEqual([
                { name: 'LICENSE_KEY', description: 'Your license key' },
                { name: 'SMTP_PASSWORD', description: 'SMTP password' },
            ]);
            // Phase is part of the question: SMTP_PASSWORD is runtime-only, so a
            // Build is not blocked by it (FR-26).
            expect(await service.missingRequired(WORK, 'build')).toEqual([
                { name: 'LICENSE_KEY', description: 'Your license key' },
            ]);

            const entries = await service.list(WORK, actor());
            expect(entry(entries, 'SMTP_PASSWORD')).toMatchObject({
                required: true,
                set: false,
                origin: 'prompted',
                source: 'prompt',
                description: 'SMTP password',
            });
            expect(entry(entries, 'SUPPORT_EMAIL')).toMatchObject({ required: false, set: false });
        });

        it('orders by prompt group, then required-and-unset, then name (FR-1)', async () => {
            const service = makeService({
                spec: specSource(
                    specWithEnv(
                        { name: 'ZZZ_LAST', value: 'x' },
                        {
                            name: 'B_GROUPED',
                            prompt: { description: 'grouped', required: true, group: 'Mail' },
                        },
                        {
                            name: 'A_GROUPED',
                            prompt: { description: 'grouped', required: true, group: 'Mail' },
                        },
                        { name: 'A_MISSING', prompt: { description: 'required', required: true } },
                        { name: 'C_SET', prompt: { description: 'optional', required: false } },
                    ),
                ),
            });
            await service.apply(WORK, actor(), { set: [{ name: 'C_SET', value: 'set-value' }] });

            const order = (await service.list(WORK, actor())).map((candidate) => candidate.name);
            expect(order).toEqual(['A_MISSING', 'C_SET', 'ZZZ_LAST', 'A_GROUPED', 'B_GROUPED']);
        });

        it('never puts a stored value in the view except the keypair public half (FR-5)', async () => {
            const service = makeService();
            await service.ensureGenerated(WORK);
            await service.apply(WORK, actor(), {
                set: [
                    { name: 'SMTP_PASSWORD', value: SECRET_A },
                    { name: 'FOO', value: SECRET_B },
                ],
            });

            const entries = await service.list(WORK, actor());
            const serialized = JSON.stringify(entries);
            for (const row of await rows.find({ where: { workId: WORK } })) {
                const value = crypto.decrypt(row.valueEncrypted);
                if (row.origin === 'derived') {
                    continue; // the keypair public half is FR-15's one exception
                }
                expect(serialized).not.toContain(value);
            }
            // …and the exception really is exposed, JSON-escaped and all.
            expect(serialized).toContain(
                JSON.stringify(entry(entries, 'VAPID_PRIVATE_KEY').publicValue).slice(1, -1),
            );
            expect(entry(entries, 'FOO')).toMatchObject({
                declared: false,
                source: 'undeclared',
                origin: 'user',
                set: true,
            });
        });

        it('reports an unresolved actor without inventing a name', async () => {
            const service = makeService();
            await service.apply(WORK, actor(USER, 'Maya'), {
                set: [{ name: 'SMTP_PASSWORD', value: SECRET_A }],
            });

            const entries = await service.list(WORK, actor(USER, 'Maya'));
            expect(entry(entries, 'SMTP_PASSWORD').updatedBy).toEqual({
                userId: USER,
                name: 'Maya',
            });
            expect(entry(entries, 'SMTP_PASSWORD').updatedAt).toEqual(expect.any(String));

            // A row set by somebody else: with no directory bound, the row keeps
            // its actor id and NO name rather than rendering a uuid as a person.
            const other = await service.list(WORK, actor(OTHER_USER, 'Sam'));
            expect(entry(other, 'SMTP_PASSWORD').updatedBy).toEqual({ userId: USER, name: null });

            // APW-01's directory is the seam that fills it in (`APP_ENV_ACTOR_NAMES`).
            const named = makeService({
                actorNames: {
                    nameOf: async (_workId, userId) => (userId === USER ? 'Maya' : null),
                },
            });
            expect(
                entry(await named.list(WORK, actor(OTHER_USER, 'Sam')), 'SMTP_PASSWORD').updatedBy,
            ).toEqual({ userId: USER, name: 'Maya' });
        });
    });

    /* ---------------------------------------------------------------------- *
     * ACC-07-03 — a generated value is never regenerated implicitly (FR-12)
     * ---------------------------------------------------------------------- */

    describe('ensureGenerated idempotence (ACC-07-03, FR-12)', () => {
        it('leaves every version and envelope unchanged across re-apply, rebuild, redeploy and upstream sync', async () => {
            const service = makeService();
            const first = await service.ensureGenerated(WORK);
            expect(first.created).toHaveLength(6);
            expect(insertSpy).toHaveBeenCalledTimes(7); // six values + one public half
            const before = await snapshot();

            // The four events of FR-12 — an App spec re-apply, a rebuild, a
            // redeploy and an upstream sync — all reach generation the same way
            // (`ensureGenerated` is called by the listener and at the start of
            // every resolve), so each is one more pass here.
            for (const pass of ['re-apply', 'rebuild', 'redeploy', 'upstream-sync']) {
                const again = await service.ensureGenerated(WORK);
                expect({ pass, created: again.created }).toEqual({ pass, created: [] });
            }

            expect(await snapshot()).toEqual(before);
            // The strongest form: the write doors of T8's repository were not
            // entered at all after the first pass.
            expect(insertSpy).toHaveBeenCalledTimes(7);
            expect(upsertSpy).not.toHaveBeenCalled();
            expect(deleteSpy).not.toHaveBeenCalled();
        });

        it('is idempotent for a Work that already holds the rows when it is first called', async () => {
            const first = makeService();
            await first.ensureGenerated(WORK);
            const before = await snapshot();

            // A second SERVICE instance, as a redeploy of the API would build:
            // the guard is the table, never process memory.
            const second = makeService();
            const again = await second.ensureGenerated(WORK);

            expect(again.created).toEqual([]);
            expect(await snapshot()).toEqual(before);
            expect(insertSpy).toHaveBeenCalledTimes(7);
        });

        it('refuses to overwrite a row another caller has just written (ACC-07-02)', async () => {
            const service = makeService();
            await repository.insertIfAbsent({
                workId: WORK,
                name: 'NEXTAUTH_SECRET',
                origin: 'generated',
                valueEncrypted: crypto.encrypt(SECRET_A),
                valueBytes: Buffer.byteLength(SECRET_A),
                generatorFingerprint: 'base64:24',
                generatedAt: new Date(),
            });

            const result = await service.ensureGenerated(WORK);

            expect(result.created.map((candidate) => candidate.name)).not.toContain(
                'NEXTAUTH_SECRET',
            );
            const row = await stored('NEXTAUTH_SECRET');
            expect(crypto.decrypt(row!.valueEncrypted)).toBe(SECRET_A);
        });
    });

    /* ---------------------------------------------------------------------- *
     * generatorChanged — the resolved spec, never the contract's bare default
     * ---------------------------------------------------------------------- */

    describe('generatorChanged (FR-12)', () => {
        it('flags generatorChanged after the App spec bytes change, and keeps the value', async () => {
            const source = specSource(fixtureSpec());
            const service = makeService({ spec: source });
            await service.ensureGenerated(WORK);
            const before = await snapshot();

            source.read.mockResolvedValue({
                spec: fixtureSpec({ base64Bytes: 32 }),
                specHash: 'hash-2',
                commitSha: 'commit-2',
            });

            const entries = await service.list(WORK, actor());
            expect(entry(entries, 'NEXTAUTH_SECRET').generatorChanged).toBe(true);
            expect(entry(entries, 'CRON_SECRET').generatorChanged).toBe(false);
            expect(entry(entries, 'NEXTAUTH_SECRET').generator).toMatchObject({
                kind: 'base64',
                rotate: 'never',
            });

            // A re-apply never regenerates implicitly (FR-12).
            await service.ensureGenerated(WORK);
            expect(await snapshot()).toEqual(before);
        });

        it('fingerprints the RESOLVED spec: an omitted bytes is 32, not the contract default of 16', async () => {
            const service = makeService({
                spec: specSource(
                    specWithEnv({
                        name: 'PLAIN_SECRET',
                        secret: true,
                        generate: { kind: 'base64', rotate: 'never' },
                    }),
                ),
            });

            const generated = await service.ensureGenerated(WORK);
            expect(generated.created).toEqual([
                { name: 'PLAIN_SECRET', version: 1, fingerprint: 'base64:32', publicName: null },
            ]);

            // …and the fingerprint describes the value beside it: base64 of the
            // App spec's default 32 bytes is 44 characters, not the 24 that
            // `base64:16` would describe.
            const row = await stored('PLAIN_SECRET');
            expect(crypto.decrypt(row!.valueEncrypted)).toHaveLength(44);
            expect((await service.list(WORK, actor()))[0].generatorChanged).toBe(false);
        });

        it('flags generatorChanged when a defaulted length changes', async () => {
            const source = specSource(
                specWithEnv({
                    name: 'CHARS_SECRET',
                    secret: true,
                    generate: { kind: 'chars', rotate: 'never' },
                }),
            );
            const service = makeService({ spec: source });
            await service.ensureGenerated(WORK);
            expect((await stored('CHARS_SECRET'))!.generatorFingerprint).toBe('chars:32:alnum');

            source.read.mockResolvedValue({
                spec: specWithEnv({
                    name: 'CHARS_SECRET',
                    secret: true,
                    generate: { kind: 'chars', length: 40, alphabet: 'hex-lower', rotate: 'never' },
                }),
                specHash: 'hash-2',
                commitSha: 'commit-2',
            });
            expect(entry(await service.list(WORK, actor()), 'CHARS_SECRET').generatorChanged).toBe(
                true,
            );
        });
    });

    /* ---------------------------------------------------------------------- *
     * compare-only flags — plan §2.2:132-150
     * ---------------------------------------------------------------------- */

    describe('changedSinceBuild / changedSinceDeploy (§2.2:132-150, FR-24)', () => {
        it('compares a build entry against a recorded Build map and a run entry against the Deployment', async () => {
            const service = makeService({
                builds: {
                    read: async () => ({
                        NEXTAUTH_SECRET: 'v1',
                        SESSION_KEY: 'v9',
                        DATABASE_URL: 'd3',
                    }),
                },
                deployments: {
                    // Present-and-equal, present-and-equal, present-and-different:
                    // the three arms a recorded map can produce for a stored row.
                    read: async () => ({
                        NEXTAUTH_SECRET: 'v1',
                        CALENDSO_ENCRYPTION_KEY: 'v1',
                        CRON_SECRET: 'v7',
                    }),
                },
            });
            await service.ensureGenerated(WORK);
            const entries = await service.list(WORK, actor());

            expect(entry(entries, 'NEXTAUTH_SECRET')).toMatchObject({
                changedSinceBuild: false,
                changedSinceDeploy: false,
            });
            expect(entry(entries, 'SESSION_KEY').changedSinceBuild).toBe(true);
            expect(entry(entries, 'CALENDSO_ENCRYPTION_KEY').changedSinceDeploy).toBe(false);
            expect(entry(entries, 'CRON_SECRET').changedSinceDeploy).toBe(true);
            // INSTANCE_ID is runtime-only: a Build never carries it, so its build
            // flag stays false however the map looks.
            expect(entry(entries, 'INSTANCE_ID').changedSinceBuild).toBe(false);
            // DATABASE_URL is in the Build map but its phase is runtime, so it is
            // not a build entry at all; and it is derived with nothing bound, so
            // an entry with no fingerprint gives false (§2.2:148-150).
            expect(entry(entries, 'DATABASE_URL')).toMatchObject({
                phase: 'runtime',
                changedSinceBuild: false,
                changedSinceDeploy: false,
            });
        });

        it('marks a derived build entry changed when the resolver fingerprints have moved (ACC-07-13)', async () => {
            const project = (url: string) => ({
                read: async () => ({ NEXT_PUBLIC_WEBAPP_URL: `sha256:${url}` }),
            });
            const service = makeService({
                builds: { read: async () => ({ NEXT_PUBLIC_WEBAPP_URL: 'sha256:https://old' }) },
                resolved: project('https://old'),
            });
            const entries = await service.list(WORK, actor());
            expect(entry(entries, 'NEXT_PUBLIC_WEBAPP_URL').changedSinceBuild).toBe(false);

            const moved = makeService({
                builds: { read: async () => ({ NEXT_PUBLIC_WEBAPP_URL: 'sha256:https://old' }) },
                resolved: project('https://new'),
            });
            const after = await moved.list(WORK, actor());
            expect(entry(after, 'NEXT_PUBLIC_WEBAPP_URL').changedSinceBuild).toBe(true);
            // …and the flag never carried a value.
            expect(JSON.stringify(entry(after, 'NEXT_PUBLIC_WEBAPP_URL'))).not.toContain(
                'https://new',
            );
        });

        it('gives false rather than a guess when no Build, Deployment or resolver map exists', async () => {
            const service = makeService({
                builds: { read: async () => null },
                deployments: { read: async () => null },
            });
            await service.ensureGenerated(WORK);

            for (const candidate of await service.list(WORK, actor())) {
                expect({
                    name: candidate.name,
                    changedSinceBuild: candidate.changedSinceBuild,
                    changedSinceDeploy: candidate.changedSinceDeploy,
                }).toEqual({
                    name: candidate.name,
                    changedSinceBuild: false,
                    changedSinceDeploy: false,
                });
            }
        });
    });

    /* ---------------------------------------------------------------------- *
     * apply — set / unset / reset
     * ---------------------------------------------------------------------- */

    describe('apply — set, unset and reset', () => {
        it('stores a prompted value as prompted and reports it with its version', async () => {
            const service = makeService();

            const result = await service.apply(WORK, actor(), {
                set: [{ name: 'SMTP_PASSWORD', value: SECRET_A }],
            });

            expect(item(result, 'SMTP_PASSWORD')).toMatchObject({
                action: 'set',
                version: 1,
                line: null,
                code: null,
            });
            expect(result.changed).toEqual(['SMTP_PASSWORD']);
            const row = await stored('SMTP_PASSWORD');
            expect(row).toMatchObject({ origin: 'prompted', version: 1, setByUserId: USER });
            expect(row!.valueEncrypted).not.toContain(SECRET_A);
            expect(crypto.decrypt(row!.valueEncrypted)).toBe(SECRET_A);
            expect(entry(await service.list(WORK, actor()), 'SMTP_PASSWORD')).toMatchObject({
                set: true,
                origin: 'prompted',
            });
        });

        it('stores a value on a from entry as an override and reset restores the App spec (FR-3)', async () => {
            const service = makeService();

            const set = await service.apply(WORK, actor(), {
                set: [{ name: 'DATABASE_URL', value: SECRET_A }],
            });
            expect(item(set, 'DATABASE_URL').action).toBe('set');
            expect(entry(await service.list(WORK, actor()), 'DATABASE_URL')).toMatchObject({
                declared: true,
                source: 'from',
                reference: 'deps.postgres.url',
                origin: 'user',
                overrides: 'derived',
                set: true,
            });

            const reset = await service.apply(WORK, actor(), { reset: ['DATABASE_URL'] });
            expect(item(reset, 'DATABASE_URL')).toMatchObject({ action: 'reset', code: null });
            expect(await stored('DATABASE_URL')).toBeNull();
            expect(entry(await service.list(WORK, actor()), 'DATABASE_URL')).toMatchObject({
                origin: 'derived',
                overrides: null,
                set: false,
            });
        });

        it('overrides a value literal and resets back to the App spec (FR-3)', async () => {
            const service = makeService();

            await service.apply(WORK, actor(), { set: [{ name: 'TZ', value: 'Europe/Berlin' }] });
            expect(entry(await service.list(WORK, actor()), 'TZ')).toMatchObject({
                origin: 'user',
                overrides: 'default',
                specValue: null,
                set: true,
            });

            await service.apply(WORK, actor(), { reset: ['TZ'] });
            expect(entry(await service.list(WORK, actor()), 'TZ')).toMatchObject({
                origin: 'default',
                overrides: null,
                specValue: 'UTC',
                set: true,
            });
        });

        it('unset removes a prompted row and does nothing at all to a generated one (FR-13)', async () => {
            const service = makeService();
            await service.ensureGenerated(WORK);
            const generatedBefore = await snapshot();
            await service.apply(WORK, actor(), {
                set: [{ name: 'SMTP_PASSWORD', value: SECRET_A }],
            });

            const result = await service.apply(WORK, actor(), {
                unset: ['SMTP_PASSWORD', 'NEXTAUTH_SECRET', 'NEVER_SET_AT_ALL'],
            });

            expect(item(result, 'SMTP_PASSWORD')).toMatchObject({ action: 'unset' });
            expect(item(result, 'NEXTAUTH_SECRET')).toMatchObject({
                action: 'skipped',
                code: 'generatedValueUseRotate',
            });
            expect(item(result, 'NEVER_SET_AT_ALL').action).toBe('skipped');
            expect(await stored('SMTP_PASSWORD')).toBeNull();
            expect(await snapshot()).toEqual(generatedBefore);
        });

        it('reset on a name that is not an override changes nothing', async () => {
            const service = makeService();
            await service.ensureGenerated(WORK);

            const result = await service.apply(WORK, actor(), {
                reset: ['NEXTAUTH_SECRET', 'SMTP_PASSWORD'],
            });

            expect(result.results.every((candidate) => candidate.action === 'skipped')).toBe(true);
            expect(result.changed).toEqual([]);
            expect(deleteSpy).not.toHaveBeenCalled();
        });

        it('treats a cleared field as unset — the envelope cannot carry an empty value', async () => {
            const service = makeService();
            await service.apply(WORK, actor(), {
                set: [{ name: 'SMTP_PASSWORD', value: SECRET_A }],
            });

            const cleared = await service.apply(WORK, actor(), {
                set: [{ name: 'SMTP_PASSWORD', value: '' }],
            });

            expect(item(cleared, 'SMTP_PASSWORD')).toMatchObject({ action: 'unset', code: null });
            expect(await stored('SMTP_PASSWORD')).toBeNull();
        });

        it('refuses a generated name with generatedValueUseRotate (S17)', async () => {
            const service = makeService();
            await service.ensureGenerated(WORK);

            const result = await service.apply(WORK, actor(), {
                set: [{ name: 'NEXTAUTH_SECRET', value: SECRET_A }],
            });

            expect(item(result, 'NEXTAUTH_SECRET')).toMatchObject({
                action: 'refused',
                code: 'generatedValueUseRotate',
            });
            expect((await stored('NEXTAUTH_SECRET'))!.version).toBe(1);
            expect(upsertSpy).not.toHaveBeenCalled();
        });

        it('refuses a keypair entry and its <NAME>_PUBLIC half even with both confirmations', async () => {
            const service = makeService();
            await service.ensureGenerated(WORK);
            const before = await snapshot();

            const keypair = await service.apply(WORK, actor(), {
                set: [{ name: 'VAPID_PRIVATE_KEY', value: SECRET_A }],
                replaceGenerated: true,
                acknowledgeNeverRotate: true,
            });
            expect(item(keypair, 'VAPID_PRIVATE_KEY')).toMatchObject({
                action: 'refused',
                code: 'generatedValueUseRotate',
            });

            const half = await service.apply(WORK, actor(), {
                set: [{ name: 'VAPID_PRIVATE_KEY_PUBLIC', value: SECRET_A }],
                replaceGenerated: true,
                acknowledgeNeverRotate: true,
            });
            expect(item(half, 'VAPID_PRIVATE_KEY_PUBLIC')).toMatchObject({
                action: 'refused',
                code: 'generatedValueUseRotate',
            });

            expect(await snapshot()).toEqual(before);
        });

        it('replaces a generated value only with replaceGenerated AND acknowledgeNeverRotate', async () => {
            const service = makeService();
            await service.ensureGenerated(WORK);

            const unacknowledged = await service.apply(WORK, actor(), {
                set: [{ name: 'NEXTAUTH_SECRET', value: SECRET_A }],
                replaceGenerated: true,
            });
            expect(item(unacknowledged, 'NEXTAUTH_SECRET').code).toBe('neverRotateNotAcknowledged');

            const replaced = await service.apply(WORK, actor(), {
                set: [{ name: 'NEXTAUTH_SECRET', value: SECRET_A }],
                replaceGenerated: true,
                acknowledgeNeverRotate: true,
            });
            expect(item(replaced, 'NEXTAUTH_SECRET')).toMatchObject({ action: 'set', version: 2 });
            const row = await stored('NEXTAUTH_SECRET');
            expect(crypto.decrypt(row!.valueEncrypted)).toBe(SECRET_A);
            expect(row!.origin).toBe('user');
        });

        it('refuses EVER_WORKS_X as reserved and bad-name as invalid (ACC-07-08)', async () => {
            const service = makeService();

            const result = await service.apply(WORK, actor(), {
                set: [
                    { name: 'EVER_WORKS_X', value: SECRET_A },
                    { name: 'bad-name', value: SECRET_A },
                ],
            });

            expect(item(result, 'EVER_WORKS_X')).toMatchObject({
                action: 'refused',
                code: 'reservedName',
            });
            expect(item(result, 'bad-name')).toMatchObject({
                action: 'refused',
                code: 'invalidName',
            });
            expect(upsertSpy).not.toHaveBeenCalled();
            expect(await empty()).toBe(true);
        });

        it('refuses a 44-character value for length 32 with the stated message (ACC-07-07)', async () => {
            const service = makeService({
                spec: specSource(
                    specWithEnv({
                        name: 'CALENDSO_ENCRYPTION_KEY',
                        secret: true,
                        generate: { kind: 'chars', length: 32, rotate: 'never' },
                        validate: { length: 32 },
                    }),
                ),
            });

            const result = await service.apply(WORK, actor(), {
                set: [{ name: 'CALENDSO_ENCRYPTION_KEY', value: 'x'.repeat(44) }],
                replaceGenerated: true,
                acknowledgeNeverRotate: true,
            });

            const refused = item(result, 'CALENDSO_ENCRYPTION_KEY');
            expect(refused.code).toBe('lengthMismatch');
            expect(refused.message).toBe(
                '`CALENDSO_ENCRYPTION_KEY` must be exactly 32 characters (this one has 44).',
            );
            expect(refused.message).not.toContain('x'.repeat(44));
            expect(await empty()).toBe(true);
        });

        it('refuses a 65,537-byte value as valueTooLarge (ACC-07-08)', async () => {
            const service = makeService();

            const result = await service.apply(WORK, actor(), {
                set: [{ name: 'SMTP_PASSWORD', value: 'x'.repeat(APP_ENV_VALUE_MAX_BYTES + 1) }],
            });

            expect(item(result, 'SMTP_PASSWORD').code).toBe('valueTooLarge');
            expect(await empty()).toBe(true);
        });

        it('refuses the 301st stored value with tooManyValues (FR-31)', async () => {
            const service = makeService();
            await seedRows(300, 1);

            const result = await service.apply(WORK, actor(), {
                set: [{ name: 'SMTP_PASSWORD', value: SECRET_A }],
            });

            expect(item(result, 'SMTP_PASSWORD')).toMatchObject({
                action: 'refused',
                code: 'tooManyValues',
            });
            expect(await stored('SMTP_PASSWORD')).toBeNull();
            expect(upsertSpy).not.toHaveBeenCalled();
        });

        it('refuses 1 MiB + 1 byte with valuesTooLarge (FR-31)', async () => {
            const service = makeService();
            // 16 × 65,536 bytes is exactly FR-31's ceiling.
            await seedRows(16, APP_ENV_VALUE_MAX_BYTES, 'BIG_');
            expect(APP_ENV_VALUE_MAX_BYTES * 16).toBe(APP_ENV_TOTAL_MAX_BYTES);

            const result = await service.apply(WORK, actor(), {
                set: [{ name: 'SMTP_PASSWORD', value: 'x' }],
            });

            expect(item(result, 'SMTP_PASSWORD')).toMatchObject({
                action: 'refused',
                code: 'valuesTooLarge',
            });
            expect(await stored('SMTP_PASSWORD')).toBeNull();
        });

        it('counts a replaced value against the byte ceiling by its delta only', async () => {
            const service = makeService();
            await seedRows(16, APP_ENV_VALUE_MAX_BYTES, 'BIG_');

            // Replacing an existing row frees its bytes: one of the seeded rows
            // is dropped and 1 byte is stored in the same call.
            const result = await service.apply(WORK, actor(), {
                unset: ['BIG_000'],
                set: [{ name: 'SMTP_PASSWORD', value: 'x' }],
            });

            expect(item(result, 'SMTP_PASSWORD').action).toBe('set');
            expect(await stored('SMTP_PASSWORD')).not.toBeNull();
        });

        it('emits one app.env.changed carrying names and actions only (FR-8)', async () => {
            const service = makeService();

            const result = await service.apply(WORK, actor(), {
                set: [
                    { name: 'SMTP_PASSWORD', value: SECRET_A },
                    { name: 'FOO', value: SECRET_B },
                ],
                unset: ['NEXTAUTH_SECRET'],
            });

            expect(activity.emit).toHaveBeenCalledTimes(1);
            const event = activity.emit.mock.calls[0][0];
            expect(event).toMatchObject({
                actionType: 'app_env',
                action: 'app.env.changed',
                status: 'completed',
                details: { names: ['SMTP_PASSWORD', 'FOO'], actions: ['set'] },
            });
            const serialized = JSON.stringify(event);
            expect(serialized).not.toContain(SECRET_A);
            expect(serialized).not.toContain(SECRET_B);
            expect(result.activityRecorded).toBe(true);
        });

        it('records nothing in Activity when nothing changed, and says so when no writer is bound', async () => {
            const service = makeService();
            await service.apply(WORK, actor(), { reset: ['SMTP_PASSWORD'] });
            expect(activity.emit).not.toHaveBeenCalled();

            const unbound = makeService({ activity: null });
            const result = await unbound.apply(WORK, actor(), {
                set: [{ name: 'SMTP_PASSWORD', value: SECRET_A }],
            });
            expect(result.changed).toEqual(['SMTP_PASSWORD']);
            expect(result.activityRecorded).toBe(false);
        });

        it('refuses the whole call with secureStorageUnavailable and writes zero rows without a key (ACC-07-12)', async () => {
            const previous = process.env.PLUGIN_SECRET_ENCRYPTION_KEY;
            delete process.env.PLUGIN_SECRET_ENCRYPTION_KEY;
            try {
                const keyless = makeService({
                    crypto: new AppEnvCrypto(new PluginSecretEncService()),
                });

                await expect(
                    keyless.apply(WORK, actor(), {
                        set: [{ name: 'SMTP_PASSWORD', value: SECRET_A }],
                    }),
                ).rejects.toMatchObject({ code: 'secureStorageUnavailable', status: 503 });
                await expect(keyless.ensureGenerated(WORK)).resolves.toMatchObject({
                    created: [],
                    reason: 'secureStorageUnavailable',
                });

                expect(await empty()).toBe(true);
                expect(insertSpy).not.toHaveBeenCalled();
                expect(upsertSpy).not.toHaveBeenCalled();
            } finally {
                process.env.PLUGIN_SECRET_ENCRYPTION_KEY = previous;
            }
        });

        it('changes nothing and reports specUnavailable when the App spec cannot be read', async () => {
            const service = makeService({ spec: { read: async () => null } });

            const applied = await service.apply(WORK, actor(), {
                set: [{ name: 'SMTP_PASSWORD', value: SECRET_A }],
            });
            expect(applied).toMatchObject({ reason: 'specUnavailable', changed: [] });
            await expect(service.ensureGenerated(WORK)).resolves.toMatchObject({
                created: [],
                reason: 'specUnavailable',
            });
            await expect(service.list(WORK, actor())).resolves.toEqual([]);
            expect(await service.missingRequired(WORK, 'runtime')).toEqual([]);
            expect(await empty()).toBe(true);
        });

        it('reports storeUnavailable when the value store is not bound', async () => {
            const service = makeService({ values: null, rows: null });

            // The App spec still declares all 18 entries — nothing that needs a
            // ROW is set (the four `value` literals are "set" by the spec itself,
            // which is exactly what `set: true` means for a literal) — and no
            // public half can be read. That is the fail-closed direction.
            const entries = await service.list(WORK, actor());
            expect(entries).toHaveLength(18);
            expect(
                entries
                    .filter((candidate) => candidate.source !== 'value')
                    .every((candidate) => candidate.set === false),
            ).toBe(true);
            expect(entries.every((candidate) => candidate.publicValue === null)).toBe(true);
            await expect(
                service.apply(WORK, actor(), { set: [{ name: 'SMTP_PASSWORD', value: SECRET_A }] }),
            ).resolves.toMatchObject({ reason: 'storeUnavailable', changed: [] });
            await expect(service.ensureGenerated(WORK)).resolves.toMatchObject({
                created: [],
                reason: 'storeUnavailable',
            });
            await expect(service.buildRedactor(WORK)).rejects.toMatchObject({
                code: 'secureStorageUnavailable',
            });
        });

        it('keeps another App Work’s values out of every answer', async () => {
            const service = makeService();
            await service.apply(WORK_B, actor(), {
                set: [{ name: 'SMTP_PASSWORD', value: SECRET_A }],
            });

            const result = await service.apply(WORK, actor(), {
                unset: ['SMTP_PASSWORD'],
            });
            expect(item(result, 'SMTP_PASSWORD').action).toBe('skipped');
            expect(await stored('SMTP_PASSWORD', WORK_B)).not.toBeNull();
        });
    });

    /* ---------------------------------------------------------------------- *
     * apply — import (ACC-07-11, S5, S17, FR-28…FR-30)
     * ---------------------------------------------------------------------- */

    describe('apply — import', () => {
        it('imports the 12-line fixture: 9 set, 2 created with the warning, line 7 refused (ACC-07-11)', async () => {
            const service = makeService();

            const result = await service.apply(WORK, actor(), {
                import: { text: IMPORT_FIXTURE },
            });

            const byAction = (action: string) =>
                result.results.filter((candidate) => candidate.action === action);
            expect(
                byAction('set')
                    .map((candidate) => candidate.name)
                    .sort(),
            ).toEqual([
                'APP_WEB_INTERNAL_URL',
                'CALCOM_TELEMETRY_DISABLED',
                'DATABASE_HOST',
                'LICENSE_KEY',
                'NEXTAUTH_URL',
                'NEXT_PUBLIC_WEBAPP_URL',
                'SMTP_PASSWORD',
                'SUPPORT_EMAIL',
                'TURBO_TELEMETRY_DISABLED',
            ]);
            expect(
                byAction('created')
                    .map((candidate) => candidate.name)
                    .sort(),
            ).toEqual(['BAR', 'FOO']);
            // Line 7 of the fixture carries an `=`, so it is an invalid NAME
            // rather than a line the scanner could not split — T12's own
            // classification, and ACC-07-11 fixes the LINE NUMBER, not the reason.
            expect(byAction('refused')).toEqual([
                expect.objectContaining({ name: null, line: 7, code: 'invalidName' }),
            ]);
            expect(result.warnings).toEqual([{ code: 'undeclared', names: ['FOO', 'BAR'] }]);
            expect(result.changed).toHaveLength(11);

            // The undeclared pair is stored as Set by you, and the single-quoted
            // value arrived literally (FR-28).
            expect(entry(await service.list(WORK, actor()), 'FOO')).toMatchObject({
                declared: false,
                origin: 'user',
                set: true,
            });
            expect(crypto.decrypt((await stored('SMTP_PASSWORD'))!.valueEncrypted)).toBe(
                'p@ss word #1',
            );
            expect(crypto.decrypt((await stored('NEXTAUTH_URL'))!.valueEncrypted)).toBe(
                'https://cal.example.com/api/auth',
            );

            // The paste itself is never stored (FR-30).
            const everything = JSON.stringify(result);
            expect(everything).not.toContain('this line is not a NAME=value line');
        });

        it('skips a generated name unless both confirmations are given (S17)', async () => {
            const service = makeService();
            await service.ensureGenerated(WORK);
            const before = await snapshot();
            // Only the generated name: the point of this case is that this LINE
            // changes nothing until both confirmations are given, and the paste's
            // other lines are covered by the fixture case above.
            const paste = 'NEXTAUTH_SECRET=typed-by-hand\n';

            const skipped = await service.apply(WORK, actor(), { import: { text: paste } });
            expect(item(skipped, 'NEXTAUTH_SECRET')).toMatchObject({
                action: 'skipped',
                code: 'generatedValueUseRotate',
            });

            const unacknowledged = await service.apply(WORK, actor(), {
                import: { text: paste },
                replaceGenerated: true,
            });
            expect(item(unacknowledged, 'NEXTAUTH_SECRET').code).toBe('neverRotateNotAcknowledged');
            expect(await snapshot()).toEqual(before);

            const replaced = await service.apply(WORK, actor(), {
                import: { text: paste },
                replaceGenerated: true,
                acknowledgeNeverRotate: true,
            });
            expect(item(replaced, 'NEXTAUTH_SECRET')).toMatchObject({ action: 'set', version: 2 });
            expect(crypto.decrypt((await stored('NEXTAUTH_SECRET'))!.valueEncrypted)).toBe(
                'typed-by-hand',
            );
        });

        it('keeps the last of two identical names and skips the earlier (FR-29)', async () => {
            const service = makeService();

            const result = await service.apply(WORK, actor(), {
                import: { text: 'FOO=first\nFOO=second\n' },
            });

            expect(result.results).toEqual([
                expect.objectContaining({ name: 'FOO', line: 1, action: 'skipped' }),
                expect.objectContaining({ name: 'FOO', line: 2, action: 'created' }),
            ]);
            expect(crypto.decrypt((await stored('FOO'))!.valueEncrypted)).toBe('second');
        });

        it('refuses a paste over 500 lines before parsing it (FR-28, T12)', async () => {
            const service = makeService();
            const lines = Array.from({ length: 501 }, (_, index) => `PAD_${index}=x`).join('\n');

            const result = await service.apply(WORK, actor(), { import: { text: lines } });

            expect(result.results).toEqual([
                expect.objectContaining({
                    name: null,
                    line: null,
                    action: 'refused',
                    code: 'tooManyValues',
                }),
            ]);
            expect(result.changed).toEqual([]);
            expect(await empty()).toBe(true);
        });

        it('refuses a paste over 64 KiB before parsing it (FR-28, T12)', async () => {
            const service = makeService();
            const text = `FOO=${'x'.repeat(65_537)}`;

            const result = await service.apply(WORK, actor(), { import: { text } });

            expect(result.results).toEqual([
                expect.objectContaining({
                    name: null,
                    line: null,
                    action: 'refused',
                    code: 'valuesTooLarge',
                }),
            ]);
            expect(await empty()).toBe(true);
        });
    });

    /* ---------------------------------------------------------------------- *
     * rotate (ACC-07-04, FR-13, FR-15)
     * ---------------------------------------------------------------------- */

    describe('rotate', () => {
        it('refuses a wrong confirmName and writes nothing (ACC-07-04)', async () => {
            const service = makeService();
            await service.ensureGenerated(WORK);

            let caught: unknown;
            try {
                await service.rotate(WORK, actor(), 'NEXTAUTH_SECRET', {
                    confirmName: 'NEXTAUTH_SECRET_',
                });
            } catch (error) {
                caught = error;
            }

            expect(isAppEnvRefusalError(caught)).toBe(true);
            expect(caught).toMatchObject({ code: 'rotateConfirmationMismatch', status: 422 });
            expect(upsertSpy).not.toHaveBeenCalled();
            expect(activity.emit).not.toHaveBeenCalled();
        });

        it('refuses a name that is not a generated entry with notGenerated (FR-13)', async () => {
            const service = makeService();

            await expect(
                service.rotate(WORK, actor(), 'SMTP_PASSWORD', { confirmName: 'SMTP_PASSWORD' }),
            ).rejects.toMatchObject({ code: 'notGenerated', status: 422 });
            await expect(
                service.rotate(WORK, actor(), 'NEVER_DECLARED', {
                    confirmName: 'NEVER_DECLARED',
                }),
            ).rejects.toMatchObject({ code: 'notGenerated' });
        });

        it('regenerates the value, bumps the version and records app.env.rotated with the name only', async () => {
            const service = makeService();
            await service.ensureGenerated(WORK);
            const before = await stored('NEXTAUTH_SECRET');

            const rotated = await service.rotate(WORK, actor(), 'NEXTAUTH_SECRET', {
                confirmName: 'NEXTAUTH_SECRET',
            });

            const after = await stored('NEXTAUTH_SECRET');
            expect(after!.version).toBe(before!.version + 1);
            expect(after!.valueEncrypted).not.toBe(before!.valueEncrypted);
            const value = crypto.decrypt(after!.valueEncrypted);
            expect(value).toHaveLength(32);
            expect(rotated.version).toBe(after!.version);
            expect(rotated.entry).toMatchObject({ name: 'NEXTAUTH_SECRET', origin: 'generated' });

            expect(activity.emit).toHaveBeenCalledTimes(1);
            const event = activity.emit.mock.calls[0][0];
            expect(event).toMatchObject({
                actionType: 'app_env',
                action: 'app.env.rotated',
                details: { name: 'NEXTAUTH_SECRET' },
            });
            const serialized = JSON.stringify(event);
            expect(serialized).not.toContain(value);
            expect(serialized).not.toContain(String(value.length));
        });

        it('rotates a keypair together — both halves change and both versions increase (FR-15)', async () => {
            const service = makeService();
            await service.ensureGenerated(WORK);
            const before = await stored('VAPID_PRIVATE_KEY');
            const beforePublic = await stored(appEnvPublicHalfName('VAPID_PRIVATE_KEY'));
            const beforePublicValue = crypto.decrypt(beforePublic!.valueEncrypted);

            await service.rotate(WORK, actor(), 'VAPID_PRIVATE_KEY', {
                confirmName: 'VAPID_PRIVATE_KEY',
            });

            const after = await stored('VAPID_PRIVATE_KEY');
            const afterPublic = await stored(appEnvPublicHalfName('VAPID_PRIVATE_KEY'));
            expect(after!.version).toBe(before!.version + 1);
            expect(afterPublic!.version).toBe(beforePublic!.version + 1);
            const publicValue = crypto.decrypt(afterPublic!.valueEncrypted);
            expect(publicValue).toMatch(/^-----BEGIN PUBLIC KEY-----/);
            expect(publicValue).not.toBe(beforePublicValue);
            expect(entry(await service.list(WORK, actor()), 'VAPID_PRIVATE_KEY').publicValue).toBe(
                publicValue,
            );
        });

        it('restores generation over a value a member supplied earlier (FR-12)', async () => {
            const service = makeService();
            await service.ensureGenerated(WORK);
            await service.apply(WORK, actor(), {
                set: [{ name: 'NEXTAUTH_SECRET', value: SECRET_A }],
                replaceGenerated: true,
                acknowledgeNeverRotate: true,
            });
            expect((await stored('NEXTAUTH_SECRET'))!.origin).toBe('user');

            await service.rotate(WORK, actor(), 'NEXTAUTH_SECRET', {
                confirmName: 'NEXTAUTH_SECRET',
            });

            const row = await stored('NEXTAUTH_SECRET');
            expect(row!.origin).toBe('generated');
            expect(crypto.decrypt(row!.valueEncrypted)).not.toBe(SECRET_A);
            expect(row!.generatorFingerprint).toBe('base64:24');
        });
    });

    /* ---------------------------------------------------------------------- *
     * buildRedactor (§4.2:370)
     * ---------------------------------------------------------------------- */

    describe('buildRedactor', () => {
        it('replaces every stored value of 6 characters or more with ***', async () => {
            const service = makeService();
            await service.apply(WORK, actor(), {
                set: [
                    { name: 'SMTP_PASSWORD', value: SECRET_A },
                    { name: 'FOO', value: SECRET_B },
                    { name: 'BAR', value: SHORT_VALUE },
                ],
            });

            const redact = await service.buildRedactor(WORK);
            const text = `token=${SECRET_A} other=${SECRET_B} short=${SHORT_VALUE} untouched=nothing`;
            const redacted = redact(text);

            expect(redacted).toBe(`token=*** other=*** short=${SHORT_VALUE} untouched=nothing`);
            expect(redacted).not.toContain(SECRET_A);
            expect(redacted).not.toContain(SECRET_B);
        });

        it('replaces the longest value first so no fragment of a value survives', async () => {
            const service = makeService();
            const long = 'super-secret-value';
            const short = 'super-secret';
            await service.apply(WORK, actor(), {
                set: [
                    { name: 'FOO', value: long },
                    { name: 'BAR', value: short },
                ],
            });

            const redact = await service.buildRedactor(WORK);
            const redacted = redact(`${long} and ${short}`);

            expect(redacted).toBe('*** and ***');
            expect(redacted).not.toContain('secret');
        });

        it('redacts the generated values too, and nothing when there is nothing stored', async () => {
            const service = makeService();
            await service.ensureGenerated(WORK);

            const redact = await service.buildRedactor(WORK);
            const value = crypto.decrypt((await stored('CRON_SECRET'))!.valueEncrypted);
            expect(redact(`x ${value} y`)).toBe('x *** y');

            const emptyService = makeService();
            const identity = await emptyService.buildRedactor(WORK_B);
            expect(identity('nothing to redact')).toBe('nothing to redact');
        });

        it('refuses to build a redactor without a key rather than pretending to redact', async () => {
            const previous = process.env.PLUGIN_SECRET_ENCRYPTION_KEY;
            delete process.env.PLUGIN_SECRET_ENCRYPTION_KEY;
            try {
                const keyless = makeService({
                    crypto: new AppEnvCrypto(new PluginSecretEncService()),
                });
                await expect(keyless.buildRedactor(WORK)).rejects.toMatchObject({
                    code: 'secureStorageUnavailable',
                });
            } finally {
                process.env.PLUGIN_SECRET_ENCRYPTION_KEY = previous;
            }
        });
    });

    /* ---------------------------------------------------------------------- *
     * the seams this service declares
     * ---------------------------------------------------------------------- */

    describe('the seams this service declares', () => {
        it('parses the ACC-07-11 fixture through T12’s frozen API', () => {
            expect(typeof APP_ENV_SPEC_SOURCE).toBe('symbol');

            const parsed = parseAppEnvDotenv(IMPORT_FIXTURE);
            expect(parsed.kind).toBe('parsed');
            if (parsed.kind !== 'parsed') {
                return;
            }
            expect(parsed.lines).toBe(12);
            expect(parsed.duplicates).toEqual([]);
            expect(parsed.entries).toHaveLength(11);
            expect(parsed.entries.map((candidate) => candidate.line)).toEqual([
                1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12,
            ]);
            expect(parsed.refused).toEqual([
                expect.objectContaining({ line: 7, reason: 'invalidName' }),
            ]);
        });

        it('refuses every write when the crypto seam is absent rather than storing in the clear', async () => {
            const service = makeService({ crypto: null });

            await expect(
                service.apply(WORK, actor(), { set: [{ name: 'SMTP_PASSWORD', value: SECRET_A }] }),
            ).rejects.toMatchObject({ code: 'secureStorageUnavailable' });
            expect(await empty()).toBe(true);
        });
    });
});
