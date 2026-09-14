import type { PlaybookCatalogEntry } from '@ever-works/contracts';
import type { PluginRegistryService } from '../../plugins/services/plugin-registry.service';
import type { AgentRepository } from '../../database/repositories/agent.repository';
import {
    PlaybookReadinessService,
    type PlaybookAdoptionCounts,
} from '../playbook-readiness.service';

function playbook(extra: Partial<PlaybookCatalogEntry> = {}): PlaybookCatalogEntry {
    return {
        slug: 'market-watch-brief',
        title: 'Market watch brief',
        outcome: 'Outcome.',
        summary: 'Summary.',
        category: 'research',
        version: '1.0.0',
        icon: 'telescope',
        trigger: { kind: 'manual', description: 'On demand' },
        steps: [
            { position: 1, title: 'Read', produces: 'Changes.', requiresApproval: false },
            { position: 2, title: 'Raise', produces: 'Decisions.', requiresApproval: true },
        ],
        connections: [
            { capability: 'search', required: true, reason: 'Find changes.' },
            {
                capability: 'content-extractor',
                required: false,
                reason: 'Read pages.',
                degradedWithout: 'Links only.',
            },
        ],
        artefacts: [],
        escalations: [],
        caps: {},
        costBand: 'medium',
        estimatedTokensPerRun: { min: 1, max: 2 },
        tags: [],
        provision: {
            agentTemplateSlug: 'competitive-analyst',
            agentName: 'Market watcher',
            skillSlugs: [],
            taskTemplate: { name: 'Market watch', slug: 'market-watch' },
            guardrailsAtAdoption: { mode: 'require_approval' },
        },
        ...extra,
    };
}

function registryProviding(
    byCapability: Record<string, Array<{ id: string; name: string; isDefault?: boolean }>>,
) {
    return {
        getEnabledPluginsScoped: jest.fn(async (capability: string) =>
            (byCapability[capability] ?? []).map((p) => ({
                plugin: { id: p.id, name: p.name },
                manifest: {
                    name: p.name,
                    defaultForCapabilities: p.isDefault ? [capability] : undefined,
                },
            })),
        ),
    } as unknown as PluginRegistryService & { getEnabledPluginsScoped: jest.Mock };
}

function agentsNamed(...names: string[]) {
    return {
        findByUserIdScoped: jest.fn(async () => ({
            rows: names.map((name) => ({ name })),
            total: names.length,
        })),
    } as unknown as AgentRepository & { findByUserIdScoped: jest.Mock };
}

function counts(running: number, copies: number): PlaybookAdoptionCounts {
    return {
        countRunning: jest.fn().mockResolvedValue(running),
        countCopies: jest.fn().mockResolvedValue(copies),
    };
}

const scope = { userId: 'user-1' };

