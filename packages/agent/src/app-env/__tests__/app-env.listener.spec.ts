/**
 * APW-07 T15 — `AppEnvListener`, the in-process `app.spec.applied` handler.
 *
 * Plan §2.1:84-92 (the fan-out) and §7:866-867 (why generation is a listener,
 * not a job); spec FR-9/FR-12; ACC-07-01. Task line: `tasks.md:226-231` —
 * "generated rows exist when the handler returns, well inside 60 s (ACC-07-01);
 * a thrown reconcile does not undo generation".
 *
 * ## Why this spec runs the REAL generation path
 *
 * "The rows exist" is a claim about what is **stored**, so the fake here is only
 * `AppDependenciesService` — the one collaborator whose own suite
 * (`app-dependencies.service.spec.ts`) already proves its decisions. Everything
 * on the generation side is production code: T13's `AppEnvService` over an
 * in-memory better-sqlite3 `DataSource` (the default `DATABASE_TYPE`, the CI
 * driver), T8's `WorkAppEnvValueRepository` and T9's `AppEnvCrypto` over a real
 * `enc::v1::` envelope — the same harness `app-env.service.spec.ts:195-238`
 * uses. A test that mocked `ensureGenerated` could not tell "the listener awaited
 * the pass" from "the listener called a stub", which is the entire ACC-07-01
 * claim.
 *
 * "No rollback" is asserted the same way: the spies sit over T8's REAL write
 * doors (`insertIfAbsent`, `upsertValue`, `deleteNames`, which is the only
 * removal door the repository has), so a call count is a write that happened —
 * and `deleteNames` at 0 with `upsertValue` at 0 after a throwing reconcile is
 * "nothing was withdrawn and nothing was rewritten" in the strongest form the
 * repository allows.
 *
 * ## The one thing that is a stand-in
 *
 * APW-03's `AppSpecAppliedEvent` does not exist in this tree
 * (`packages/agent/src/events/app-spec-applied.event.ts`, `APW-03/tasks.md:101`),
 * so the listener declares `APP_ENV_SPEC_APPLIED_EVENT` +
 * `AppEnvListenerSpecAppliedEvent` itself and this spec pins that seam against
 * the canonical name AND against the real `@nestjs/event-emitter` dispatcher:
 * one case compiles a Nest module carrying the listener as a PROVIDER and proves
 * `EventEmitter2.emit('app.spec.applied', …)` reaches it while a different event
 * name has no subscriber at all. That is the wiring claim, tested through the
 * framework rather than by reading the source.
 */

import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { DataSource, Repository } from 'typeorm';
import { appEnvPublicHalfName, type AppSpec, type AppSpecEnvEntry } from '@ever-works/contracts';
import { WorkAppEnvValue } from '../../entities/work-app-env-value.entity';
import { ENTITIES } from '../../database/_entities-inventory';
import { WorkAppEnvValueRepository } from '../../database/repositories/work-app-env-value.repository';
import { PluginSecretEncService } from '../../plugins/services/plugin-secret-enc.service';
import {
    AppDependenciesService,
    type AppDependencyReconcileResult,
} from '../../app-dependencies/app-dependencies.service';
import { AppEnvCrypto } from '../app-env-crypto';
import { AppEnvService, type AppEnvSpecSource } from '../app-env.service';
import {
    APP_ENV_SPEC_APPLIED_EVENT,
    AppEnvListener,
    type AppEnvListenerOutcome,
    type AppEnvListenerSpecAppliedEvent,
} from '../app-env.listener';

const KEY = 'a'.repeat(64);
const WORK = '11111111-1111-4111-8111-111111111111';

/** What the listener must have stored by the time it returns (ACC-07-01). */
const GENERATED = [
    'NEXTAUTH_SECRET',
    'CRON_SECRET',
    'CALENDSO_ENCRYPTION_KEY',
    'INSTANCE_ID',
    'VAPID_PRIVATE_KEY',
] as const;

