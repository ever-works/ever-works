import { PluginEvents } from '../plugins.constants';
import { PluginSettingsService } from '../services/plugin-settings.service';

/**
 * APW-05 §4.12 (`APW05-G07`) — `writePlatformManagedWorkSettings`, the write the
 * registry pull token is stored through: `x-secret` keys encrypted, no
 * `validateSettings`, only declared keys, and a `platformManaged` change event.
 */

const PLUGIN_ID = 'github-actions-build';
const WORK_ID = '11111111-1111-4111-8111-111111111111';

function harness(existing: Record<string, unknown> | null = null) {
    const validateSettings = jest.fn(() => ({ valid: false, errors: [{ message: 'nope' }] }));
    const registry = {
        get: jest.fn(() => ({
            state: 'loaded',
            plugin: {
                validateSettings,
                settingsSchema: {
                    type: 'object',
                    properties: {
                        pullToken: { type: 'string', 'x-secret': true },
                        pullTokenExpiresAt: { type: ['string', 'null'] },
                        reclaimDisk: { type: 'boolean' },
                    },
                },
            },
        })),
    };
    const pluginRepository = { findByPluginId: jest.fn(async () => ({ id: 'entity-1' })) };
    const workPluginRepository = {
        findByWorkAndPlugin: jest.fn(async () => existing),
        updateSettings: jest.fn(async () => undefined),
        create: jest.fn(async () => undefined),
    };
    const emitter = { emit: jest.fn() };
    const secretEnc = {
        encryptRecord: jest.fn((record: Record<string, unknown>) =>
            Object.fromEntries(Object.entries(record).map(([k, v]) => [k, `enc:${String(v)}`])),
        ),
        decryptRecord: jest.fn((record: Record<string, unknown>) => ({ ...record })),
    };
    const service = new PluginSettingsService(
        registry as never,
        pluginRepository as never,
        {} as never,
        workPluginRepository as never,
        emitter as never,
        undefined,
        secretEnc as never,
    );
    return { service, workPluginRepository, emitter, validateSettings };
}

describe('PluginSettingsService.writePlatformManagedWorkSettings (APW-05 §4.12)', () => {
    it('encrypts the token, keeps the expiry plain, skips validateSettings and drops undeclared keys', async () => {
        const h = harness();
        await h.service.writePlatformManagedWorkSettings(PLUGIN_ID, WORK_ID, {
            pullToken: 'ghp_secret',
            pullTokenExpiresAt: '2027-01-01T00:00:00Z',
            injected: 'x',
        });

        expect(h.validateSettings).not.toHaveBeenCalled();
        expect(h.workPluginRepository.create).toHaveBeenCalledWith({
            workId: WORK_ID,
            pluginId: PLUGIN_ID,
            pluginEntityId: 'entity-1',
            settings: { pullTokenExpiresAt: '2027-01-01T00:00:00Z' },
            secretSettings: { pullToken: 'enc:ghp_secret' },
        });
        expect(h.emitter.emit).toHaveBeenCalledWith(
            PluginEvents.SETTINGS_CHANGED,
            expect.objectContaining({
                pluginId: PLUGIN_ID,
                workId: WORK_ID,
                scope: 'work',
                platformManaged: true,
                changedKeys: ['pullTokenExpiresAt', 'pullToken'],
            }),
        );
    });

    it('merges into an existing row without dropping its other settings', async () => {
        const h = harness({ settings: { reclaimDisk: true }, secretSettings: { other: 'kept' } });
        await h.service.writePlatformManagedWorkSettings(PLUGIN_ID, WORK_ID, { pullToken: 't2' });
        expect(h.workPluginRepository.updateSettings).toHaveBeenCalledWith(
            WORK_ID,
            PLUGIN_ID,
            { reclaimDisk: true },
            { other: 'enc:kept', pullToken: 'enc:t2' },
        );
    });

    it('writes nothing and emits nothing when no declared key is given', async () => {
        const h = harness();
        await h.service.writePlatformManagedWorkSettings(PLUGIN_ID, WORK_ID, { injected: 'x' });
        expect(h.workPluginRepository.create).not.toHaveBeenCalled();
        expect(h.emitter.emit).not.toHaveBeenCalled();
    });
});