describe('PlaybookReadinessService', () => {
    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    it('reads needs_connection and names every missing required capability', async () => {
        const service = new PlaybookReadinessService(registryProviding({}));
        const readiness = await service.getReadiness(playbook(), scope);
        expect(readiness.state).toBe('needs_connection');
        expect(readiness.missingRequired).toEqual(['search']);
        expect(readiness.connections.map((c) => c.satisfiedBy)).toEqual([null, null]);
        expect(readiness.unknown).toEqual([]);
    });

    it('reads ready when every required capability has an enabled provider, and reports it as data', async () => {
        const service = new PlaybookReadinessService(
            registryProviding({
                search: [
                    { id: 'first-search', name: 'First search' },
                    { id: 'default-search', name: 'Default search', isDefault: true },
                ],
            }),
        );
        const readiness = await service.getReadiness(playbook(), scope);
        expect(readiness.state).toBe('ready');
        expect(readiness.missingRequired).toEqual([]);
        expect(readiness.connections[0].satisfiedBy).toEqual({
            pluginId: 'default-search',
            name: 'Default search',
        });
        // An optional connection that nothing provides never blocks readiness.
        expect(readiness.connections[1].satisfiedBy).toBeNull();
    });

    it('reads ready for a playbook that needs no connections at all', async () => {
        const registry = registryProviding({});
        const service = new PlaybookReadinessService(registry);
        const readiness = await service.getReadiness(playbook({ connections: [] }), scope);
        expect(readiness.state).toBe('ready');
        expect(registry.getEnabledPluginsScoped).not.toHaveBeenCalled();
    });

    it('passes the caller scope to the registry', async () => {
        const registry = registryProviding({});
        const service = new PlaybookReadinessService(registry);
        await service.getReadiness(playbook(), { userId: 'u-9', workId: 'w-1' });
        expect(registry.getEnabledPluginsScoped).toHaveBeenCalledWith('search', 'w-1', 'u-9');
    });

    describe('limits', () => {
        const ready = () => registryProviding({ search: [{ id: 's', name: 'S' }] });

        it('reads 0 adoptions when no counter is bound', async () => {
            const readiness = await new PlaybookReadinessService(ready()).getReadiness(
                playbook(),
                scope,
            );
            expect(readiness.blockers).toEqual([]);
            expect(readiness.state).toBe('ready');
        });

        it('is not blocked at 24 running adoptions, and is blocked at exactly 25', async () => {
            const below = await new PlaybookReadinessService(
                ready(),
                undefined,
                counts(24, 0),
            ).getReadiness(playbook(), scope);
            expect(below.state).toBe('ready');

            const at = await new PlaybookReadinessService(
                ready(),
                undefined,
                counts(25, 0),
            ).getReadiness(playbook(), scope);
            expect(at.state).toBe('blocked');
            expect(at.blockers).toEqual([
                { code: 'adoption_ceiling', currentCount: 25, limit: 25 },
            ]);
        });

        it('reads adopted at 2 copies, and blocked at exactly 3', async () => {
            const two = await new PlaybookReadinessService(
                ready(),
                undefined,
                counts(2, 2),
            ).getReadiness(playbook(), scope);
            expect(two.state).toBe('adopted');
            expect(two.blockers).toEqual([]);

            const three = await new PlaybookReadinessService(
                ready(),
                undefined,
                counts(3, 3),
            ).getReadiness(playbook(), scope);
            expect(three.state).toBe('blocked');
            expect(three.blockers).toEqual([{ code: 'copy_limit', currentCount: 3, limit: 3 }]);
        });

        it('reports a missing connection ahead of a limit', async () => {
            const readiness = await new PlaybookReadinessService(
                registryProviding({}),
                undefined,
                counts(25, 3),
            ).getReadiness(playbook(), scope);
            expect(readiness.state).toBe('needs_connection');
            expect(readiness.blockers.map((b) => b.code)).toEqual([
                'adoption_ceiling',
                'copy_limit',
            ]);
        });
    });

    describe('agent name collision', () => {
        it('is not checked unless asked for', async () => {
            const agents = agentsNamed('Market watcher');
            const readiness = await new PlaybookReadinessService(
                registryProviding({}),
                agents,
            ).getReadiness(playbook({ connections: [] }), scope);
            expect(readiness.collisions).toEqual([]);
            expect(agents.findByUserIdScoped).not.toHaveBeenCalled();
        });

        it('suggests the first free numbered name, case-insensitively', async () => {
            const agents = agentsNamed('market watcher', 'Market watcher 2', 'Other');
            const readiness = await new PlaybookReadinessService(
                registryProviding({}),
                agents,
            ).getReadiness(playbook({ connections: [] }), scope, { checkNameCollision: true });
            expect(readiness.collisions).toEqual([
                { type: 'agent_name', requested: 'Market watcher', suggested: 'Market watcher 3' },
            ]);
            expect(agents.findByUserIdScoped).toHaveBeenCalledWith('user-1', {
                search: 'Market watcher',
                limit: 200,
            });
        });

        it('reports nothing when only a similar name exists', async () => {
            const readiness = await new PlaybookReadinessService(
                registryProviding({}),
                agentsNamed('Market watcher 2'),
            ).getReadiness(playbook({ connections: [] }), scope, { checkNameCollision: true });
            expect(readiness.collisions).toEqual([]);
        });

        it('checks the name the caller asked for', async () => {
            const readiness = await new PlaybookReadinessService(
                registryProviding({}),
                agentsNamed('Scout'),
            ).getReadiness(playbook({ connections: [] }), scope, {
                checkNameCollision: true,
                agentName: 'Scout',
            });
            expect(readiness.collisions[0]?.suggested).toBe('Scout 2');
        });
    });

    describe('caching', () => {
        it('serves a cached answer for up to 60 s, then re-reads plugin state', async () => {
            let now = 1_000_000;
            jest.spyOn(Date, 'now').mockImplementation(() => now);
            const providers: Record<string, Array<{ id: string; name: string }>> = {};
            const registry = registryProviding(providers);
            const service = new PlaybookReadinessService(registry);

            expect((await service.getReadiness(playbook(), scope)).state).toBe('needs_connection');
            providers.search = [{ id: 's', name: 'S' }];

            now += 59_999;
            expect((await service.getReadiness(playbook(), scope)).state).toBe('needs_connection');

            now += 2;
            expect((await service.getReadiness(playbook(), scope)).state).toBe('ready');
        });

        it('keeps scopes apart', async () => {
            const registry = registryProviding({});
            const service = new PlaybookReadinessService(registry);
            await service.getReadiness(playbook(), { userId: 'a' });
            await service.getReadiness(playbook(), { userId: 'b' });
            // Two connections per read, two scopes.
            expect(registry.getEnabledPluginsScoped).toHaveBeenCalledTimes(4);
        });

        it('resolves a capability shared by many concurrent playbooks with one registry read', async () => {
            const registry = registryProviding({ search: [{ id: 's', name: 'S' }] });
            const service = new PlaybookReadinessService(registry);
            const entries = Array.from({ length: 51 }, (_, index) =>
                playbook({ slug: `playbook-${index}` }),
            );

            const answers = await Promise.all(
                entries.map((entry) => service.getReadiness(entry, scope)),
            );

            expect(answers.every((answer) => answer.state === 'ready')).toBe(true);
            // One read per distinct capability (search, content-extractor), not per playbook.
            expect(registry.getEnabledPluginsScoped).toHaveBeenCalledTimes(2);
        });

        it('never lets a lookup that started before clear() repopulate the cache', async () => {
            let release!: () => void;
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            const providers: Record<string, Array<{ id: string; name: string }>> = {};
            const base = registryProviding(providers);
            const registry = {
                getEnabledPluginsScoped: jest.fn(async (...args: unknown[]) => {
                    // Snapshot plugin state when the read starts, answer later.
                    const answer = await (base.getEnabledPluginsScoped as jest.Mock)(...args);
                    await gate;
                    return answer;
                }),
            } as unknown as PluginRegistryService & { getEnabledPluginsScoped: jest.Mock };
            const service = new PlaybookReadinessService(registry);
            const entry = playbook({ connections: [playbook().connections[0]] });

            const stale = service.getReadiness(entry, scope);
            service.clear();
            providers.search = [{ id: 's', name: 'S' }];
            release();
            expect((await stale).state).toBe('needs_connection');

            // The stale answer was not kept: the next read sees the enabled plugin.
            expect((await service.getReadiness(entry, scope)).state).toBe('ready');
            expect(registry.getEnabledPluginsScoped).toHaveBeenCalledTimes(2);
        });

        it('forgets everything on clear()', async () => {
            const registry = registryProviding({});
            const service = new PlaybookReadinessService(registry);
            await service.getReadiness(playbook(), scope);
            service.clear();
            await service.getReadiness(playbook(), scope);
            expect(registry.getEnabledPluginsScoped).toHaveBeenCalledTimes(4);
        });
    });

    describe('the 2 s budget', () => {
        it('returns a partial answer marking a slow check unknown, and does not cache it', async () => {
            jest.useFakeTimers();
            const registry = {
                getEnabledPluginsScoped: jest.fn(() => new Promise(() => undefined)),
            } as unknown as PluginRegistryService & { getEnabledPluginsScoped: jest.Mock };
            const service = new PlaybookReadinessService(
                registry,
                agentsNamed('Market watcher'),
                counts(1, 1),
            );

            const pending = service.getReadiness(playbook(), scope, { checkNameCollision: true });
            await jest.advanceTimersByTimeAsync(2_000);
            const readiness = await pending;

            expect(readiness.unknown).toEqual(['connections']);
            expect(readiness.state).toBe('needs_connection');
            expect(readiness.connections.every((c) => c.satisfiedBy === null)).toBe(true);
            expect(readiness.collisions).toHaveLength(1);

            const again = service.getReadiness(playbook(), scope, { checkNameCollision: true });
            await jest.advanceTimersByTimeAsync(2_000);
            await again;
            expect(registry.getEnabledPluginsScoped.mock.calls.length).toBeGreaterThan(1);
            // A hung lookup is not shared past the budget: the retry asked the
            // registry again for both capabilities.
            expect(registry.getEnabledPluginsScoped).toHaveBeenCalledTimes(4);
        });

        it('treats a failing check as unknown rather than throwing', async () => {
            const failingCounts: PlaybookAdoptionCounts = {
                countRunning: jest.fn().mockRejectedValue(new Error('db down')),
                countCopies: jest.fn().mockResolvedValue(0),
            };
            const readiness = await new PlaybookReadinessService(
                registryProviding({}),
                undefined,
                failingCounts,
            ).getReadiness(playbook({ connections: [] }), scope);
            expect(readiness.unknown).toEqual(['adoptions']);
            expect(readiness.state).toBe('ready');
        });
    });
});