/**
 * The generated half of the S1 fixture (`spec.md:90-94`) plus the keypair — the
 * five shapes ACC-07-01 pins: base64 of 24 bytes → 32 characters, hex of 32
 * bytes → 64, chars 40 → 40, uuid → 36, and a keypair whose `<NAME>_PUBLIC` half
 * is stored beside it.
 */
function fixtureEnv(): AppSpecEnvEntry[] {
    return [
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
    ];
}

function fixtureSpec(): AppSpec {
    return { kind: 'app', appSpecVersion: 1, env: fixtureEnv() };
}

/** A spec source that answers one spec until a case replaces it. */
function specSource(spec: AppSpec = fixtureSpec()): AppEnvSpecSource & { read: jest.Mock } {
    const read = jest.fn(async () => ({ spec, specHash: 'hash-1', commitSha: 'commit-1' }));
    return { read };
}

/** A suspended promise a case resolves itself (the "generation is in flight" gate). */
function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((settle) => {
        resolve = () => settle();
    });
    return { promise, resolve };
}

/** One macrotask turn — every microtask queued before it has run. */
function macrotask(): Promise<void> {
    return new Promise<void>((resolve) => setImmediate(resolve));
}

/** An empty T16 report, so the fake answers the real shape. */
function reconcileResult(workId: string): AppDependencyReconcileResult {
    return {
        workId,
        deployTarget: 'your-cluster',
        created: [],
        awaitingConfig: [],
        dispatched: [],
        kept: [],
        outOfSpec: [],
        unsupported: [],
        dispatchUnavailable: false,
    };
}

