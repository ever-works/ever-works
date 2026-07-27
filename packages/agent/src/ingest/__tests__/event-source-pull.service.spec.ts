import { EventSourcePullService } from '../event-source-pull.service';
import type { EventIngestService } from '../event-ingest.service';
import type { IngestCursorRepository } from '../ingest-cursor.repository';
import type { PluginRegistryService } from '../../plugins/services/plugin-registry.service';
import type { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
import type { UserPluginRepository } from '../../plugins/repositories/user-plugin.repository';

/**
 * Event-ingest pull path (Wave 8) — unit contract for
 * `EventSourcePullService.pullSources()`: per-(plugin, user) cursor
 * isolation, watermark/sweep protocol and the one-broken-source-never-
 * kills-the-batch guarantee.
 */

const EPOCH_ISO = new Date(0).toISOString();

interface FakePlugin {
    id: string;
    capabilities: string[];
    pullEvents?: jest.Mock;
}

function makeEnvelope(source: string, sourceEventId: string) {
    return {
        id: `env-${sourceEventId}`,
        source,
        sourceEventId,
        kind: `${source}.thing`,
        occurredAt: '2026-07-24T10:00:00.000Z',
        payload: {},
    };
}

describe('EventSourcePullService', () => {
    let ingestMock: jest.Mock;
    let eventIngestService: EventIngestService;
    let cursorRows: Map<
        string,
        { cursor?: string | null; watermark?: Date | null; sweepStartedAt?: Date | null }
    >;
    let cursorSaveMock: jest.Mock;
    let cursorRepository: IngestCursorRepository;
    let registered: Array<{ plugin: FakePlugin; state: string }>;
    let registry: PluginRegistryService;
    let settingsService: PluginSettingsService;
    let userRows: Record<string, Array<{ userId: string; enabled: boolean }>>;
    let userPluginRepository: UserPluginRepository;

    const cursorKey = (userId: string, pluginId: string) => `${userId}\0${pluginId}`;

    function makeService(): EventSourcePullService {
        return new EventSourcePullService(
            eventIngestService,
            cursorRepository,
            registry,
            settingsService,
            userPluginRepository,
        );
    }

    beforeEach(() => {
        ingestMock = jest
            .fn()
            .mockResolvedValue({ inserted: 1, duplicates: 0, rejected: 0, filtered: 0 });
        eventIngestService = { ingest: ingestMock } as unknown as EventIngestService;

        cursorRows = new Map();
        cursorSaveMock = jest.fn().mockImplementation(async (data) => {
            cursorRows.set(cursorKey(data.userId, data.pluginId), data);
            return data;
        });
        cursorRepository = {
            findByUserAndPlugin: jest
                .fn()
                .mockImplementation(async (userId: string, pluginId: string) => {
                    const row = cursorRows.get(cursorKey(userId, pluginId));
                    return row ? { userId, pluginId, ...row } : null;
                }),
            save: cursorSaveMock,
        } as unknown as IngestCursorRepository;

        registered = [];
        registry = {
            getByCapability: jest.fn().mockImplementation(() => registered),
            isPluginEnabledForScope: jest.fn().mockResolvedValue(true),
        } as unknown as PluginRegistryService;

        settingsService = {
            getSettings: jest.fn().mockResolvedValue({ apiKey: 'secret-key' }),
        } as unknown as PluginSettingsService;

        userRows = {};
        userPluginRepository = {
            findByPlugin: jest
                .fn()
                .mockImplementation(async (pluginId: string) => userRows[pluginId] ?? []),
        } as unknown as UserPluginRepository;
    });

    function addSource(id: string, state = 'loaded'): FakePlugin {
        const plugin: FakePlugin = {
            id,
            capabilities: ['connector', 'event-source'],
            pullEvents: jest.fn().mockResolvedValue({ events: [] }),
        };
        registered.push({ plugin, state });
        return plugin;
    }

    it('degrades to a no-op when the plugin system is not wired in this runtime', async () => {
        const service = new EventSourcePullService(eventIngestService, cursorRepository);
        const result = await service.pullSources();
        expect(result).toEqual({
            sources: 0,
            pulled: 0,
            pages: 0,
            inserted: 0,
            duplicates: 0,
            rejected: 0,
            filtered: 0,
            errors: 0,
        });
    });

    it('pulls with an epoch since on first pull, resolved settings (secrets included), and ingests the envelopes', async () => {
        const plugin = addSource('linear-connector');
        plugin.pullEvents!.mockResolvedValueOnce({
            events: [makeEnvelope('linear-connector', 'e1')],
        });
        userRows['linear-connector'] = [{ userId: 'user-1', enabled: true }];

        const result = await makeService().pullSources();

        expect(settingsService.getSettings).toHaveBeenCalledWith('linear-connector', {
            userId: 'user-1',
            includeSecrets: true,
        });
        expect(plugin.pullEvents).toHaveBeenCalledWith({
            since: EPOCH_ISO,
            settings: { apiKey: 'secret-key' },
        });
        expect(ingestMock).toHaveBeenCalledWith('user-1', [makeEnvelope('linear-connector', 'e1')]);
        expect(result).toMatchObject({ sources: 1, pulled: 1, pages: 1, inserted: 1, errors: 0 });
    });

    it('completed sweeps advance the watermark to the sweep start and clear the cursor', async () => {
        addSource('linear-connector');
        userRows['linear-connector'] = [{ userId: 'user-1', enabled: true }];
        const before = Date.now();

        await makeService().pullSources();

        expect(cursorSaveMock).toHaveBeenCalledTimes(1);
        const saved = cursorSaveMock.mock.calls[0][0];
        expect(saved).toMatchObject({
            userId: 'user-1',
            pluginId: 'linear-connector',
            cursor: null,
        });
        expect(saved.sweepStartedAt).toBeNull();
        expect(saved.watermark).toBeInstanceOf(Date);
        expect(saved.watermark.getTime()).toBeGreaterThanOrEqual(before);
    });

    it('keeps per-(plugin, user) cursors isolated — each pair pulls with its OWN watermark and cursor', async () => {
        const linear = addSource('linear-connector');
        const notion = addSource('notion-connector');
        userRows['linear-connector'] = [{ userId: 'user-1', enabled: true }];
        userRows['notion-connector'] = [{ userId: 'user-1', enabled: true }];
        cursorRows.set(cursorKey('user-1', 'linear-connector'), {
            cursor: 'linear-resume',
            watermark: new Date('2026-07-20T00:00:00.000Z'),
            sweepStartedAt: new Date('2026-07-24T00:00:00.000Z'),
        });
        cursorRows.set(cursorKey('user-1', 'notion-connector'), {
            cursor: null,
            watermark: new Date('2026-07-22T00:00:00.000Z'),
            sweepStartedAt: null,
        });

        await makeService().pullSources();

        expect(linear.pullEvents).toHaveBeenCalledWith({
            since: '2026-07-20T00:00:00.000Z',
            cursor: 'linear-resume',
            settings: { apiKey: 'secret-key' },
        });
        expect(notion.pullEvents).toHaveBeenCalledWith({
            since: '2026-07-22T00:00:00.000Z',
            settings: { apiKey: 'secret-key' },
        });
        // Completion writes stay per-pair too.
        const savedFor = (pluginId: string) =>
            cursorSaveMock.mock.calls.find((c) => c[0].pluginId === pluginId)?.[0];
        // The resumed linear sweep completes at its ORIGINAL start, not now.
        expect(savedFor('linear-connector').watermark.toISOString()).toBe(
            '2026-07-24T00:00:00.000Z',
        );
        expect(savedFor('notion-connector').watermark.toISOString()).not.toBe(
            '2026-07-24T00:00:00.000Z',
        );
    });

    it('an error in one plugin does not kill the batch — the other sources still pull', async () => {
        const broken = addSource('broken-connector');
        broken.pullEvents!.mockRejectedValue(new Error('boom'));
        const healthy = addSource('notion-connector');
        userRows['broken-connector'] = [{ userId: 'user-1', enabled: true }];
        userRows['notion-connector'] = [{ userId: 'user-1', enabled: true }];

        const result = await makeService().pullSources();

        expect(healthy.pullEvents).toHaveBeenCalledTimes(1);
        expect(result.errors).toBe(1);
        expect(result.pulled).toBe(1);
        expect(result.sources).toBe(2);
    });

    it("one user's failure (e.g. not configured) does not stop the plugin's other users", async () => {
        const plugin = addSource('linear-connector');
        const notConfigured = new Error('no key');
        notConfigured.name = 'EventSourceNotConfiguredError';
        plugin
            .pullEvents!.mockRejectedValueOnce(notConfigured)
            .mockResolvedValueOnce({ events: [makeEnvelope('linear-connector', 'e2')] });
        userRows['linear-connector'] = [
            { userId: 'user-1', enabled: true },
            { userId: 'user-2', enabled: true },
        ];

        const result = await makeService().pullSources();

        expect(plugin.pullEvents).toHaveBeenCalledTimes(2);
        expect(ingestMock).toHaveBeenCalledWith('user-2', expect.any(Array));
        expect(result.errors).toBe(1);
        expect(result.pulled).toBe(1);
    });

    it('skips disabled user rows, scope-disabled users and unloaded plugins', async () => {
        const plugin = addSource('linear-connector');
        const cold = addSource('cold-connector', 'registered');
        userRows['linear-connector'] = [
            { userId: 'user-off', enabled: false },
            { userId: 'user-scope-off', enabled: true },
        ];
        (registry.isPluginEnabledForScope as jest.Mock).mockResolvedValue(false);

        const result = await makeService().pullSources();

        expect(plugin.pullEvents).not.toHaveBeenCalled();
        expect(cold.pullEvents).not.toHaveBeenCalled();
        expect(result.sources).toBe(1); // the unloaded plugin is not even visited
        expect(result.pulled).toBe(0);
    });

    it('honors the per-tick page budget and persists the continuation cursor with the OLD watermark', async () => {
        const plugin = addSource('linear-connector');
        plugin.pullEvents!.mockResolvedValue({ events: [], nextCursor: 'more' });
        userRows['linear-connector'] = [{ userId: 'user-1', enabled: true }];
        cursorRows.set(cursorKey('user-1', 'linear-connector'), {
            cursor: null,
            watermark: new Date('2026-07-20T00:00:00.000Z'),
            sweepStartedAt: null,
        });

        const result = await makeService().pullSources(3);

        expect(plugin.pullEvents).toHaveBeenCalledTimes(3);
        expect(result.pages).toBe(3);
        const saved = cursorSaveMock.mock.calls[0][0];
        expect(saved.cursor).toBe('more');
        expect(saved.watermark.toISOString()).toBe('2026-07-20T00:00:00.000Z');
        expect(saved.sweepStartedAt).toBeInstanceOf(Date);
    });

    it('materializes lazy plugin proxies before pulling and tolerates a source without pullEvents', async () => {
        const real = {
            id: 'lazy-connector',
            capabilities: ['event-source'],
            pullEvents: jest.fn().mockResolvedValue({ events: [] }),
        };
        const lazy = {
            id: 'lazy-connector',
            capabilities: ['event-source'],
            __materialize: jest.fn().mockResolvedValue(real),
        };
        registered.push({ plugin: lazy as unknown as FakePlugin, state: 'loaded' });
        const empty = addSource('no-pull-connector');
        delete empty.pullEvents;
        userRows['lazy-connector'] = [{ userId: 'user-1', enabled: true }];
        userRows['no-pull-connector'] = [{ userId: 'user-1', enabled: true }];

        const result = await makeService().pullSources();

        expect(lazy.__materialize).toHaveBeenCalledTimes(1);
        expect(real.pullEvents).toHaveBeenCalledTimes(1);
        expect(result.pulled).toBe(1);
        expect(result.errors).toBe(0);
    });

    /**
     * `backfill()` capability method (audit item (l)) — the out-of-band
     * historical sibling of `pullSources()`.
     */
    describe('backfillSource', () => {
        const WINDOW = { since: '2026-06-01T00:00:00.000Z', until: '2026-07-01T00:00:00.000Z' };

        function addBackfillSource(id: string): FakePlugin & { backfill: jest.Mock } {
            const plugin = addSource(id) as FakePlugin & { backfill: jest.Mock };
            plugin.backfill = jest.fn().mockResolvedValue({ events: [], complete: true });
            return plugin;
        }

        it('reports `supported: false` for a connector that does not implement the optional method', async () => {
            addSource('linear-connector'); // pullEvents only

            const result = await makeService().backfillSource('user-1', 'linear-connector', WINDOW);

            expect(result.supported).toBe(false);
            expect(result.pages).toBe(0);
            expect(ingestMock).not.toHaveBeenCalled();
        });

        it('passes the window + resolved settings through and ingests the returned envelopes', async () => {
            const plugin = addBackfillSource('zoom-connector');
            plugin.backfill.mockResolvedValue({
                events: [makeEnvelope('zoom-connector', 'old-1')],
                complete: true,
            });

            const result = await makeService().backfillSource('user-1', 'zoom-connector', WINDOW);

            expect(plugin.backfill).toHaveBeenCalledWith({
                since: WINDOW.since,
                until: WINDOW.until,
                settings: { apiKey: 'secret-key' },
            });
            expect(ingestMock).toHaveBeenCalledWith('user-1', [
                makeEnvelope('zoom-connector', 'old-1'),
            ]);
            expect(result).toMatchObject({
                supported: true,
                pages: 1,
                inserted: 1,
                complete: true,
            });
            expect(result.nextCursor).toBeUndefined();
        });

        it('pages through the window and stops at the budget, returning a resume cursor', async () => {
            const plugin = addBackfillSource('zoom-connector');
            plugin.backfill.mockResolvedValue({ events: [], nextCursor: 'more' });

            const result = await makeService().backfillSource('user-1', 'zoom-connector', {
                ...WINDOW,
                pageBudget: 3,
            });

            expect(plugin.backfill).toHaveBeenCalledTimes(3);
            expect(result.pages).toBe(3);
            expect(result.complete).toBe(false);
            expect(result.nextCursor).toBe('more');
            // The resume cursor is fed back on every subsequent page.
            expect(plugin.backfill.mock.calls[1][0]).toMatchObject({ cursor: 'more' });
        });

        it('⭐ never touches the incremental watermark — the cron sweep is left alone', async () => {
            const plugin = addBackfillSource('zoom-connector');
            plugin.backfill.mockResolvedValue({
                events: [makeEnvelope('zoom-connector', 'old-1')],
                complete: true,
            });

            await makeService().backfillSource('user-1', 'zoom-connector', WINDOW);

            // Advancing the watermark from a HISTORICAL sweep would skip
            // everything between the backfill window and now.
            expect(cursorSaveMock).not.toHaveBeenCalled();
            expect(cursorRepository.findByUserAndPlugin).not.toHaveBeenCalled();
        });

        it('refuses to backfill a plugin the user has not enabled', async () => {
            addBackfillSource('zoom-connector');
            (registry.isPluginEnabledForScope as unknown as jest.Mock).mockResolvedValue(false);

            const result = await makeService().backfillSource('user-1', 'zoom-connector', WINDOW);

            expect(result.supported).toBe(false);
            expect(ingestMock).not.toHaveBeenCalled();
        });

        it('materializes a lazy proxy BEFORE feature-detecting backfill', async () => {
            const real = {
                id: 'lazy-connector',
                capabilities: ['event-source'],
                pullEvents: jest.fn(),
                backfill: jest.fn().mockResolvedValue({ events: [], complete: true }),
            };
            const lazy = {
                id: 'lazy-connector',
                capabilities: ['event-source'],
                __materialize: jest.fn().mockResolvedValue(real),
            };
            registered.push({ plugin: lazy as unknown as FakePlugin, state: 'loaded' });

            const result = await makeService().backfillSource('user-1', 'lazy-connector', WINDOW);

            expect(lazy.__materialize).toHaveBeenCalledTimes(1);
            expect(real.backfill).toHaveBeenCalledTimes(1);
            expect(result.supported).toBe(true);
        });

        it('degrades to an unsupported no-op when the plugin system is not wired', async () => {
            const service = new EventSourcePullService(eventIngestService, cursorRepository);
            const result = await service.backfillSource('user-1', 'zoom-connector', WINDOW);
            expect(result).toMatchObject({ supported: false, pages: 0, complete: false });
        });
    });
});
