import type { SignedStatsReport } from '@ever-works/contracts';
import type { PluginRegistryService } from '../../plugins/services/plugin-registry.service';
import { StatsSinkFacadeService, StatsSinkUnavailableError } from '../stats-sink.facade';

/**
 * The `stats-sink` facade resolves the ONE provider it is told to use, and
 * refuses — without any request — an unknown id, a plugin without the
 * capability, a plugin that failed to load and one that claims the
 * capability without implementing `send`. A provider that throws is a
 * `failed` send, with nothing of its error carried over.
 */
const REPORT: SignedStatsReport = {
    body: new Uint8Array([123, 125]),
    headers: { 'Ever-Stats-Key': 'k', 'Ever-Stats-Signature': 'ed25519=s' },
    reportId: '63d8c277-7fa0-4f5d-a5a7-c88fc94e6186',
    period: '2026-10',
    final: false,
};
const OPTIONS = { baseUrl: 'https://stats.example.com', timeoutMs: 1_000, userAgent: 'test' };

function registryWith(entries: Record<string, unknown>): PluginRegistryService {
    return { get: (id: string) => entries[id] } as unknown as PluginRegistryService;
}

describe('StatsSinkFacadeService', () => {
    const send = jest.fn(async () => ({
        status: 'sent' as const,
        httpStatus: 202,
        errorCode: null,
    }));
    const sink = { id: 'ever-stats-sink', capabilities: ['stats-sink'], send };
    const entry = (plugin: unknown, overrides: Record<string, unknown> = {}) => ({
        plugin,
        manifest: { id: 'ever-stats-sink', capabilities: ['stats-sink'] },
        state: 'loaded',
        ...overrides,
    });

    beforeEach(() => send.mockClear());

    it('hands the report to the named provider', async () => {
        const facade = new StatsSinkFacadeService(registryWith({ 'ever-stats-sink': entry(sink) }));
        expect(facade.isAvailable('ever-stats-sink')).toBe(true);
        expect(await facade.send('ever-stats-sink', REPORT, OPTIONS)).toEqual({
            status: 'sent',
            httpStatus: 202,
            errorCode: null,
        });
        expect(send).toHaveBeenCalledWith(REPORT, OPTIONS);
    });

    it.each([
        ['an unknown provider id', {}, 'not_registered'],
        [
            'a plugin without the capability',
            {
                'ever-stats-sink': entry(sink, {
                    manifest: { id: 'ever-stats-sink', capabilities: ['search'] },
                }),
            },
            'missing_capability',
        ],
        [
            'a plugin that failed to load',
            { 'ever-stats-sink': entry(sink, { state: 'error' }) },
            'load_failed',
        ],
        [
            'a plugin that only claims the capability',
            { 'ever-stats-sink': entry({ id: 'ever-stats-sink', capabilities: ['stats-sink'] }) },
            'not_a_stats_sink',
        ],
    ])('refuses %s without sending', async (_label, entries, reason) => {
        const facade = new StatsSinkFacadeService(registryWith(entries));
        await expect(facade.send('ever-stats-sink', REPORT, OPTIONS)).rejects.toEqual(
            expect.objectContaining({ name: 'StatsSinkUnavailableError', reason }),
        );
        await expect(facade.send('ever-stats-sink', REPORT, OPTIONS)).rejects.toBeInstanceOf(
            StatsSinkUnavailableError,
        );
        expect(send).not.toHaveBeenCalled();
    });

    it('reports a provider that throws as failed, carrying nothing of its error', async () => {
        const throwing = {
            ...sink,
            send: async () => {
                throw new Error('connect ECONNREFUSED 203.0.113.9:443 secret-token');
            },
        };
        const facade = new StatsSinkFacadeService(
            registryWith({ 'ever-stats-sink': entry(throwing) }),
        );
        expect(await facade.send('ever-stats-sink', REPORT, OPTIONS)).toEqual({
            status: 'failed',
            httpStatus: null,
            errorCode: 'network',
        });
    });

    it('does nothing when constructed', () => {
        const get = jest.fn();
        new StatsSinkFacadeService({ get } as unknown as PluginRegistryService);
        expect(get).not.toHaveBeenCalled();
    });
});