describe('AppEnvListener (T15, plan §2.1:84-92, §7:866-867)', () => {
    let dataSource: DataSource;
    let repository: WorkAppEnvValueRepository;
    let rows: Repository<WorkAppEnvValue>;
    let crypto: AppEnvCrypto;
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
        // The owning Work row is not what is under test.
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
        // The warn lines are the listener doing its job; they carry names only and
        // are silenced for readability.
        jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        // Spies over the REAL write doors: the original implementation still runs,
        // so a call count is a write that actually happened.
        insertSpy = jest.spyOn(repository, 'insertIfAbsent');
        upsertSpy = jest.spyOn(repository, 'upsertValue');
        deleteSpy = jest.spyOn(repository, 'deleteNames');
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    /** T13's real service, with T14/T26/APW-05/06's seams left unbound. */
    function makeService(spec: AppEnvSpecSource = specSource()): AppEnvService {
        return new AppEnvService(
            repository,
            rows,
            crypto,
            spec,
            undefined as never,
            undefined as never,
            undefined as never,
            undefined as never,
            undefined as never,
        );
    }

    /** The one fake: T16's `reconcile`, whose decisions its own spec proves. */
    function makeDependencies(
        reconcile: jest.Mock = jest.fn(async (workId: string) => reconcileResult(workId)),
    ): { service: AppDependenciesService; reconcile: jest.Mock } {
        return { service: { reconcile } as unknown as AppDependenciesService, reconcile };
    }

    const storedNames = async (): Promise<string[]> =>
        (await rows.find({ where: { workId: WORK }, order: { name: 'ASC' } })).map(
            (row) => row.name,
        );

    /** What "nothing was rolled back" means for a stored row. */
    async function snapshot(): Promise<
        Array<{
            name: string;
            origin: string;
            version: number;
            valueEncrypted: string;
            valueBytes: number;
            generatorFingerprint: string | null;
        }>
    > {
        const all = await rows.find({ where: { workId: WORK }, order: { name: 'ASC' } });
        return all.map((row) => ({
            name: row.name,
            origin: row.origin,
            version: row.version,
            valueEncrypted: row.valueEncrypted,
            valueBytes: row.valueBytes,
            generatorFingerprint: row.generatorFingerprint ?? null,
        }));
    }

    /** Every stored value, decrypted — used for the ACC-07-01 lengths and the no-leak case. */
    async function storedValues(): Promise<Record<string, string>> {
        const all = await rows.find({ where: { workId: WORK } });
        const values: Record<string, string> = {};
        for (const row of all) {
            values[row.name] = crypto.decrypt(row.valueEncrypted);
        }
        return values;
    }

    /* ---------------------------------------------------------------------- *
     * ACC-07-01 — the rows exist when the handler returns, inside 60 s
     * ---------------------------------------------------------------------- */

    it('stores every generated value at its declared length before it returns, inside 60 s (ACC-07-01)', async () => {
        const listener = new AppEnvListener(makeService(), makeDependencies().service);

        const startedAt = Date.now();
        const outcome = await listener.handleAppSpecApplied({ workId: WORK });
        const elapsed = Date.now() - startedAt;

        // The rows exist the moment the handler's promise settles — read straight
        // from the table, not from the report.
        expect(await storedNames()).toEqual([
            'CALENDSO_ENCRYPTION_KEY',
            'CRON_SECRET',
            'INSTANCE_ID',
            'NEXTAUTH_SECRET',
            'VAPID_PRIVATE_KEY',
            'VAPID_PRIVATE_KEY_PUBLIC',
        ]);
        expect(outcome.generation?.created.map((entry) => entry.name).sort()).toEqual(
            [...GENERATED].sort(),
        );
        expect(
            outcome.generation?.created.find((e) => e.name === 'VAPID_PRIVATE_KEY')?.publicName,
        ).toBe(appEnvPublicHalfName('VAPID_PRIVATE_KEY'));

        // ACC-07-01's declared shapes, measured on the decrypted values.
        const values = await storedValues();
        expect(values.NEXTAUTH_SECRET).toHaveLength(32);
        expect(values.CRON_SECRET).toMatch(/^[0-9a-f]{64}$/);
        expect(values.CALENDSO_ENCRYPTION_KEY).toHaveLength(40);
        expect(values.INSTANCE_ID).toHaveLength(36);
        expect(values.VAPID_PRIVATE_KEY).toContain('BEGIN');
        expect(values.VAPID_PRIVATE_KEY_PUBLIC).toContain('BEGIN');

        // FR-9's window, on both the handler's own measure and the wall clock.
        expect(outcome.durationMs).toBeLessThan(60_000);
        expect(elapsed).toBeLessThan(60_000);
    });

    it('does not settle while generation is still in flight, and the rows are there when it does', async () => {
        // The gate makes "the handler awaited the pass" observable: with a
        // fire-and-forget generation the promise settles while the spec read —
        // and therefore every row — is still pending.
        const gate = deferred();
        const gated = specSource();
        gated.read.mockImplementation(async () => {
            await gate.promise;
            return { spec: fixtureSpec(), specHash: 'hash-1', commitSha: 'commit-1' };
        });
        const listener = new AppEnvListener(makeService(gated), makeDependencies().service);

        let settled = false;
        const handled = listener.handleAppSpecApplied({ workId: WORK }).then((outcome) => {
            settled = true;
            return outcome;
        });

        await macrotask();
        expect(settled).toBe(false);
        expect(await storedNames()).toEqual([]);

        gate.resolve();
        const outcome = await handled;

        expect(settled).toBe(true);
        expect(await storedNames()).toContain('NEXTAUTH_SECRET');
        expect(outcome.durationMs).toBeLessThan(60_000);
    });

    /* ---------------------------------------------------------------------- *
     * Order — generation first, then reconcile (plan §2.1, T15's task line)
     * ---------------------------------------------------------------------- */

    it('reconciles once, with the event workId, only after the generated rows exist', async () => {
        const service = makeService();
        const generated = jest.spyOn(service, 'ensureGenerated');
        let rowsSeenByReconcile: string[] = [];
        const dependencies = makeDependencies(
            jest.fn(async (workId: string) => {
                rowsSeenByReconcile = await storedNames();
                return reconcileResult(workId);
            }),
        );
        const listener = new AppEnvListener(service, dependencies.service);

        const outcome = await listener.handleAppSpecApplied({
            workId: WORK,
            commitSha: 'commit-2',
            previousCommitSha: 'commit-1',
            specHash: 'hash-2',
            addedDependencies: ['postgres'],
            changedEnvNames: ['NEXTAUTH_SECRET'],
            changedBlocks: ['build'],
        });

        expect(generated).toHaveBeenCalledTimes(1);
        expect(generated).toHaveBeenCalledWith(WORK);
        expect(dependencies.reconcile).toHaveBeenCalledTimes(1);
        expect(dependencies.reconcile).toHaveBeenCalledWith(WORK);
        // Generation finished BEFORE reconcile ran: the rows were already visible.
        expect(rowsSeenByReconcile).toContain('NEXTAUTH_SECRET');
        expect(outcome.reconcile?.workId).toBe(WORK);
    });

    /* ---------------------------------------------------------------------- *
     * A thrown reconcile does not undo generation (FR-12, T15's task line)
     * ---------------------------------------------------------------------- */

    it('keeps every generated row when reconcile throws — no rollback, no rejection', async () => {
        const service = makeService();
        const dependencies = makeDependencies(
            jest.fn(async () => {
                throw new Error('dependency dispatch exploded');
            }),
        );
        const listener = new AppEnvListener(service, dependencies.service);

        const outcome: AppEnvListenerOutcome = await listener.handleAppSpecApplied({
            workId: WORK,
        });

        // Swallowed and reported — the handler does not reject into the emitter…
        expect(outcome.reconcileError).toBe('dependency dispatch exploded');
        expect(outcome.reconcile).toBeNull();
        expect(dependencies.reconcile).toHaveBeenCalledTimes(1);

        // …and the generation that already committed is untouched: every row is
        // still there, at version 1, and no write door was used to withdraw it.
        expect(await storedNames()).toEqual([
            'CALENDSO_ENCRYPTION_KEY',
            'CRON_SECRET',
            'INSTANCE_ID',
            'NEXTAUTH_SECRET',
            'VAPID_PRIVATE_KEY',
            'VAPID_PRIVATE_KEY_PUBLIC',
        ]);
        const stored = await snapshot();
        expect(stored.map((row) => row.version)).toEqual([1, 1, 1, 1, 1, 1]);
        expect(stored.every((row) => row.valueEncrypted.startsWith('enc::v1::'))).toBe(true);
        // 5 generated values + 1 keypair public half = the six rows above, from
        // exactly one insert pass; nothing was deleted and nothing overwritten.
        expect(insertSpy).toHaveBeenCalledTimes(6);
        expect(deleteSpy).not.toHaveBeenCalled();
        expect(upsertSpy).not.toHaveBeenCalled();
        expect(outcome.generation?.created).toHaveLength(5);
    });

    it('still reconciles when generation throws — the two reactions are siblings (plan §2.1)', async () => {
        const service = makeService();
        jest.spyOn(service, 'ensureGenerated').mockRejectedValueOnce(new Error('no key'));
        const dependencies = makeDependencies();
        const listener = new AppEnvListener(service, dependencies.service);

        const outcome = await listener.handleAppSpecApplied({ workId: WORK });

        expect(outcome.generation).toBeNull();
        expect(outcome.generationError).toBe('no key');
        expect(dependencies.reconcile).toHaveBeenCalledTimes(1);
        expect(outcome.reconcile?.workId).toBe(WORK);
        expect(await storedNames()).toEqual([]);
    });

    /* ---------------------------------------------------------------------- *
     * The seams: named absences, never a silent success
     * ---------------------------------------------------------------------- */

    it('names the missing seam when a service is unbound instead of reporting success', async () => {
        const bare = new AppEnvListener();
        const withoutDependencies = new AppEnvListener(makeService());

        const bareOutcome = await bare.handleAppSpecApplied({ workId: WORK });
        expect(bareOutcome.reason).toBe('envServiceUnavailable');
        expect(bareOutcome.generation).toBeNull();
        expect(bareOutcome.reconcile).toBeNull();

        // A bound env service still generates; only reconcile is skipped.
        const partial = await withoutDependencies.handleAppSpecApplied({ workId: WORK });
        expect(partial.reason).toBe('dependenciesServiceUnavailable');
        expect(partial.generation?.created).toHaveLength(5);
        expect(await storedNames()).toContain('NEXTAUTH_SECRET');
    });

    it('does nothing, and says so, for an event with no workId', async () => {
        const service = makeService();
        const generated = jest.spyOn(service, 'ensureGenerated');
        const dependencies = makeDependencies();
        const listener = new AppEnvListener(service, dependencies.service);

        const outcome = await listener.handleAppSpecApplied({} as AppEnvListenerSpecAppliedEvent);

        expect(outcome.reason).toBe('workIdMissing');
        expect(outcome.workId).toBe('');
        expect(generated).not.toHaveBeenCalled();
        expect(dependencies.reconcile).not.toHaveBeenCalled();
        expect(await storedNames()).toEqual([]);
    });

    /* ---------------------------------------------------------------------- *
     * The wiring — the provisional seam, through the framework
     * ---------------------------------------------------------------------- */

    it('is subscribed to app.spec.applied itself: the dispatcher reaches it, a different event does not', async () => {
        const service = makeService();
        const generated = jest.spyOn(service, 'ensureGenerated');
        const dependencies = makeDependencies();
        const moduleRef = await Test.createTestingModule({
            imports: [EventEmitterModule.forRoot()],
            // A PROVIDER, because that is what Nest scans for `@OnEvent` metadata.
            providers: [
                AppEnvListener,
                { provide: AppEnvService, useValue: service },
                { provide: AppDependenciesService, useValue: dependencies.service },
            ],
        }).compile();
        await moduleRef.init();

        try {
            const emitter = moduleRef.get(EventEmitter2);

            // The listener owns exactly this event name…
            expect(emitter.emit(APP_ENV_SPEC_APPLIED_EVENT, { workId: WORK })).toBe(true);
            await waitFor(async () => (await storedNames()).length > 0);
            expect(generated).toHaveBeenCalledTimes(1);
            expect(await storedNames()).toContain('NEXTAUTH_SECRET');

            // …and no subscriber at all for a neighbouring App-spec event: nothing
            // is generated and nothing reconciled by a name it does not own.
            expect(emitter.emit('app.spec.validated', { workId: WORK })).toBe(false);
            await macrotask();
            expect(generated).toHaveBeenCalledTimes(1);
            expect(dependencies.reconcile).toHaveBeenCalledTimes(1);
        } finally {
            await moduleRef.close();
        }
    });

    it('pins the provisional event name to the canonical string APW-03 will own', () => {
        // `APW-03/tasks.md:101-102` — `EVENT_NAME = 'app.spec.applied'` in
        // `packages/agent/src/events/app-spec-applied.event.ts`. When that class
        // lands, `@OnEvent` takes `AppSpecAppliedEvent.EVENT_NAME` and this
        // constant stays source-compatible for whoever already imports it.
        expect(APP_ENV_SPEC_APPLIED_EVENT).toBe('app.spec.applied');
    });

    /* ---------------------------------------------------------------------- *
     * The outcome is loggable — it carries no value (ACC-07-05's invariant)
     * ---------------------------------------------------------------------- */

    it('returns an outcome that contains no generated value', async () => {
        const listener = new AppEnvListener(makeService(), makeDependencies().service);

        const outcome = await listener.handleAppSpecApplied({ workId: WORK });
        const values = await storedValues();
        const serialized = JSON.stringify(outcome);

        expect(Object.keys(values)).toHaveLength(6);
        for (const value of Object.values(values)) {
            expect(value.length).toBeGreaterThan(10);
            expect(serialized).not.toContain(value);
        }
        // The report is the evidence that generation happened: names, versions and
        // fingerprints — never a value.
        expect(outcome.generation?.created).toHaveLength(5);
        expect(outcome.generation?.created[0].fingerprint).not.toBe('');
    });
});

/** Poll a predicate for up to `timeoutMs` — the async `@OnEvent({ async: true })` hop. */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('timed out waiting for the listener to run');
}
