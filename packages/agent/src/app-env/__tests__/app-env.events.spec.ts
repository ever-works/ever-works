import { Logger } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import type { AppSpec, AppSpecEnvEntry } from '@ever-works/contracts';

import { WorkAppEnvValue } from '../../entities/work-app-env-value.entity';
import { ENTITIES } from '../../database/_entities-inventory';
import { WorkAppEnvValueRepository } from '../../database/repositories/work-app-env-value.repository';
import { AppEnvChangedEvent, AppEnvRotatedEvent } from '../../events/app-env.events';
import { PluginSecretEncService } from '../../plugins/services/plugin-secret-enc.service';
import { AppEnvCrypto } from '../app-env-crypto';
import { AppEnvService, type AppEnvSpecSource } from '../app-env.service';

/**
 * 2026-10-17 (lane aw-builds-3) — `app.env.changed` / `app.env.rotated` on the
 * EventEmitter bus (APW-07 plan §7: "EventEmitter2 + Activity, names only").
 *
 * Before this the two names were Activity rows only, so APW-05's re-prepare on a
 * build-value change never fired. The payload is names only, split by phase.
 */

const KEY = 'a'.repeat(64);
const WORK = '11111111-1111-4111-8111-111111111111';
const USER = '33333333-3333-4333-8333-333333333333';
const actor = { userId: USER, name: 'Maya' };

function specOf(...env: AppSpecEnvEntry[]): AppSpec {
    return { kind: 'app', appSpecVersion: 1, env };
}

function source(spec: AppSpec): AppEnvSpecSource {
    return { read: jest.fn(async () => ({ spec, specHash: 'hash-1', commitSha: 'commit-1' })) };
}

describe('AppEnvService — the env events on the bus', () => {
    let dataSource: DataSource;
    let repository: WorkAppEnvValueRepository;
    let rows: Repository<WorkAppEnvValue>;
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
        repository = new WorkAppEnvValueRepository(dataSource.getRepository(WorkAppEnvValue));
        rows = dataSource.getRepository(WorkAppEnvValue);
        crypto = new AppEnvCrypto(new PluginSecretEncService());
    });

    afterAll(async () => {
        await dataSource.destroy();
        if (savedKey === undefined) delete process.env.PLUGIN_SECRET_ENCRYPTION_KEY;
        else process.env.PLUGIN_SECRET_ENCRYPTION_KEY = savedKey;
    });

    beforeEach(async () => {
        await rows.clear();
        jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => jest.restoreAllMocks());

    function service(spec: AppSpec, emitter: { emit: jest.Mock } | undefined) {
        return new AppEnvService(
            repository,
            rows,
            crypto,
            source(spec),
            { emit: jest.fn(async () => undefined) },
            undefined,
            undefined,
            undefined,
            undefined,
            emitter as never,
        );
    }

    const SPEC = specOf(
        { name: 'BUILD_ONLY', phase: 'build', prompt: { description: 'b', required: false } },
        { name: 'RUNTIME_ONLY', phase: 'runtime', prompt: { description: 'r', required: false } },
        { name: 'BOTH', phase: 'both', prompt: { description: 'x', required: false } },
    );

    it('emits one app.env.changed per call, names only, split by phase', async () => {
        const emitter = { emit: jest.fn() };
        await service(SPEC, emitter).apply(WORK, actor, {
            set: [
                { name: 'BUILD_ONLY', value: 'secret-build-value' },
                { name: 'RUNTIME_ONLY', value: 'secret-runtime-value' },
                { name: 'BOTH', value: 'secret-both-value' },
                // Undeclared ("Set by you"): passed to the app at runtime only.
                { name: 'UNDECLARED', value: 'secret-undeclared' },
            ],
        });

        expect(emitter.emit).toHaveBeenCalledTimes(1);
        const [name, event] = emitter.emit.mock.calls[0];
        expect(name).toBe('app.env.changed');
        expect(event).toBeInstanceOf(AppEnvChangedEvent);
        expect(event.payload.workId).toBe(WORK);
        expect([...event.payload.names].sort()).toEqual([
            'BOTH',
            'BUILD_ONLY',
            'RUNTIME_ONLY',
            'UNDECLARED',
        ]);
        expect([...event.payload.buildPhaseNames].sort()).toEqual(['BOTH', 'BUILD_ONLY']);
        expect([...event.payload.runtimePhaseNames].sort()).toEqual([
            'BOTH',
            'RUNTIME_ONLY',
            'UNDECLARED',
        ]);
        // FR-8: never a value.
        expect(JSON.stringify(event)).not.toMatch(/secret-/);
    });

    it('emits nothing when the call changed nothing, and nothing without an emitter', async () => {
        const emitter = { emit: jest.fn() };
        await service(SPEC, emitter).apply(WORK, actor, { set: [] });
        expect(emitter.emit).not.toHaveBeenCalled();

        await expect(
            service(SPEC, undefined).apply(WORK, actor, {
                set: [{ name: 'BUILD_ONLY', value: 'v1' }],
            }),
        ).resolves.toMatchObject({ changed: ['BUILD_ONLY'] });
    });

    it('emits app.env.rotated with the rotated name', async () => {
        const spec = specOf({
            name: 'SIGNING_KEY',
            phase: 'both',
            secret: true,
            generate: { kind: 'base64' },
        });
        const emitter = { emit: jest.fn() };
        const svc = service(spec, emitter);
        await svc.ensureGenerated(WORK);
        emitter.emit.mockClear();

        await svc.rotate(WORK, actor, 'SIGNING_KEY', { confirmName: 'SIGNING_KEY' });

        const rotated = emitter.emit.mock.calls.find(([name]) => name === 'app.env.rotated');
        expect(rotated?.[1]).toBeInstanceOf(AppEnvRotatedEvent);
        expect(rotated?.[1].payload).toEqual({
            workId: WORK,
            names: ['SIGNING_KEY'],
            buildPhaseNames: ['SIGNING_KEY'],
            runtimePhaseNames: ['SIGNING_KEY'],
        });
    });

    it('never fails the write when a listener throws', async () => {
        const emitter = {
            emit: jest.fn(() => {
                throw new Error('listener blew up');
            }),
        };
        await expect(
            service(SPEC, emitter).apply(WORK, actor, {
                set: [{ name: 'BUILD_ONLY', value: 'v1' }],
            }),
        ).resolves.toMatchObject({ changed: ['BUILD_ONLY'] });
    });
});
